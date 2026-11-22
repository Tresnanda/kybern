//! The two Antigravity rules, in one place so no path can forget them.
//!
//! Kybern can neither approve nor limit what Antigravity's tools do, so:
//! - a thread on Antigravity is always in Full access, and any other mode is
//!   refused wherever a mode or a provider is set (create, update, send, fork,
//!   move, rotation, delegation, task runs);
//! - Antigravity cannot be a project's Coordinator lead.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{Result, anyhow};
use kybern_protocol::{
    EventPayload, EventSeq, PermissionMode, ProviderKind, StopReason, Thread, ThreadEvent, ThreadId, ThreadStatus, TurnId, Usage,
};
use tokio::sync::{Notify, watch};

use super::{Inner, LiveSession, Orchestrator, delegation};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum RecoveryOutcome {
    Pending,
    Cancelled,
    Started,
}

#[derive(Clone)]
pub(super) struct RecoveryEntry {
    pub(super) turn_id: TurnId,
    pub(super) stopped: Arc<AtomicBool>,
    pub(super) stopped_notify: Arc<Notify>,
    pub(super) aborted: Arc<AtomicBool>,
    pub(super) outcome: watch::Receiver<RecoveryOutcome>,
}

pub(super) struct RecoveryGuard {
    inner: Arc<Inner>,
    thread_id: ThreadId,
    stopped: Arc<AtomicBool>,
    aborted: Arc<AtomicBool>,
    outcome_tx: watch::Sender<RecoveryOutcome>,
    finished: bool,
}

impl RecoveryGuard {
    fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    fn was_aborted(&self) -> bool {
        self.aborted.load(Ordering::SeqCst)
    }

    fn remove_entry(&self) {
        let mut map = self.inner.antigravity_recoveries.lock().unwrap_or_else(|e| e.into_inner());
        if map.get(&self.thread_id).is_some_and(|entry| Arc::ptr_eq(&entry.stopped, &self.stopped)) {
            map.remove(&self.thread_id);
        }
    }

    fn mark_started(&mut self) {
        self.finished = true;
        self.remove_entry();
        let _ = self.outcome_tx.send(RecoveryOutcome::Started);
    }

    fn finish_cancelled(&mut self) {
        self.finished = true;
        self.remove_entry();
        let _ = self.outcome_tx.send(RecoveryOutcome::Cancelled);
    }
}

impl Drop for RecoveryGuard {
    fn drop(&mut self) {
        if !self.finished {
            self.remove_entry();
            let _ = self.outcome_tx.send(RecoveryOutcome::Cancelled);
        }
    }
}

pub(super) fn is_signature_failure(error: &str, problem: Option<&kybern_protocol::rpc::Problem>) -> bool {
    problem.and_then(|problem| problem.detail.as_deref()).is_some_and(kybern_drivers::antigravity::is_invalid_thinking_signature)
        || kybern_drivers::antigravity::is_invalid_thinking_signature(error)
}

/// Refuses any mode but Full access for an Antigravity thread.
pub(crate) fn require_full_access(kind: ProviderKind, mode: PermissionMode) -> Result<()> {
    if kind == ProviderKind::Antigravity {
        kybern_drivers::antigravity::require_full_access(mode).map_err(|sentence| anyhow!(sentence))?;
    }
    Ok(())
}

/// Refuses Antigravity as the harness of a project's Coordinator.
pub(crate) fn refuse_lead(kind: ProviderKind) -> Result<()> {
    if kind == ProviderKind::Antigravity {
        return Err(anyhow!(kybern_drivers::antigravity::NO_LEAD));
    }
    Ok(())
}

/// The sequence number right before `turn_id` began, so a portable handoff carries
/// earlier turns without duplicating `turn_id`'s own prompt.
pub(super) fn seq_before_turn(events: &[ThreadEvent], turn_id: TurnId) -> EventSeq {
    events
        .iter()
        .find(|event| event.turn_id == Some(turn_id))
        .map(|event| event.seq.saturating_sub(1))
        .unwrap_or_else(|| events.last().map_or(0, |event| event.seq))
}

/// Events through `through` with any turns undone by a `WorkspaceReverted`
/// (including one recorded after `through`) removed, so portable handoffs keep
/// only live turns.
pub(super) fn events_without_reverted(events: &[ThreadEvent], through: EventSeq) -> Vec<ThreadEvent> {
    if !events.iter().any(|event| matches!(event.payload, EventPayload::WorkspaceReverted { .. })) {
        return events.iter().filter(|event| event.seq <= through).cloned().collect();
    }
    let mut kept: Vec<ThreadEvent> = Vec::with_capacity(events.len());
    for event in events {
        if let EventPayload::WorkspaceReverted { to_turn_id, .. } = &event.payload {
            if let Some(pos) = kept.iter().position(|entry| entry.turn_id == Some(*to_turn_id)) {
                kept.truncate(pos);
            }
            continue;
        }
        if event.seq <= through {
            kept.push(event.clone());
        }
    }
    kept
}

impl Orchestrator {
    pub(super) fn begin_antigravity_recovery(&self, thread_id: ThreadId, turn_id: TurnId) -> RecoveryGuard {
        let stopped = Arc::new(AtomicBool::new(false));
        let stopped_notify = Arc::new(Notify::new());
        let aborted = Arc::new(AtomicBool::new(false));
        let (outcome_tx, outcome) = watch::channel(RecoveryOutcome::Pending);
        self.inner
            .antigravity_recoveries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(thread_id, RecoveryEntry { turn_id, stopped: stopped.clone(), stopped_notify, aborted: aborted.clone(), outcome });
        RecoveryGuard { inner: self.inner.clone(), thread_id, stopped, aborted, outcome_tx, finished: false }
    }

    pub(super) async fn cancel_antigravity_recovery(&self, thread_id: ThreadId, grace: Duration) -> Option<RecoveryOutcome> {
        let mut outcome = {
            let map = self.inner.antigravity_recoveries.lock().unwrap_or_else(|e| e.into_inner());
            let entry = map.get(&thread_id)?;
            entry.stopped.store(true, Ordering::SeqCst);
            entry.stopped_notify.notify_waiters();
            entry.outcome.clone()
        };
        let _ = tokio::time::timeout(grace, outcome.wait_for(|state| *state != RecoveryOutcome::Pending)).await;
        Some(*outcome.borrow())
    }

    pub(super) fn antigravity_recovery_stopped(&self, thread_id: ThreadId, turn_id: TurnId) -> bool {
        let map = self.inner.antigravity_recoveries.lock().unwrap_or_else(|e| e.into_inner());
        map.get(&thread_id).is_some_and(|entry| entry.turn_id == turn_id && entry.stopped.load(Ordering::SeqCst))
    }

    pub(super) fn mark_antigravity_recovery_aborted(&self, thread_id: ThreadId, turn_id: TurnId) {
        let map = self.inner.antigravity_recoveries.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get(&thread_id).filter(|entry| entry.turn_id == turn_id) {
            entry.aborted.store(true, Ordering::SeqCst);
        }
    }

    /// Record a portable handoff covering every live event before `to_turn_id`.
    pub(super) fn set_rewind_handoff(&self, thread_id: ThreadId, to_turn_id: TurnId) -> Result<()> {
        let events = self.inner.store.events_for_thread(thread_id)?;
        let through = seq_before_turn(&events, to_turn_id);
        let handoff = if through > 0 { serde_json::to_string(&(0 as EventSeq, through))? } else { String::new() };
        self.inner.store.meta_set(&format!("handoff:{thread_id}"), &handoff)?;
        Ok(())
    }

    /// Antigravity cannot rewind a saved conversation natively. Drop the old
    /// `--conversation` id and schedule a portable handoff of the kept turns
    /// before `to_turn_id`, so the next message starts a fresh conversation
    /// seeded with the kept transcript.
    pub(super) fn prepare_antigravity_rewind(&self, thread: &mut Thread, to_turn_id: TurnId) -> Result<()> {
        thread.provider_session_id = None;
        self.save_account_binding(thread)?;
        self.set_rewind_handoff(thread.id, to_turn_id)
    }

    fn reset_poisoned_antigravity_conversation(&self, thread: &mut Thread, turn_id: TurnId) -> bool {
        thread.provider_session_id = None;
        let _ = self.save_account_binding(thread);
        let _ = self.set_rewind_handoff(thread.id, turn_id);
        self.update_thread(thread.clone()).is_ok()
    }

    async fn remove_antigravity_live_session(&self, thread_id: ThreadId, live: &Arc<LiveSession>) {
        {
            let mut sessions = self.inner.sessions.lock().await;
            if sessions.get(&thread_id).is_some_and(|current| Arc::ptr_eq(current, live)) {
                sessions.remove(&thread_id);
            }
        }
        live.mark_released();
        self.revoke_native_session(live);
    }

    fn settle_interrupted_recovery(&self, thread_id: ThreadId, turn_id: TurnId) {
        let _ = self.emit(
            thread_id,
            Some(turn_id),
            EventPayload::TurnCompleted {
                stop_reason: StopReason::Interrupted,
                usage: Usage::default(),
                cost_usd: None,
                duration_ms: 0,
                terminal_message_id: None,
            },
        );
        if let Ok(Some(mut thread)) = self.inner.store.thread_get(thread_id) {
            thread.status = ThreadStatus::Idle;
            let _ = self.update_thread(thread);
        }
        self.delegation_turn_finished(
            thread_id,
            turn_id,
            delegation::TurnOutcome::Completed { stop_reason: StopReason::Interrupted, terminal_message_id: None },
        );
    }

    /// When Antigravity fails with Claude's lost or invalid thinking-signature
    /// error, every retry against the same `--conversation` fails the same way.
    /// Drop the poisoned conversation id, carry the thread's prior turns via
    /// the portable handoff path, and retry the turn once on a fresh conversation.
    /// Caller must drop `live.turn` before calling so `sessions` is never locked
    /// while holding `live.turn`.
    pub(super) async fn recover_antigravity_thinking_signature(
        &self,
        thread_id: ThreadId,
        live: &Arc<LiveSession>,
        turn_id: TurnId,
        retiring: bool,
        mut guard: RecoveryGuard,
    ) -> bool {
        let Ok(Some(mut thread)) = self.inner.store.thread_get(thread_id) else { return false };
        if thread.provider.kind != ProviderKind::Antigravity {
            return false;
        }
        let recovery_key = format!("agy_sig_recovery:{turn_id}");
        let can_retry = !retiring
            && !live.is_released()
            && thread.provider_session_id.is_some()
            && self.inner.store.meta_get(&recovery_key).ok().flatten().is_none();
        let started_message = if can_retry { self.inner.store.turn_started_message(thread_id, turn_id).ok().flatten() } else { None };
        let Some((message_id, mut message)) = started_message else {
            // The driver dropped `state.conversation` on this error. Even when we decline an
            // automatic retry (second failure on this turn or released session), clear
            // `provider_session_id` and write the portable handoff so the next user message
            // keeps the thread's context instead of starting blank.
            self.reset_poisoned_antigravity_conversation(&mut thread, turn_id);
            return false;
        };
        if guard.is_stopped() {
            self.remove_antigravity_live_session(thread_id, live).await;
            self.reset_poisoned_antigravity_conversation(&mut thread, turn_id);
            let live = live.clone();
            tokio::spawn(async move {
                let _ = live.session.close().await;
            });
            self.settle_interrupted_recovery(thread_id, turn_id);
            guard.finish_cancelled();
            return true;
        }
        self.resolve_attachments(&mut message);
        if self.inner.store.meta_set(&recovery_key, "1").is_err() {
            self.reset_poisoned_antigravity_conversation(&mut thread, turn_id);
            return false;
        }
        self.remove_antigravity_live_session(thread_id, live).await;
        if !self.reset_poisoned_antigravity_conversation(&mut thread, turn_id) {
            return false;
        }
        tracing::info!(
            %thread_id,
            %turn_id,
            "Antigravity conversation hit an invalid thinking signature; retrying once on a fresh conversation with thread context"
        );
        let (this, live) = (self.clone(), live.clone());
        tokio::spawn(async move {
            if let Err(error) = live.session.close().await {
                tracing::debug!(%error, %thread_id, "closing a poisoned Antigravity session failed");
            }
            if guard.is_stopped() {
                this.settle_interrupted_recovery(thread_id, turn_id);
                guard.finish_cancelled();
                return;
            }
            let restarted = match this.inner.store.thread_get(thread_id) {
                Ok(Some(thread)) => this.start_turn_erased(thread, turn_id, message_id, message).await.map_err(|error| error.to_string()),
                _ => Err("The thread no longer exists.".to_string()),
            };
            if guard.was_aborted() {
                this.settle_interrupted_recovery(thread_id, turn_id);
                guard.finish_cancelled();
                return;
            }
            match restarted {
                Ok(()) => guard.mark_started(),
                Err(text) => {
                    if guard.is_stopped() {
                        this.settle_interrupted_recovery(thread_id, turn_id);
                        guard.finish_cancelled();
                        return;
                    }
                    let already =
                        this.inner.store.thread_get(thread_id).ok().flatten().is_some_and(|thread| thread.status == ThreadStatus::Failed);
                    if !already {
                        let _ = this.emit(
                            thread_id,
                            Some(turn_id),
                            EventPayload::TurnFailed {
                                error: text.clone(),
                                problem: kybern_drivers::failure::classify(ProviderKind::Antigravity, &text),
                            },
                        );
                        if let Ok(Some(mut thread)) = this.inner.store.thread_get(thread_id) {
                            thread.status = ThreadStatus::Failed;
                            let _ = this.update_thread(thread);
                        }
                        this.delegation_turn_finished(thread_id, turn_id, delegation::TurnOutcome::Failed(text));
                    }
                    guard.finish_cancelled();
                }
            }
        });
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use kybern_protocol::{EventOrigin, MessageId, UserMessage};
    use uuid::Uuid;

    #[test]
    fn only_antigravity_is_held_to_full_access() {
        for mode in PermissionMode::ALL {
            assert!(require_full_access(ProviderKind::ClaudeCode, mode).is_ok());
            assert_eq!(require_full_access(ProviderKind::Antigravity, mode).is_ok(), mode == PermissionMode::FullAccess);
        }
        let error = require_full_access(ProviderKind::Antigravity, PermissionMode::Auto).unwrap_err();
        assert_eq!(error.to_string(), "Antigravity only runs in Full access. Choose Full access, or pick another agent.");
        assert!(refuse_lead(ProviderKind::Codex).is_ok());
        assert_eq!(
            refuse_lead(ProviderKind::Antigravity).unwrap_err().to_string(),
            "Antigravity can't lead a project: Kybern can't limit its tools. Choose Claude Code or Codex for the lead."
        );
    }

    #[test]
    fn events_without_reverted_applies_reverts_emitted_after_through() {
        let thread_id = Uuid::now_v7();
        let (t1, t2, t3) = (Uuid::now_v7(), Uuid::now_v7(), Uuid::now_v7());
        let event = |seq: EventSeq, turn_id: Option<TurnId>, payload: EventPayload| ThreadEvent {
            seq,
            thread_id,
            turn_id,
            at: Utc::now(),
            payload,
        };
        let events = vec![
            event(1, Some(t1), EventPayload::TurnStarted { message_id: MessageId::now_v7(), message: UserMessage::text("turn 1") }),
            event(
                2,
                Some(t1),
                EventPayload::AssistantMessageCompleted {
                    message_id: MessageId::now_v7(),
                    origin: EventOrigin::Root,
                    text: "a1".into(),
                    thinking: None,
                },
            ),
            event(3, Some(t2), EventPayload::TurnStarted { message_id: MessageId::now_v7(), message: UserMessage::text("turn 2") }),
            event(
                4,
                Some(t2),
                EventPayload::AssistantMessageCompleted {
                    message_id: MessageId::now_v7(),
                    origin: EventOrigin::Root,
                    text: "a2".into(),
                    thinking: None,
                },
            ),
            event(5, Some(t3), EventPayload::TurnStarted { message_id: MessageId::now_v7(), message: UserMessage::text("turn 3") }),
            // Rewind recorded AFTER `through = 4`, undoing t2 (and t3).
            event(6, Some(t2), EventPayload::WorkspaceReverted { to_turn_id: t2, commit: "abc".into() }),
        ];

        let kept = events_without_reverted(&events, 4);
        let kept_seqs: Vec<EventSeq> = kept.iter().map(|e| e.seq).collect();
        assert_eq!(kept_seqs, vec![1, 2], "t2 must be removed by the revert at seq 6 even when through=4");
    }
}
