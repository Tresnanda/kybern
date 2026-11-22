//! The Pi sessions a thread has left.
//!
//! An extension can start a new session while Pi runs (`ctx.newSession()`), and the
//! thread follows it. The old session is still on disk, so "Import all" would offer
//! it as a second thread, and the rewind points of the turns that ran in it are
//! entries of that session, not of the one the thread is in now. The driver says so
//! in a notice (`kybern_drivers::pi::SESSION_SWITCH_KEY`); this keeps what it said:
//! the session ids left behind (a few, newest last) and the turn the switch happened in.

use anyhow::{Result, anyhow};
use kybern_drivers::pi::{REWIND_ACROSS_SESSIONS, SESSION_SWITCH_KEY};
use kybern_protocol::methods::SavedSession;
use kybern_protocol::{Checkpoint, ProviderKind, Thread, ThreadId, TurnId};
use kybern_store::Store;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

/// More than a thread is likely to leave; the oldest are forgotten first.
const MAX_EARLIER_SESSIONS: usize = 16;

#[derive(Default, Serialize, Deserialize)]
struct Switches {
    earlier: Vec<String>,
    /// The turn that ended in the newest session; its own rewind point is in it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    turn: Option<TurnId>,
    /// A switch noticed outside any turn (a context refresh or handoff): the turns that already
    /// have a checkpoint (this many) are all in sessions the thread left.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    checkpointed: Option<usize>,
}

/// Only Pi and omp announce a switch; a notice of another provider that carries the key is not one.
fn is_pi(store: &Store, thread_id: ThreadId) -> bool {
    store.thread_get(thread_id).ok().flatten().is_some_and(|thread| matches!(thread.provider.kind, ProviderKind::Pi | ProviderKind::Omp))
}

fn key(thread_id: ThreadId) -> String {
    format!("pi_sessions:{thread_id}")
}

fn load(store: &Store, thread_id: ThreadId) -> Switches {
    store.meta_get(&key(thread_id)).ok().flatten().and_then(|json| serde_json::from_str(&json).ok()).unwrap_or_default()
}

/// Remember a switch the driver announced in a notice's `data`; other notices pass.
pub(crate) fn note_switch(store: &Store, thread_id: ThreadId, turn_id: Option<TurnId>, data: Option<&Value>) -> Result<()> {
    let Some(from) = data.and_then(|data| data.get(SESSION_SWITCH_KEY)).and_then(|switch| switch.get("from")).and_then(Value::as_str)
    else {
        return Ok(());
    };
    if !is_pi(store, thread_id) {
        return Ok(());
    }
    let mut switches = load(store, thread_id);
    if !switches.earlier.iter().any(|id| id == from) {
        switches.earlier.push(from.to_string());
        let excess = switches.earlier.len().saturating_sub(MAX_EARLIER_SESSIONS);
        switches.earlier.drain(..excess);
    }
    match turn_id {
        Some(turn) => switches.turn = Some(turn),
        // No turn to name: everything checkpointed so far is before the new session. Keep an earlier guard.
        None => switches.checkpointed = Some(store.checkpoints_for_thread(thread_id)?.len()),
    }
    store.meta_set(&key(thread_id), &serde_json::to_string(&switches)?)?;
    Ok(())
}

/// Session ids this thread used before the one it has now.
pub(crate) fn earlier_sessions(store: &Store, thread_id: ThreadId) -> Vec<String> {
    load(store, thread_id).earlier
}

/// Every session id a thread has used, the current one last.
pub(crate) fn session_ids(store: &Store, thread: &Thread) -> Vec<String> {
    let mut ids = earlier_sessions(store, thread.id);
    ids.extend(thread.provider_session_id.clone());
    ids
}

/// A native session, as one account of one provider names it.
pub(crate) type SessionKey = (ProviderKind, String, String);

/// Which thread holds each native session: the one it is in now or one it left.
/// "Import all", the session picker and resuming all ask this, so none offers a session twice.
pub(crate) fn session_owners(store: &Store, threads: &[Thread]) -> HashMap<SessionKey, ThreadId> {
    let mut owners = HashMap::new();
    for thread in threads {
        for id in session_ids(store, thread) {
            owners.entry((thread.provider.kind, thread.provider.instance.clone(), id)).or_insert(thread.id);
        }
    }
    owners
}

/// Fill in `thread_id` of the sessions a session list shows: the thread each one belongs to.
pub(crate) fn mark_imported(store: &Store, instance: &str, sessions: &mut [SavedSession]) -> Result<()> {
    let owners = session_owners(store, &store.threads_list(None, true)?);
    for session in sessions {
        session.thread_id = owners.get(&(session.provider, instance.to_string(), session.id.clone())).copied();
    }
    Ok(())
}

/// Refuse a rewind to `checkpoints[index]` when its rewind point is in a session the
/// thread left. The turn that switched, and every turn after it, are in the new one.
/// A rewind to the first turn starts a fresh session and has no such point.
pub(crate) fn ensure_rewindable(store: &Store, thread_id: ThreadId, checkpoints: &[Checkpoint], index: usize) -> Result<()> {
    if !is_pi(store, thread_id) {
        return Ok(());
    }
    let switches = load(store, thread_id);
    let named = switches.turn.and_then(|switched| checkpoints.iter().position(|checkpoint| checkpoint.turn_id == switched));
    let Some(switched_at) = named.into_iter().chain(switches.checkpointed).max() else { return Ok(()) };
    if index > 0 && index < switched_at {
        return Err(anyhow!(REWIND_ACROSS_SESSIONS));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use kybern_protocol::{PermissionMode, Project, ProviderInstance, ThreadStatus};
    use serde_json::json;
    use uuid::Uuid;

    fn thread(store: &Store, kind: ProviderKind) -> ThreadId {
        let now = chrono::Utc::now();
        let project = Project {
            repo: None,
            repos: Vec::new(),
            id: Uuid::now_v7(),
            name: "fixture".into(),
            path: format!("/tmp/kybern-pi-sessions-{}", Uuid::now_v7()),
            is_git: false,
            worktrees_default: None,
            task_prefix: None,
            brief_in_all_threads: false,
            coordinator: None,
            space_id: None,
            created_at: now,
            updated_at: now,
            kind: Default::default(),
            members: Vec::new(),
            worktree_copy: Vec::new(),
            instructions_offer_dismissed: false,
        };
        store.project_insert(&project).unwrap();
        let thread = Thread {
            id: Uuid::now_v7(),
            project_id: project.id,
            title: "Fixture".into(),
            provider: ProviderInstance::default_for(kind),
            model: None,
            effort: None,
            permission_mode: PermissionMode::Supervised,
            status: ThreadStatus::Idle,
            worktree: None,
            cwd: project.path.clone(),
            provider_session_id: Some("current".into()),
            pinned: false,
            created_at: now,
            updated_at: now,
            last_seq: 0,
            parent_thread_id: None,
            coordinator_project_id: None,
            origin: None,
            inbound: None,
            moved: None,
            older_at: None,
            keep_out_of_older: false,
            subagent: None,
            delegation: None,
            members: Vec::new(),
        };
        store.thread_upsert(&thread).unwrap();
        thread.id
    }

    fn checkpoint(thread_id: ThreadId, turn_id: TurnId) -> Checkpoint {
        Checkpoint {
            thread_id,
            turn_id,
            before: "before".into(),
            after: None,
            provider_turn_id: Some("entry".into()),
            provider_turn_end: None,
            created_at: chrono::Utc::now(),
            repos: vec![],
            incomplete: false,
        }
    }

    fn switch(from: &str, to: &str) -> Value {
        json!({ SESSION_SWITCH_KEY: { "from": from, "to": to } })
    }

    const REFUSED: &str = "This turn is from an earlier Pi session. Start a new thread from here instead.";

    #[test]
    fn a_switch_is_remembered_and_other_notices_are_ignored() {
        let store = Store::open_in_memory().unwrap();
        let thread = thread(&store, ProviderKind::Pi);
        note_switch(&store, thread, Some(Uuid::now_v7()), None).unwrap();
        note_switch(&store, thread, Some(Uuid::now_v7()), Some(&json!({ "clearedQueue": ["x"] }))).unwrap();
        assert!(earlier_sessions(&store, thread).is_empty());

        note_switch(&store, thread, Some(Uuid::now_v7()), Some(&switch("a", "b"))).unwrap();
        note_switch(&store, thread, Some(Uuid::now_v7()), Some(&switch("b", "c"))).unwrap();
        note_switch(&store, thread, Some(Uuid::now_v7()), Some(&switch("b", "c"))).unwrap();
        assert_eq!(earlier_sessions(&store, thread), ["a", "b"]);
        assert!(earlier_sessions(&store, Uuid::now_v7()).is_empty(), "another thread's sessions are its own");
    }

    #[test]
    fn a_notice_of_another_provider_with_the_key_is_not_a_switch() {
        let store = Store::open_in_memory().unwrap();
        let other = thread(&store, ProviderKind::ClaudeCode);
        note_switch(&store, other, Some(Uuid::now_v7()), Some(&switch("a", "b"))).unwrap();
        assert!(earlier_sessions(&store, other).is_empty());
        let omp = thread(&store, ProviderKind::Omp);
        note_switch(&store, omp, None, Some(&switch("a", "b"))).unwrap();
        assert_eq!(earlier_sessions(&store, omp), ["a"], "omp is Pi's fork and switches the same way");
    }

    #[test]
    fn a_thread_of_another_provider_is_never_refused_a_rewind() {
        let store = Store::open_in_memory().unwrap();
        let thread = thread(&store, ProviderKind::ClaudeCode);
        // A stale record under the thread's key (the thread was Pi's once, or a bad notice slipped in).
        let turns: Vec<Checkpoint> = (0..4).map(|_| checkpoint(thread, Uuid::now_v7())).collect();
        store
            .meta_set(
                &key(thread),
                &serde_json::to_string(&Switches { earlier: vec!["a".into()], turn: Some(turns[3].turn_id), checkpointed: None }).unwrap(),
            )
            .unwrap();
        for index in 0..turns.len() {
            ensure_rewindable(&store, thread, &turns, index).unwrap();
        }
    }

    #[test]
    fn the_list_stays_small() {
        let store = Store::open_in_memory().unwrap();
        let thread = thread(&store, ProviderKind::Pi);
        for n in 0..40 {
            note_switch(&store, thread, None, Some(&switch(&format!("s{n}"), &format!("s{}", n + 1)))).unwrap();
        }
        let earlier = earlier_sessions(&store, thread);
        assert_eq!(earlier.len(), MAX_EARLIER_SESSIONS);
        assert_eq!(earlier.last().unwrap(), "s39");
    }

    #[test]
    fn rewinding_across_a_switch_is_refused_with_what_to_do() {
        let store = Store::open_in_memory().unwrap();
        let thread = thread(&store, ProviderKind::Pi);
        let turns: Vec<Checkpoint> = (0..5).map(|_| checkpoint(thread, Uuid::now_v7())).collect();
        // Nothing switched: every turn can be rewound to.
        for index in 0..turns.len() {
            ensure_rewindable(&store, thread, &turns, index).unwrap();
        }
        // Turn 3 ended in a new session.
        note_switch(&store, thread, Some(turns[3].turn_id), Some(&switch("old", "new"))).unwrap();
        for index in [1, 2] {
            let error = ensure_rewindable(&store, thread, &turns, index).unwrap_err().to_string();
            assert_eq!(error, REFUSED);
        }
        // The first turn starts over; the switching turn and later ones are in the new session.
        for index in [0, 3, 4] {
            ensure_rewindable(&store, thread, &turns, index).unwrap();
        }
    }

    #[test]
    fn a_switch_outside_any_turn_does_not_lift_an_earlier_guard() {
        let store = Store::open_in_memory().unwrap();
        let thread = thread(&store, ProviderKind::Pi);
        let turns: Vec<Checkpoint> = (0..5).map(|_| checkpoint(thread, Uuid::now_v7())).collect();
        for turn in &turns[..4] {
            store.checkpoint_upsert(turn).unwrap();
        }
        note_switch(&store, thread, Some(turns[2].turn_id), Some(&switch("old", "mid"))).unwrap();
        // A context refresh moved the thread again with no turn to name.
        note_switch(&store, thread, None, Some(&switch("mid", "new"))).unwrap();
        for index in [1, 2, 3] {
            let error = ensure_rewindable(&store, thread, &turns, index).unwrap_err().to_string();
            assert_eq!(error, REFUSED, "turn {index} is in a session the thread left");
        }
        for index in [0, 4] {
            ensure_rewindable(&store, thread, &turns, index).unwrap();
        }
    }

    #[test]
    fn a_first_switch_outside_any_turn_guards_every_checkpointed_turn() {
        let store = Store::open_in_memory().unwrap();
        let thread = thread(&store, ProviderKind::Pi);
        let turns: Vec<Checkpoint> = (0..4).map(|_| checkpoint(thread, Uuid::now_v7())).collect();
        for turn in &turns[..3] {
            store.checkpoint_upsert(turn).unwrap();
        }
        note_switch(&store, thread, None, Some(&switch("old", "new"))).unwrap();
        for index in [1, 2] {
            assert_eq!(ensure_rewindable(&store, thread, &turns, index).unwrap_err().to_string(), REFUSED);
        }
        // The first turn starts over, and the turn after the switch is in the new session.
        for index in [0, 3] {
            ensure_rewindable(&store, thread, &turns, index).unwrap();
        }
    }
}
