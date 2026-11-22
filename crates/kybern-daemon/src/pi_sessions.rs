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
use kybern_protocol::{Checkpoint, ThreadId, TurnId};
use kybern_store::Store;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// More than a thread is likely to leave; the oldest are forgotten first.
const MAX_EARLIER_SESSIONS: usize = 16;

#[derive(Default, Serialize, Deserialize)]
struct Switches {
    earlier: Vec<String>,
    /// The turn that ended in the newest session; its own rewind point is in it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    turn: Option<TurnId>,
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
    let mut switches = load(store, thread_id);
    if !switches.earlier.iter().any(|id| id == from) {
        switches.earlier.push(from.to_string());
        let excess = switches.earlier.len().saturating_sub(MAX_EARLIER_SESSIONS);
        switches.earlier.drain(..excess);
    }
    switches.turn = turn_id;
    store.meta_set(&key(thread_id), &serde_json::to_string(&switches)?)?;
    Ok(())
}

/// Session ids this thread used before the one it has now.
pub(crate) fn earlier_sessions(store: &Store, thread_id: ThreadId) -> Vec<String> {
    load(store, thread_id).earlier
}

/// Refuse a rewind to `checkpoints[index]` when its rewind point is in a session the
/// thread left. The turn that switched, and every turn after it, are in the new one.
/// A rewind to the first turn starts a fresh session and has no such point.
pub(crate) fn ensure_rewindable(store: &Store, thread_id: ThreadId, checkpoints: &[Checkpoint], index: usize) -> Result<()> {
    let Some(switched) = load(store, thread_id).turn else { return Ok(()) };
    let Some(switched_at) = checkpoints.iter().position(|checkpoint| checkpoint.turn_id == switched) else { return Ok(()) };
    if index > 0 && index < switched_at {
        return Err(anyhow!(REWIND_ACROSS_SESSIONS));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use uuid::Uuid;

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

    #[test]
    fn a_switch_is_remembered_and_other_notices_are_ignored() {
        let store = Store::open_in_memory().unwrap();
        let thread = Uuid::now_v7();
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
    fn the_list_stays_small() {
        let store = Store::open_in_memory().unwrap();
        let thread = Uuid::now_v7();
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
        let thread = Uuid::now_v7();
        let turns: Vec<Checkpoint> = (0..5).map(|_| checkpoint(thread, Uuid::now_v7())).collect();
        // Nothing switched: every turn can be rewound to.
        for index in 0..turns.len() {
            ensure_rewindable(&store, thread, &turns, index).unwrap();
        }
        // Turn 3 ended in a new session.
        note_switch(&store, thread, Some(turns[3].turn_id), Some(&switch("old", "new"))).unwrap();
        for index in [1, 2] {
            let error = ensure_rewindable(&store, thread, &turns, index).unwrap_err().to_string();
            assert_eq!(error, "This turn is from an earlier Pi session. Start a new thread from here instead.");
        }
        // The first turn starts over; the switching turn and later ones are in the new session.
        for index in [0, 3, 4] {
            ensure_rewindable(&store, thread, &turns, index).unwrap();
        }
    }
}
