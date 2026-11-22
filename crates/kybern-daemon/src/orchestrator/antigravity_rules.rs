//! The two Antigravity rules, in one place so no path can forget them.
//!
//! Kybern can neither approve nor limit what Antigravity's tools do, so:
//! - a thread on Antigravity is always in Full access, and any other mode is
//!   refused wherever a mode or a provider is set (create, update, send, fork,
//!   move, rotation, delegation, task runs);
//! - Antigravity cannot be a project's Coordinator lead.

use std::sync::Arc;

use anyhow::{Result, anyhow};
use kybern_protocol::{EventPayload, EventSeq, PermissionMode, ProviderKind, Thread, ThreadEvent, ThreadId, ThreadStatus, TurnId};

use super::{LiveSession, Orchestrator, delegation};

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

/// Events through `through` with any turns undone by an earlier `WorkspaceReverted`
/// removed, so portable handoffs after repeated rewinds keep only live turns.
pub(super) fn events_without_reverted(events: &[ThreadEvent], through: EventSeq) -> Vec<ThreadEvent> {
    let slice: Vec<&ThreadEvent> = events.iter().filter(|event| event.seq <= through).collect();
    if !slice.iter().any(|event| matches!(event.payload, EventPayload::WorkspaceReverted { .. })) {
        return slice.into_iter().cloned().collect();
    }
    let mut kept: Vec<ThreadEvent> = Vec::with_capacity(slice.len());
    for event in slice {
        if let EventPayload::WorkspaceReverted { to_turn_id, .. } = &event.payload {
            if let Some(pos) = kept.iter().position(|entry| entry.turn_id == Some(*to_turn_id)) {
                kept.truncate(pos);
            }
            continue;
        }
        kept.push(event.clone());
    }
    kept
}

impl Orchestrator {
    /// Antigravity cannot rewind a saved conversation natively. Drop the old
    /// `--conversation` id and schedule a portable handoff of the kept turns
    /// before `to_turn_id`, so the next message starts a fresh conversation
    /// seeded with the kept transcript.
    pub(super) fn prepare_antigravity_rewind(&self, thread: &mut Thread, to_turn_id: TurnId) -> Result<()> {
        thread.provider_session_id = None;
        self.save_account_binding(thread)?;
        let events = self.inner.store.events_for_thread(thread.id)?;
        let through = seq_before_turn(&events, to_turn_id);
        let handoff = if through > 0 { serde_json::to_string(&(0 as EventSeq, through))? } else { String::new() };
        self.inner.store.meta_set(&format!("handoff:{}", thread.id), &handoff)?;
        Ok(())
    }

    /// When Antigravity fails with Claude's lost or invalid thinking-signature
    /// error, every retry against the same `--conversation` fails the same way.
    /// Drop the poisoned conversation id, carry the thread's prior turns via
    /// the portable handoff path, and retry the turn once on a fresh conversation.
    pub(super) async fn recover_antigravity_thinking_signature(
        &self,
        thread_id: ThreadId,
        live: &Arc<LiveSession>,
        turn_id: TurnId,
        error: &str,
        problem: Option<&kybern_protocol::rpc::Problem>,
    ) -> bool {
        let is_signature_error =
            problem.and_then(|problem| problem.detail.as_deref()).is_some_and(kybern_drivers::antigravity::is_invalid_thinking_signature)
                || kybern_drivers::antigravity::is_invalid_thinking_signature(error);
        if !is_signature_error || live.is_released() {
            return false;
        }
        let Ok(Some(mut thread)) = self.inner.store.thread_get(thread_id) else { return false };
        if thread.provider.kind != ProviderKind::Antigravity || thread.provider_session_id.is_none() {
            return false;
        }
        let recovery_key = format!("agy_sig_recovery:{turn_id}");
        if self.inner.store.meta_get(&recovery_key).ok().flatten().is_some() {
            return false;
        }
        let Ok(Some((message_id, mut message))) = self.inner.store.turn_started_message(thread_id, turn_id) else { return false };
        self.resolve_attachments(&mut message);
        if self.inner.store.meta_set(&recovery_key, "1").is_err() {
            return false;
        }
        {
            let mut sessions = self.inner.sessions.lock().await;
            if sessions.get(&thread_id).is_some_and(|current| Arc::ptr_eq(current, live)) {
                sessions.remove(&thread_id);
            }
        }
        live.mark_released();
        self.revoke_native_session(live);
        thread.provider_session_id = None;
        let _ = self.save_account_binding(&thread);
        if let Ok(events) = self.inner.store.events_for_thread(thread_id) {
            let through = seq_before_turn(&events, turn_id);
            if through > 0
                && let Ok(range) = serde_json::to_string(&(0 as EventSeq, through))
            {
                let _ = self.inner.store.meta_set(&format!("handoff:{thread_id}"), &range);
            }
        }
        if self.update_thread(thread).is_err() {
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
            let restarted = match this.inner.store.thread_get(thread_id) {
                Ok(Some(thread)) => this.start_turn_erased(thread, turn_id, message_id, message).await.map_err(|error| error.to_string()),
                _ => Err("The thread no longer exists.".to_string()),
            };
            if let Err(text) = restarted {
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
            }
        });
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
