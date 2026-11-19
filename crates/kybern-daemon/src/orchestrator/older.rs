//! Older threads and unarchive.
//!
//! A top-level thread with no turn for the `older_after` setting's time moves to its project's Older group
//! (`threads.older_at`). It is only a place in the list: nothing is archived, stopped or removed, and its worktree is
//! left alone. Pinned, busy, waiting and opted-out threads never move; a new turn, "Move out of Older" and unarchive
//! take a thread back out. [`plan`] is the pure rule; the background sweep applies it at most every
//! [`SWEEP_EVERY`], or at once after the setting changed. Whether a thread is unread is the client's to know: clients
//! keep an unread thread out of the Older group until it is read (`packages/kybern-client/src/older.ts`).

use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow};
use chrono::{DateTime, Utc};
use kybern_protocol::{EventPayload, OlderAfter, Thread, ThreadId, ThreadStatus};
use kybern_store::OlderRow;

use super::{Orchestrator, inbound, subagents};

/// How often the sweep re-reads every thread. Inactivity is counted in days, so this only bounds how late a move is.
pub(super) const SWEEP_EVERY: Duration = Duration::from_secs(10 * 60);

/// When the Older sweep last ran, and with which setting.
#[derive(Default)]
pub(super) struct OlderSweeps(Mutex<Option<(Instant, OlderAfter)>>);

impl OlderSweeps {
    /// Whether a sweep is due now: never ran, the setting changed, or [`SWEEP_EVERY`] passed. Records this run.
    fn due(&self, setting: OlderAfter, now: Instant) -> bool {
        let mut last = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let due = last.is_none_or(|(at, previous)| previous != setting || now.duration_since(at) >= SWEEP_EVERY);
        if due {
            *last = Some((now, setting));
        }
        due
    }
}

/// Whether a thread belongs in Older under `after`.
fn belongs_in_older(row: &OlderRow, after: Option<chrono::Duration>, now: DateTime<Utc>) -> bool {
    let Some(after) = after else { return false };
    !row.pinned
        && !row.keep_out_of_older
        && !row.waiting
        && matches!(row.status, ThreadStatus::Idle | ThreadStatus::Failed)
        && now.signed_duration_since(row.active_at) >= after
}

/// The moves one sweep makes: each thread whose place changes, with its new `older_at` (`None`: out of Older).
/// A thread already in Older keeps the time it moved.
pub(super) fn plan(rows: &[OlderRow], after: Option<chrono::Duration>, now: DateTime<Utc>) -> Vec<(ThreadId, Option<DateTime<Utc>>)> {
    rows.iter()
        .filter_map(|row| match (belongs_in_older(row, after, now), row.older_at.is_some()) {
            (true, false) => Some((row.thread_id, Some(now))),
            (false, true) => Some((row.thread_id, None)),
            _ => None,
        })
        .collect()
}

impl Orchestrator {
    /// One pass of the Older rule, when one is due. Returns how many threads moved.
    pub async fn sweep_older(&self) -> Result<usize> {
        let setting = self.inner.settings.get().older_after;
        if !self.inner.older_sweeps.due(setting, Instant::now()) {
            return Ok(0);
        }
        self.apply_older(setting.duration(), Utc::now())
    }

    /// Apply [`plan`] to every candidate thread as of `now`.
    pub(super) fn apply_older(&self, after: Option<chrono::Duration>, now: DateTime<Utc>) -> Result<usize> {
        let moves = plan(&self.inner.store.older_candidates()?, after, now);
        for (thread_id, older_at) in &moves {
            if let Err(error) = self.publish_older(*thread_id, |store| store.thread_set_older(*thread_id, *older_at).map(drop)) {
                tracing::warn!(%thread_id, %error, "could not move a thread to or from Older");
            }
        }
        if !moves.is_empty() {
            tracing::debug!(count = moves.len(), "moved threads to or from Older");
        }
        Ok(moves.len())
    }

    /// Change a thread's Older columns with `write` and publish the row. Its place in the list says when it last
    /// changed (`updated_at`), so a move that the person did not ask for keeps that time.
    fn publish_older(&self, thread_id: ThreadId, write: impl FnOnce(&kybern_store::Store) -> Result<()>) -> Result<Thread> {
        let _updates = self.inner.thread_updates.lock().map_err(|_| anyhow!("thread update lock poisoned"))?;
        write(&self.inner.store)?;
        let mut thread = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("Thread not found."))?;
        let event = self.emit(thread.id, None, EventPayload::ThreadUpdated { thread: thread.clone() })?;
        thread.last_seq = event.seq;
        self.inner.store.thread_upsert(&thread)?;
        Ok(thread)
    }

    /// A turn is starting: the thread leaves Older. The caller then writes the thread, which publishes it.
    pub(super) fn older_turn_started(&self, thread: &mut Thread) -> Result<()> {
        if thread.older_at.take().is_some() {
            self.inner.store.thread_set_older(thread.id, None)?;
        }
        Ok(())
    }

    /// "Never move to Older" and "Move out of Older" (`threads.update`). The caller then writes the thread, which
    /// publishes it and brings it to the top of its list.
    pub(super) fn update_older_fields(&self, thread: &Thread, keep_out: Option<bool>, move_out: bool) -> Result<()> {
        if let Some(keep) = keep_out {
            self.inner.store.thread_set_keep_out_of_older(thread.id, keep)?;
        }
        if move_out && thread.older_at.is_some() {
            self.inner.store.thread_restart_older_clock(thread.id, Utc::now())?;
        }
        Ok(())
    }

    /// `threads.unarchive`: the thread is idle again, at the top of its project's list, out of Older with its
    /// inactivity clock restarted. A worktree that cleanup removed comes back with the next message
    /// (`restore_worktree_if_cleaned`). Delegated agents and subagent threads it had stay archived.
    pub fn unarchive_thread(&self, thread_id: ThreadId) -> Result<Thread> {
        let current = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("Thread not found."))?;
        if current.subagent.is_some() {
            return Err(anyhow!(subagents::READ_ONLY_ERROR));
        }
        if current.inbound.is_some() {
            return Err(anyhow!(inbound::INBOUND_READ_ONLY));
        }
        if current.status != ThreadStatus::Archived {
            return Ok(current);
        }
        let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
        self.inner.store.thread_unarchive(thread_id, Utc::now())?;
        self.update_thread(self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("Thread not found."))?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn row(days_idle: i64, now: DateTime<Utc>) -> OlderRow {
        OlderRow {
            thread_id: Uuid::now_v7(),
            pinned: false,
            status: ThreadStatus::Idle,
            keep_out_of_older: false,
            older_at: None,
            active_at: now - chrono::Duration::days(days_idle),
            waiting: false,
        }
    }

    const WEEK: Option<chrono::Duration> = Some(chrono::Duration::days(7));

    #[test]
    fn a_thread_moves_once_it_has_had_no_turn_for_the_whole_period() {
        let now = Utc::now();
        let mut almost = row(7, now);
        almost.active_at += chrono::Duration::seconds(1);
        let exactly = row(7, now);
        let long = row(40, now);
        let moves = plan(&[almost.clone(), exactly.clone(), long.clone()], WEEK, now);
        assert_eq!(moves, vec![(exactly.thread_id, Some(now)), (long.thread_id, Some(now))], "a second short of 7 days stays");
        assert!(plan(std::slice::from_ref(&long), None, now).is_empty(), "Never moves nothing");
        assert_eq!(plan(std::slice::from_ref(&long), Some(chrono::Duration::days(30)), now).len(), 1);
        assert!(plan(&[row(29, now)], Some(chrono::Duration::days(30)), now).is_empty());
        assert_eq!(plan(&[row(3, now)], Some(chrono::Duration::days(3)), now).len(), 1);
    }

    #[test]
    fn pinned_busy_waiting_and_opted_out_threads_never_move() {
        let now = Utc::now();
        let mut pinned = row(30, now);
        pinned.pinned = true;
        let mut kept = row(30, now);
        kept.keep_out_of_older = true;
        let mut waiting = row(30, now);
        waiting.waiting = true;
        let mut running = row(30, now);
        running.status = ThreadStatus::Running;
        let mut asking = row(30, now);
        asking.status = ThreadStatus::AwaitingApproval;
        assert!(plan(&[pinned, kept, waiting, running, asking], WEEK, now).is_empty());
        let mut failed = row(30, now);
        failed.status = ThreadStatus::Failed;
        assert_eq!(plan(&[failed], WEEK, now).len(), 1, "a failed thread is as idle as any");
    }

    #[test]
    fn a_thread_in_older_keeps_its_time_and_leaves_when_it_no_longer_belongs() {
        let now = Utc::now();
        let moved_at = now - chrono::Duration::days(2);
        let mut settled = row(9, now);
        settled.older_at = Some(moved_at);
        assert!(plan(std::slice::from_ref(&settled), WEEK, now).is_empty(), "already there");
        let mut pinned = settled.clone();
        pinned.pinned = true;
        let mut turned = settled.clone();
        turned.active_at = now - chrono::Duration::hours(1);
        assert_eq!(plan(&[pinned.clone(), turned.clone()], WEEK, now), vec![(pinned.thread_id, None), (turned.thread_id, None)]);
        assert_eq!(plan(std::slice::from_ref(&settled), None, now), vec![(settled.thread_id, None)], "turning it off empties Older");
        assert_eq!(plan(std::slice::from_ref(&settled), Some(chrono::Duration::days(30)), now), vec![(settled.thread_id, None)]);
    }

    #[test]
    fn the_sweep_runs_again_after_its_interval_or_a_setting_change() {
        let sweeps = OlderSweeps::default();
        let start = Instant::now();
        assert!(sweeps.due(OlderAfter::SevenDays, start), "the first pass runs");
        assert!(!sweeps.due(OlderAfter::SevenDays, start + Duration::from_secs(30)));
        assert!(sweeps.due(OlderAfter::ThreeDays, start + Duration::from_secs(60)), "a new setting applies at once");
        assert!(!sweeps.due(OlderAfter::ThreeDays, start + Duration::from_secs(90)));
        assert!(sweeps.due(OlderAfter::ThreeDays, start + Duration::from_secs(60) + SWEEP_EVERY));
    }
}
