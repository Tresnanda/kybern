//! Keeping a Claude Code session when its conversation or its target changes.
//!
//! * [`Orchestrator::switch_live_target`]: a new model or effort is applied to the running process
//!   (`set_model`, `apply_flag_settings`) instead of restarting it, so background subagents keep running.
//!   A process that refuses keeps the restart.
//! * [`Orchestrator::recover_missing_conversation`]: Claude Code no longer has the conversation a session
//!   resumes (`No conversation found with session ID`). Kybern forgets the id, hands a fresh session the
//!   conversation so far and sends the user's message once more.

use super::*;

/// Claude Code's answer to a `--resume` whose conversation is gone, as a result error and on stderr.
const MISSING_CONVERSATION: &str = "No conversation found with session ID";

/// The model and effort a live process runs, beside its identity (`live_identity:`).
pub(super) fn live_target_key(thread_id: ThreadId) -> String {
    format!("live_target:{thread_id}")
}

/// The session id in Claude Code's "no conversation" text, or `None` when the text is not that answer.
/// `Some(None)` when it is, without an id Kybern can read.
fn missing_conversation_id(kind: ProviderKind, text: &str) -> Option<Option<String>> {
    if kind != ProviderKind::ClaudeCode {
        return None;
    }
    let rest = &text[text.find(MISSING_CONVERSATION)? + MISSING_CONVERSATION.len()..];
    let id = rest.trim_start_matches([':', ' ']).split(|c: char| c.is_whitespace() || c == '"' || c == '\'').next().unwrap_or("");
    Some((!id.is_empty()).then(|| id.trim_end_matches(['.', ',']).to_string()))
}

impl Orchestrator {
    /// Whether `text` is Claude Code saying the conversation this thread resumes is gone.
    pub(super) fn is_missing_conversation(&self, thread_id: ThreadId, text: &str) -> bool {
        self.inner
            .store
            .thread_get(thread_id)
            .ok()
            .flatten()
            .is_some_and(|thread| missing_conversation_id(thread.provider.kind, text).is_some())
    }

    /// Record the model and effort `thread` launched or switched its live process to.
    pub(super) fn record_live_target(&self, thread: &Thread) -> Result<()> {
        self.inner.store.meta_set(&live_target_key(thread.id), &serde_json::to_string(&(&thread.model, &thread.effort))?)
    }

    /// The live Claude process differs from `thread` only in model or effort: change them in place. Returns
    /// whether it did; `false` leaves the session for the caller to retire.
    pub(super) async fn switch_live_target(&self, thread: &Thread, live: &Arc<LiveSession>, live_identity: Option<&str>) -> Result<bool> {
        if thread.provider.kind != ProviderKind::ClaudeCode || live.is_released() {
            return Ok(false);
        }
        let Some(live_identity) = live_identity else { return Ok(false) };
        let Some(saved) = self.inner.store.meta_get(&live_target_key(thread.id))?.filter(|saved| !saved.is_empty()) else {
            return Ok(false);
        };
        let (model, effort): (Option<String>, Option<String>) = serde_json::from_str(&saved)?;
        // Anything else that changed (account, permissions, configuration) needs a new process.
        if self.session_identity_for(thread, model.as_deref(), effort.as_deref())? != live_identity {
            return Ok(false);
        }
        // Claude Code has no live way back to its own default effort.
        if thread.effort.is_none() && effort.is_some() {
            return Ok(false);
        }
        if live.turn.lock().await.as_ref().is_some_and(|turn| !turn.completed) {
            return Ok(false);
        }
        if thread.model != model {
            let selector = thread.model.as_deref().unwrap_or("default");
            if let Err(error) = live.session.set_model(selector).await {
                tracing::info!(thread_id = %thread.id, %error, "Claude Code refused the model change; restarting its session");
                return Ok(false);
            }
        }
        if let Some(level) = thread.effort.as_deref().filter(|_| thread.effort != effort)
            && let Err(error) = live.session.set_effort(level).await
        {
            tracing::info!(thread_id = %thread.id, %error, "Claude Code refused the effort change; restarting its session");
            return Ok(false);
        }
        tracing::info!(thread_id = %thread.id, from = ?(&model, &effort), to = ?(&thread.model, &thread.effort), "changed the live Claude session's target");
        self.inner.store.meta_set_many(&[
            (&format!("live_identity:{}", thread.id), &self.session_identity(thread)?),
            (&live_target_key(thread.id), &serde_json::to_string(&(&thread.model, &thread.effort))?),
        ])?;
        Ok(true)
    }

    /// The thread's native session is gone from Claude Code: forget `dead` (when it is still the thread's)
    /// and hand the next session the conversation up to `through`.
    fn forget_missing_conversation(&self, thread_id: ThreadId, dead: Option<&str>, through: Option<EventSeq>) -> Result<bool> {
        let Some(mut thread) = self.inner.store.thread_get(thread_id)? else { return Ok(false) };
        if thread.provider_session_id.is_none() || dead.is_some_and(|dead| thread.provider_session_id.as_deref() != Some(dead)) {
            return Ok(false);
        }
        tracing::info!(%thread_id, session = ?thread.provider_session_id, "Claude Code no longer has this conversation; starting a fresh session");
        let through = through.unwrap_or(thread.last_seq);
        self.inner.store.meta_set(&format!("handoff:{thread_id}"), &serde_json::to_string(&(0 as EventSeq, through))?)?;
        thread.provider_session_id = None;
        let thread = self.update_thread(thread)?;
        self.save_account_binding(&thread)?;
        self.emit(
            thread_id,
            None,
            EventPayload::SessionTransitioned {
                from: thread.provider.clone(),
                to: thread.provider.clone(),
                native_resume: false,
                text: "Claude Code no longer has this conversation, so a new session continues it with the conversation so far.".into(),
            },
        )?;
        Ok(true)
    }

    /// A turn failed, or its process exited, because Claude Code could not resume the conversation. Forget
    /// the dead session and, once per turn, send the same message to a fresh one with the conversation so
    /// far. Returns whether the turn was taken over (it then neither fails nor completes here). `exited`:
    /// the event pump already released `live`.
    pub(super) async fn recover_missing_conversation(
        &self,
        thread_id: ThreadId,
        live: &Arc<LiveSession>,
        turn_id: TurnId,
        cause: &str,
        exited: bool,
    ) -> bool {
        let Ok(Some(thread)) = self.inner.store.thread_get(thread_id) else { return false };
        let Some(dead) = missing_conversation_id(thread.provider.kind, cause) else { return false };
        if (!exited && live.is_released()) || thread.status == ThreadStatus::Archived {
            return false;
        }
        let retry_key = format!("fresh_session_retry:{turn_id}");
        let started = self.inner.store.turn_started_message(thread_id, turn_id).ok().flatten();
        let through = self.inner.store.events_for_thread(thread_id).ok().and_then(|events| {
            events
                .iter()
                .find(|event| event.turn_id == Some(turn_id) && matches!(event.payload, EventPayload::TurnStarted { .. }))
                .map(|event| event.seq - 1)
        });
        match self.forget_missing_conversation(thread_id, dead.as_deref(), through) {
            Ok(true) => {}
            Ok(false) => return false,
            Err(error) => {
                tracing::warn!(%thread_id, %error, "could not forget the missing Claude conversation");
                return false;
            }
        }
        let retried = self.inner.store.meta_get(&retry_key).ok().flatten().is_some();
        let Some((message_id, mut message)) = started.filter(|_| !retried) else { return false };
        if self.inner.store.meta_set(&retry_key, "1").is_err() {
            return false;
        }
        // The stored prompt holds large images as references (#298); the agent gets them inline again.
        self.resolve_attachments(&mut message);
        {
            let mut sessions = self.inner.sessions.lock().await;
            if sessions.get(&thread_id).is_some_and(|current| Arc::ptr_eq(current, live)) {
                sessions.remove(&thread_id);
            }
        }
        live.mark_released();
        self.revoke_native_session(live);
        let (this, live) = (self.clone(), live.clone());
        tokio::spawn(async move {
            if let Err(error) = live.session.close().await {
                tracing::debug!(%error, %thread_id, "closing a session whose conversation was gone failed");
            }
            let thread = match this.inner.store.thread_get(thread_id) {
                Ok(Some(thread)) => thread,
                _ => return,
            };
            // start_turn reports its own failures.
            if let Err(error) = this.start_turn_erased(thread, turn_id, message_id, message).await {
                tracing::info!(%thread_id, %error, "the fresh Claude session could not take the turn");
            }
        });
        true
    }

    /// A process that exited outside a turn because its conversation is gone: forget the id, so the next
    /// message starts a fresh session with the conversation so far instead of failing the same way.
    pub(super) fn forget_conversation_after_exit(&self, thread_id: ThreadId, cause: &str) {
        let Ok(Some(thread)) = self.inner.store.thread_get(thread_id) else { return };
        // Only an id Kybern can read: the thread may already be on a newer session.
        if let Some(Some(dead)) = missing_conversation_id(thread.provider.kind, cause)
            && let Err(error) = self.forget_missing_conversation(thread_id, Some(&dead), None)
        {
            tracing::warn!(%thread_id, %error, "could not forget the missing Claude conversation");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_session_id_from_claude_codes_answer() {
        let claude = ProviderKind::ClaudeCode;
        assert_eq!(missing_conversation_id(claude, "No conversation found with session ID: 8f1c-42"), Some(Some("8f1c-42".to_string())));
        assert_eq!(
            missing_conversation_id(claude, "Error: No conversation found with session ID: abc.\nmore"),
            Some(Some("abc".to_string()))
        );
        assert_eq!(missing_conversation_id(claude, "No conversation found with session ID"), Some(None));
        assert_eq!(missing_conversation_id(claude, "exit code 1"), None);
        assert_eq!(missing_conversation_id(ProviderKind::Codex, "No conversation found with session ID: x"), None);
    }
}
