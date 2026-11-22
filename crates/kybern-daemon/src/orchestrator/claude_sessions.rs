//! Keeping a Claude Code session when its conversation or its target changes.
//!
//! * [`Orchestrator::switch_live_target`]: a new model or effort is applied to the running process
//!   (`set_model`, `apply_flag_settings`) instead of restarting it, so background subagents keep running.
//!   A process that refuses keeps the restart.
//! * [`Orchestrator::recover_missing_conversation`]: Claude Code no longer has the conversation a session
//!   resumes (`No conversation found with session ID`). Kybern forgets the id, hands a fresh session the
//!   conversation so far and sends the user's message once more. A Stop between the two sessions
//!   ([`Orchestrator::stop_pending_resend`]) ends the turn instead of sending it.
//! * Retained sessions (any harness, kept for their background work): a background agent's result is shown
//!   in the thread, and one that stays quiet for [`RETAINED_QUIET_LIMIT`] is stopped.

use super::*;

/// How long a retired session kept only for background agents may go without a word from them. Agents
/// that never report would otherwise keep a whole harness process until the thread is deleted.
pub(super) const RETAINED_QUIET_LIMIT: Duration = Duration::from_secs(30 * 60);

/// The turn of a thread being resent to a new session (`resend:<thread>`), and whether Stop came for it
/// meanwhile (`resend_stopped:<turn>`).
fn resend_key(thread_id: ThreadId) -> String {
    format!("resend:{thread_id}")
}

/// The last session id Kybern forgot because Claude Code no longer had its conversation.
fn forgotten_key(thread_id: ThreadId) -> String {
    format!("forgotten_session:{thread_id}")
}

fn resend_stopped_key(turn_id: TurnId) -> String {
    format!("resend_stopped:{turn_id}")
}

/// Claude Code's answer to a `--resume` whose conversation is gone, as a result error and on stderr.
const MISSING_CONVERSATION: &str = "No conversation found with session ID";

/// The model and effort a live process runs, beside its identity (`live_identity:`).
pub(super) fn live_target_key(thread_id: ThreadId) -> String {
    format!("live_target:{thread_id}")
}

/// The session id in Claude Code's "no conversation" answer, or `None` when the text is not that answer.
/// Claude Code 2.1.327 writes it as a line of its own (`No conversation found with session ID: <id>`), so
/// only a line, or one of a result's `; `-joined errors, that starts with the phrase counts: a subagent
/// or a tool quoting it mid-sentence does not. `Some(None)` when it is, without an id Kybern can read.
fn missing_conversation_id(kind: ProviderKind, text: &str) -> Option<Option<String>> {
    if kind != ProviderKind::ClaudeCode {
        return None;
    }
    let rest = text.lines().flat_map(|line| line.split("; ")).find_map(|part| part.trim().strip_prefix(MISSING_CONVERSATION))?;
    let id = rest.trim_start_matches([':', ' ']).split(|c: char| c.is_whitespace() || c == '"' || c == '\'').next().unwrap_or("");
    Some((!id.is_empty()).then(|| id.trim_end_matches(['.', ',']).to_string()))
}

/// The answer as an exit's stderr tail holds it: only with the id of the session `thread` resumes, since
/// the tail can hold anything the process printed.
fn missing_conversation_on_exit(thread: &Thread, text: &str) -> Option<String> {
    let id = missing_conversation_id(thread.provider.kind, text).flatten()?;
    (thread.provider_session_id.as_deref() == Some(id.as_str())).then_some(id)
}

impl Orchestrator {
    /// Whether an exit's `text` is Claude Code saying the conversation this thread resumes, or the one a
    /// failed result just made it forget, is gone.
    pub(super) fn is_missing_conversation(&self, thread_id: ThreadId, text: &str) -> bool {
        let Some(thread) = self.inner.store.thread_get(thread_id).ok().flatten() else { return false };
        if missing_conversation_on_exit(&thread, text).is_some() {
            return true;
        }
        let forgotten = self.inner.store.meta_get(&forgotten_key(thread_id)).ok().flatten().filter(|id| !id.is_empty());
        forgotten
            .is_some_and(|forgotten| missing_conversation_id(thread.provider.kind, text).flatten().as_deref() == Some(forgotten.as_str()))
    }

    /// Record the model and effort `thread` launched or switched its live process to.
    pub(super) fn record_live_target(&self, thread: &Thread) -> Result<()> {
        self.inner.store.meta_set(&live_target_key(thread.id), &serde_json::to_string(&(&thread.model, &thread.effort))?)
    }

    /// The model and effort the thread's live process runs, when Kybern recorded them.
    pub(super) fn live_target(&self, thread_id: ThreadId) -> Result<Option<(Option<String>, Option<String>)>> {
        let Some(saved) = self.inner.store.meta_get(&live_target_key(thread_id))?.filter(|saved| !saved.is_empty()) else {
            return Ok(None);
        };
        Ok(Some(serde_json::from_str(&saved)?))
    }

    /// The identity of the live process with `thread`'s other settings: built from the model and effort it
    /// runs, not the thread's, which a send changes before the process switches. `None` without a record.
    pub(super) fn live_identity_for(&self, thread: &Thread) -> Result<Option<String>> {
        let Some((model, effort)) = self.live_target(thread.id)? else { return Ok(None) };
        self.session_identity_for(thread, model.as_deref(), effort.as_deref()).map(Some)
    }

    /// The live Claude process differs from `thread` only in model or effort: change them in place. Returns
    /// whether it did; `false` leaves the session for the caller to retire.
    pub(super) async fn switch_live_target(&self, thread: &Thread, live: &Arc<LiveSession>, live_identity: Option<&str>) -> Result<bool> {
        if thread.provider.kind != ProviderKind::ClaudeCode || live.is_released() {
            return Ok(false);
        }
        let Some(live_identity) = live_identity else { return Ok(false) };
        let Some((model, effort)) = self.live_target(thread.id)? else { return Ok(false) };
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
        let model_switched = thread.model != model;
        if model_switched {
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
            // The caller may keep this process for its background work under the identity it had: it must
            // run that identity's model again, or be closed.
            if model_switched && let Err(error) = live.session.set_model(model.as_deref().unwrap_or("default")).await {
                tracing::warn!(thread_id = %thread.id, %error, "Claude Code could not switch back to its model; closing its session");
                self.close_unknown_target(thread.id, live).await;
            }
            return Ok(false);
        }
        tracing::info!(thread_id = %thread.id, from = ?(&model, &effort), to = ?(&thread.model, &thread.effort), "changed the live Claude session's target");
        self.inner.store.meta_set_many(&[
            (&format!("live_identity:{}", thread.id), &self.session_identity(thread)?),
            (&live_target_key(thread.id), &serde_json::to_string(&(&thread.model, &thread.effort))?),
        ])?;
        Ok(true)
    }

    /// A live process whose model Kybern no longer knows: close it, background work included, so nothing
    /// reuses it under an identity it does not have.
    async fn close_unknown_target(&self, thread_id: ThreadId, live: &Arc<LiveSession>) {
        {
            let mut sessions = self.inner.sessions.lock().await;
            if sessions.get(&thread_id).is_some_and(|current| Arc::ptr_eq(current, live)) {
                sessions.remove(&thread_id);
            }
        }
        live.mark_released();
        self.revoke_native_session(live);
        self.interrupt_runtime_tasks(thread_id, live, "Stopped because Claude Code couldn't switch back to its model.").await;
        if let Err(error) = live.session.close().await {
            tracing::debug!(%thread_id, %error, "closing a Claude session on an unknown model failed");
        }
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
        self.inner.store.meta_set_many(&[
            (&format!("handoff:{thread_id}"), &serde_json::to_string(&(0 as EventSeq, through))?),
            (&forgotten_key(thread_id), thread.provider_session_id.as_deref().unwrap_or_default()),
        ])?;
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
        // A result's error is Claude Code's own answer; an exit's stderr tail must name this session.
        let dead = if exited {
            match missing_conversation_on_exit(&thread, cause) {
                Some(id) => Some(id),
                None => return false,
            }
        } else {
            match missing_conversation_id(thread.provider.kind, cause) {
                Some(id) => id,
                None => return false,
            }
        };
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
        // From here until the fresh session holds the turn there is no live session: Stop records itself.
        if let Err(error) = self.begin_resend(thread_id, turn_id) {
            tracing::warn!(%thread_id, %error, "could not record the resend");
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
        let (this, live) = (self.clone(), live.clone());
        tokio::spawn(async move {
            if let Err(error) = live.session.close().await {
                tracing::debug!(%error, %thread_id, "closing a session whose conversation was gone failed");
            }
            let Some(thread) = this.resend_still_wanted(thread_id, turn_id) else { return };
            // start_turn reports its own failures.
            if let Err(error) = this.start_turn_erased(thread, turn_id, message_id, message).await {
                tracing::info!(%thread_id, %error, "the fresh Claude session could not take the turn");
            }
            this.finish_resend(thread_id, turn_id).await;
        });
        true
    }

    /// A turn is about to move to a new session (a lost conversation, a rejected login).
    pub(super) fn begin_resend(&self, thread_id: ThreadId, turn_id: TurnId) -> Result<()> {
        self.inner.store.meta_set(&resend_key(thread_id), &turn_id.to_string())
    }

    fn resend_turn(&self, thread_id: ThreadId) -> Option<TurnId> {
        self.inner.store.meta_get(&resend_key(thread_id)).ok().flatten().and_then(|turn| turn.parse().ok())
    }

    /// Stop came while the thread's turn is between two sessions: record it, so the turn ends instead of
    /// being sent. Returns whether a turn was waiting.
    pub(super) fn stop_pending_resend(&self, thread_id: ThreadId) -> Result<bool> {
        let Some(turn_id) = self.resend_turn(thread_id) else { return Ok(false) };
        tracing::info!(%thread_id, %turn_id, "stopped a turn waiting for its new session");
        self.inner.store.meta_set(&resend_stopped_key(turn_id), "1")?;
        Ok(true)
    }

    fn resend_was_stopped(&self, turn_id: TurnId) -> bool {
        self.inner.store.meta_get(&resend_stopped_key(turn_id)).ok().flatten().is_some_and(|stopped| !stopped.is_empty())
    }

    /// The thread, when its turn should still be sent: not stopped, still running and not archived.
    /// Otherwise the turn is ended as interrupted and `None` returned.
    pub(super) fn resend_still_wanted(&self, thread_id: ThreadId, turn_id: TurnId) -> Option<Thread> {
        let thread = self.inner.store.thread_get(thread_id).ok().flatten();
        let running = thread.as_ref().is_some_and(|thread| matches!(thread.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval));
        if running && !self.resend_was_stopped(turn_id) {
            return thread;
        }
        tracing::info!(%thread_id, %turn_id, "not resending a turn that was stopped meanwhile");
        self.clear_resend(thread_id, turn_id);
        if running {
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
            if let Some(mut thread) = thread {
                thread.status = ThreadStatus::Idle;
                let _ = self.update_thread(thread);
            }
            self.delegation_turn_finished(
                thread_id,
                turn_id,
                delegation::TurnOutcome::Completed { stop_reason: StopReason::Interrupted, terminal_message_id: None },
            );
        }
        None
    }

    /// The new session took the turn (or failed to): a Stop that came while it started reaches it now.
    pub(super) async fn finish_resend(&self, thread_id: ThreadId, turn_id: TurnId) {
        let stopped = self.resend_was_stopped(turn_id);
        self.clear_resend(thread_id, turn_id);
        if stopped && let Err(error) = self.interrupt_turn_erased(thread_id).await {
            tracing::debug!(%thread_id, %error, "the resent turn had nothing left to stop");
        }
    }

    /// `interrupt_turn` behind a boxed future: a resend runs inside an event pump's task, and interrupting
    /// can reach that pump again (see `start_turn_erased`).
    fn interrupt_turn_erased(&self, thread_id: ThreadId) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + '_>> {
        Box::pin(self.interrupt_turn(thread_id, "stop while the turn moved to a new session"))
    }

    pub(super) fn clear_resend(&self, thread_id: ThreadId, turn_id: TurnId) {
        if self.resend_turn(thread_id) == Some(turn_id) {
            let _ = self.inner.store.meta_set(&resend_key(thread_id), "");
        }
        let _ = self.inner.store.meta_set(&resend_stopped_key(turn_id), "");
    }

    /// A process that exited outside a turn because its conversation is gone: forget the id, so the next
    /// message starts a fresh session with the conversation so far instead of failing the same way.
    pub(super) fn forget_conversation_after_exit(&self, thread_id: ThreadId, cause: &str) {
        let Ok(Some(thread)) = self.inner.store.thread_get(thread_id) else { return };
        // Only the id of the session the thread resumes: it may already be on a newer one.
        if let Some(dead) = missing_conversation_on_exit(&thread, cause)
            && let Err(error) = self.forget_missing_conversation(thread_id, Some(&dead), None)
        {
            tracing::warn!(%thread_id, %error, "could not forget the missing Claude conversation");
        }
    }

    /// A background agent of a retained session ended. The receiving session never sees its result, so the
    /// thread shows it; the agent's own thread keeps the whole conversation.
    pub(super) fn report_retained_agent(&self, thread_id: ThreadId, task: &RuntimeTask) {
        if task.kind != RuntimeTaskKind::Agent || task.status.is_active() {
            return;
        }
        let ended = match task.status {
            RuntimeTaskStatus::Failed => "failed",
            RuntimeTaskStatus::Stopped | RuntimeTaskStatus::Interrupted => "stopped",
            _ => "finished",
        };
        let name = if task.title.trim().is_empty() { "A background agent".to_string() } else { format!("“{}”", task.title.trim()) };
        let result = self.subagent_result(thread_id, &task.id).or_else(|| task.detail.clone()).filter(|text| !text.trim().is_empty());
        let text = match result {
            Some(result) => {
                format!("{name} {ended} in the session this thread had before. The agent here didn't get its result:\n\n{}", result.trim())
            }
            None => format!("{name} {ended} in the session this thread had before. Its result is in its own thread."),
        };
        let level = if task.status == RuntimeTaskStatus::Failed { NoticeLevel::Warning } else { NoticeLevel::Info };
        if let Err(error) = self.emit(
            thread_id,
            None,
            EventPayload::ProviderNotice { level, text, data: Some(serde_json::json!({ "retained_task": task.id })), problem: None },
        ) {
            tracing::warn!(%thread_id, %error, "could not show a retained agent's result");
        }
    }

    /// Close retained sessions kept only for background agents that sent nothing for `RETAINED_QUIET_LIMIT`.
    /// A session that also runs a process or monitor (a dev server) is the person's to stop.
    pub(super) async fn close_quiet_retained_sessions(&self, now: Instant, wall_now: SystemTime) -> Result<()> {
        let retained =
            self.inner.retained_sessions.lock().await.iter().map(|(key, (_, live))| (key.clone(), live.clone())).collect::<Vec<_>>();
        for ((thread_id, identity), live) in retained {
            let (agents_only, quiet) = {
                let tasks = live.tasks.lock().await;
                let active = tasks.values().filter(|task| task.status.is_active()).collect::<Vec<_>>();
                (!active.is_empty() && active.iter().all(|task| task.kind == RuntimeTaskKind::Agent), active.len())
            };
            if !agents_only || live.last_activity().idle_for(now, wall_now) < RETAINED_QUIET_LIMIT {
                continue;
            }
            let removed = {
                let mut sessions = self.inner.retained_sessions.lock().await;
                match sessions.get(&(thread_id, identity.clone())) {
                    Some((_, current)) if Arc::ptr_eq(current, &live) => sessions.remove(&(thread_id, identity)).is_some(),
                    _ => false,
                }
            };
            if !removed {
                continue;
            }
            tracing::info!(%thread_id, agents = quiet, "closing a retained session whose background agents went quiet");
            let minutes = RETAINED_QUIET_LIMIT.as_secs() / 60;
            self.interrupt_runtime_tasks(thread_id, &live, &format!("Stopped after {minutes} minutes without progress.")).await;
            live.mark_released();
            self.revoke_native_session(&live);
            if let Err(error) = live.session.close().await {
                tracing::debug!(%thread_id, %error, "closing a quiet retained session failed");
            }
            self.emit(
                thread_id,
                None,
                EventPayload::ProviderNotice {
                    level: NoticeLevel::Warning,
                    text: format!(
                        "Kybern stopped background agents from this thread's earlier session: they sent nothing for {minutes} minutes. Ask again if you still need their work."
                    ),
                    data: None,
                    problem: None,
                },
            )?;
        }
        Ok(())
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
            missing_conversation_id(claude, "warning: slow start\nNo conversation found with session ID: abc.\nmore"),
            Some(Some("abc".to_string()))
        );
        assert_eq!(
            missing_conversation_id(claude, "hook failed; No conversation found with session ID: abc"),
            Some(Some("abc".to_string()))
        );
        assert_eq!(missing_conversation_id(claude, "No conversation found with session ID"), Some(None));
        assert_eq!(missing_conversation_id(claude, "exit code 1"), None);
        assert_eq!(missing_conversation_id(ProviderKind::Codex, "No conversation found with session ID: x"), None);
    }

    /// The phrase quoted inside other text (a subagent's message, a tool's output) is not Claude Code's answer.
    #[test]
    fn the_phrase_inside_other_text_is_not_the_answer() {
        let claude = ProviderKind::ClaudeCode;
        assert_eq!(missing_conversation_id(claude, "The subagent said: No conversation found with session ID: abc"), None);
        assert_eq!(missing_conversation_id(claude, "grep matched \"No conversation found with session ID: abc\""), None);
    }
}
