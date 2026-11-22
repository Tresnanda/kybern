//! The two Antigravity rules, in one place so no path can forget them.
//!
//! On `agy -p` Kybern can neither approve nor limit what Antigravity's tools do, so:
//! - a thread on Antigravity is in Full access, and any other mode is refused
//!   wherever a mode or a provider is set (create, update, send, fork, move,
//!   rotation, delegation, task runs), unless this machine's `agy` runs on ACP
//!   (1.5.0 or later), where Kybern answers its permission requests and every
//!   mode works (the driver's `accepts_permission_mode`);
//! - Antigravity cannot be a project's Coordinator lead (Kybern can't make it
//!   read-only on either transport).

use std::sync::Arc;

use anyhow::{Result, anyhow};
use kybern_drivers::registry::DriverRegistry;
use kybern_protocol::{EventPayload, EventSeq, PermissionMode, ProviderKind, Thread, ThreadEvent, ThreadId, ThreadStatus, TurnId};

use super::{LiveSession, Orchestrator, resend};

pub(super) fn is_signature_failure(error: &str, problem: Option<&kybern_protocol::rpc::Problem>) -> bool {
    problem.and_then(|problem| problem.detail.as_deref()).is_some_and(kybern_drivers::antigravity::is_invalid_thinking_signature)
        || kybern_drivers::antigravity::is_invalid_thinking_signature(error)
}

/// Refuses any mode but Full access for an Antigravity thread, unless this machine's Antigravity takes it.
pub(crate) fn require_full_access(drivers: &DriverRegistry, kind: ProviderKind, mode: PermissionMode) -> Result<()> {
    if kind == ProviderKind::Antigravity && !drivers.get(kind).is_some_and(|driver| driver.accepts_permission_mode(mode)) {
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
    /// Record a portable handoff covering every live event before `to_turn_id`,
    /// or clear it when no live conversation turns precede `to_turn_id`.
    pub(super) fn set_rewind_handoff(&self, thread_id: ThreadId, to_turn_id: TurnId) -> Result<()> {
        let events = self.inner.store.events_for_thread(thread_id)?;
        let through = seq_before_turn(&events, to_turn_id);
        let has_prior_turns = through > 0
            && events_without_reverted(&events, through)
                .iter()
                .any(|event| matches!(event.payload, EventPayload::TurnStarted { .. } | EventPayload::AssistantMessageCompleted { .. }));
        let handoff = if has_prior_turns { serde_json::to_string(&(0 as EventSeq, through))? } else { String::new() };
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

    /// When Antigravity fails with Claude's lost or invalid thinking-signature
    /// error, every retry against the same `--conversation` fails the same way.
    /// Drop the poisoned conversation id, carry the thread's prior turns via
    /// the portable handoff path, and plan one retry on a fresh conversation
    /// through the shared resend guard (`resend.rs`). Call while holding
    /// `live.turn`, then [`Orchestrator::run_resend`] once it is released.
    pub(super) fn plan_antigravity_signature(
        &self,
        thread_id: ThreadId,
        live: &Arc<LiveSession>,
        turn_id: TurnId,
        retiring: bool,
        error: &str,
        problem: Option<&kybern_protocol::rpc::Problem>,
    ) -> Option<resend::PlannedResend> {
        if !is_signature_failure(error, problem) {
            return None;
        }
        let mut thread = self.inner.store.thread_get(thread_id).ok().flatten()?;
        if thread.provider.kind != ProviderKind::Antigravity {
            return None;
        }
        let recovery_key = format!("agy_sig_recovery:{turn_id}");
        let can_retry = !retiring
            && !live.is_released()
            && thread.status != ThreadStatus::Archived
            && thread.provider_session_id.is_some()
            && self.inner.store.meta_get(&recovery_key).ok().flatten().is_none();
        let started = if can_retry { self.inner.store.turn_started_message(thread_id, turn_id).ok().flatten() } else { None };
        let Some((message_id, mut message)) = started else {
            // The driver dropped `state.conversation` on this error. Even when we decline an
            // automatic retry (second failure on this turn, released/retiring session, or missing
            // prompt), clear `provider_session_id` and write the portable handoff so the next
            // user message keeps the thread's context instead of starting blank.
            self.reset_poisoned_antigravity_conversation(&mut thread, turn_id);
            return None;
        };
        if self.inner.store.meta_set(&recovery_key, "1").is_err() {
            self.reset_poisoned_antigravity_conversation(&mut thread, turn_id);
            return None;
        }
        if !self.reset_poisoned_antigravity_conversation(&mut thread, turn_id) {
            return None;
        }
        // The stored prompt holds large images as references (#298); the agent gets them inline again.
        self.resolve_attachments(&mut message);
        tracing::info!(
            %thread_id,
            %turn_id,
            "Antigravity conversation hit an invalid thinking signature; retrying once on a fresh conversation with thread context"
        );
        let guard = self.begin_resend(thread_id, turn_id, resend::ResendReason::AntigravitySignature);
        Some(resend::PlannedResend { guard, message_id, message, login: None })
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
        // An Antigravity that can't ask before acting (`-p`, or not installed here).
        let drivers = DriverRegistry::default();
        for mode in PermissionMode::ALL {
            assert!(require_full_access(&drivers, ProviderKind::ClaudeCode, mode).is_ok());
            assert_eq!(require_full_access(&drivers, ProviderKind::Antigravity, mode).is_ok(), mode == PermissionMode::FullAccess);
        }
        let error = require_full_access(&drivers, ProviderKind::Antigravity, PermissionMode::Auto).unwrap_err();
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
