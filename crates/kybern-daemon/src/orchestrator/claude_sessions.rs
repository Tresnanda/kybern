//! Keeping a Claude Code session when its conversation or its target changes.
//!
//! * [`Orchestrator::switch_live_target`]: a new model or effort is applied to the running process
//!   (`set_model`, `apply_flag_settings`) instead of restarting it, so background subagents keep running.
//!   A process that refuses keeps the restart.
//! * [`Orchestrator::plan_missing_conversation`]: Claude Code no longer has the conversation a session
//!   resumes (`No conversation found with session ID`). Kybern forgets the id, hands a fresh session the
//!   conversation so far and sends the user's message once more, through the resend guard (`resend.rs`) that
//!   lets a Stop between the two sessions end the turn instead.
//! * Retained sessions (any harness, kept for their background work): a background agent's result is shown
//!   in the thread, and one that stays quiet for [`RETAINED_QUIET_LIMIT`] is stopped.

use super::*;

/// How long a retired session kept only for background agents may go without a word from them. Agents
/// that never report would otherwise keep a whole harness process until the thread is deleted.
pub(super) const RETAINED_QUIET_LIMIT: Duration = Duration::from_secs(30 * 60);

/// The longest result of a retained agent the thread shows, in characters; its own thread has all of it.
pub(super) const RETAINED_RESULT_CHARS: usize = 2000;

/// `text` trimmed and cut at `chars` characters, with an ellipsis when it was cut.
fn capped(text: &str, chars: usize) -> String {
    let text = text.trim();
    match text.char_indices().nth(chars) {
        Some((end, _)) => format!("{}…", text[..end].trim_end()),
        None => text.to_string(),
    }
}

/// Why background work ends when Claude Code exits while changing model or effort.
const EXITED_WHILE_SWITCHING: &str = "Stopped because Claude Code exited while changing its model or effort.";

/// How long closing a quiet retained session may take before Kybern stops waiting for it.
const RETAINED_CLOSE_LIMIT: Duration = Duration::from_secs(30);

/// The last session id Kybern forgot because Claude Code no longer had its conversation.
fn forgotten_key(thread_id: ThreadId) -> String {
    format!("forgotten_session:{thread_id}")
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
                if matches!(error, kybern_drivers::DriverError::ProcessExited(_)) {
                    // Not a refusal: the process is gone, and there is nothing to keep.
                    self.close_unknown_target(thread.id, live, EXITED_WHILE_SWITCHING).await;
                }
                return Ok(false);
            }
        }
        if let Some(level) = thread.effort.as_deref().filter(|_| thread.effort != effort)
            && let Err(error) = live.session.set_effort(level).await
        {
            tracing::info!(thread_id = %thread.id, %error, "Claude Code refused the effort change; restarting its session");
            if matches!(error, kybern_drivers::DriverError::ProcessExited(_)) {
                self.close_unknown_target(thread.id, live, EXITED_WHILE_SWITCHING).await;
                return Ok(false);
            }
            // The caller may keep this process for its background work under the identity it had: it must
            // run that identity's model again, or be closed.
            if model_switched && let Err(error) = live.session.set_model(model.as_deref().unwrap_or("default")).await {
                tracing::warn!(thread_id = %thread.id, %error, "Claude Code could not switch back to its model; closing its session");
                self.close_unknown_target(thread.id, live, "Stopped because Claude Code couldn't switch back to its model.").await;
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

    /// A live process whose model Kybern no longer knows, or that exited: close it, background work included
    /// (`detail` says why), so nothing reuses it under an identity it does not have.
    async fn close_unknown_target(&self, thread_id: ThreadId, live: &Arc<LiveSession>, detail: &str) {
        {
            let mut sessions = self.inner.sessions.lock().await;
            if sessions.get(&thread_id).is_some_and(|current| Arc::ptr_eq(current, live)) {
                sessions.remove(&thread_id);
            }
        }
        live.mark_released();
        self.revoke_native_session(live);
        self.interrupt_runtime_tasks(thread_id, live, detail).await;
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
    /// the dead session and, once per turn, plan to send the same message to a fresh one with the conversation
    /// so far. Call while holding `live.turn` (the guard is registered before Stop can see no turn), then
    /// [`Orchestrator::run_resend`] once it is released. `None`: the turn is not taken over. `exited`: the
    /// event pump already released `live`.
    pub(super) fn plan_missing_conversation(
        &self,
        thread_id: ThreadId,
        live: &Arc<LiveSession>,
        turn_id: TurnId,
        cause: &str,
        exited: bool,
    ) -> Option<resend::PlannedResend> {
        let thread = self.inner.store.thread_get(thread_id).ok().flatten()?;
        // A result's error is Claude Code's own answer; an exit's stderr tail must name this session.
        let dead = if exited {
            Some(missing_conversation_on_exit(&thread, cause)?)
        } else {
            missing_conversation_id(thread.provider.kind, cause)?
        };
        if (!exited && live.is_released()) || thread.status == ThreadStatus::Archived {
            return None;
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
            Ok(false) => return None,
            Err(error) => {
                tracing::warn!(%thread_id, %error, "could not forget the missing Claude conversation");
                return None;
            }
        }
        let retried = self.inner.store.meta_get(&retry_key).ok().flatten().is_some();
        let (message_id, mut message) = started.filter(|_| !retried)?;
        self.inner.store.meta_set(&retry_key, "1").ok()?;
        // The stored prompt holds large images as references (#298); the agent gets them inline again.
        self.resolve_attachments(&mut message);
        let guard = self.begin_resend(thread_id, turn_id, resend::ResendReason::MissingConversation);
        Some(resend::PlannedResend { guard, message_id, message, login: None })
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
    /// thread shows it; the agent's own thread keeps the whole conversation. A failure is a plain sentence
    /// with the harness's error behind Show details; a result is cut at [`RETAINED_RESULT_CHARS`].
    pub(super) fn report_retained_agent(&self, thread_id: ThreadId, task: &RuntimeTask) {
        if task.kind != RuntimeTaskKind::Agent || task.status.is_active() {
            return;
        }
        let name = if task.title.trim().is_empty() { "A background agent".to_string() } else { format!("“{}”", task.title.trim()) };
        let data = Some(serde_json::json!({ "retained_task": task.id }));
        let (level, text, problem) = if task.status == RuntimeTaskStatus::Failed {
            let problem = task
                .detail
                .as_deref()
                .map(str::trim)
                .filter(|detail| !detail.is_empty())
                .map(|detail| kybern_protocol::rpc::Problem::new(kybern_protocol::rpc::ProblemKind::Internal, detail));
            let text = format!("{name} failed in the session this thread had before. Its own thread shows how far it got.");
            (NoticeLevel::Warning, text, problem)
        } else {
            let ended =
                if matches!(task.status, RuntimeTaskStatus::Stopped | RuntimeTaskStatus::Interrupted) { "stopped" } else { "finished" };
            let result = self.subagent_result(thread_id, &task.id).or_else(|| task.detail.clone()).filter(|text| !text.trim().is_empty());
            let text = match result {
                Some(result) => format!(
                    "{name} {ended} in the session this thread had before. The agent here didn't get its result:\n\n{}",
                    capped(&result, RETAINED_RESULT_CHARS)
                ),
                None => format!("{name} {ended} in the session this thread had before. Its result is in its own thread."),
            };
            (NoticeLevel::Info, text, None)
        };
        if let Err(error) = self.emit(thread_id, None, EventPayload::ProviderNotice { level, text, data, problem }) {
            tracing::warn!(%thread_id, %error, "could not show a retained agent's result");
        }
    }

    /// Close retained sessions kept only for background agents that sent nothing for `RETAINED_QUIET_LIMIT`.
    /// A session that also runs a process or monitor (a dev server) is the person's to stop. Quiet time is
    /// monotonic (`now` against the last event's `Instant`), so time a laptop spent asleep doesn't count: the
    /// agents could not have reported then. Closing runs in the background, bounded by
    /// [`RETAINED_CLOSE_LIMIT`], so a process that never closes can't hold up the idle sweep.
    pub(super) async fn close_quiet_retained_sessions(&self, now: Instant) {
        let retained =
            self.inner.retained_sessions.lock().await.iter().map(|(key, (_, live))| (key.clone(), live.clone())).collect::<Vec<_>>();
        for ((thread_id, identity), live) in retained {
            let (agents_only, quiet) = {
                let tasks = live.tasks.lock().await;
                let active = tasks.values().filter(|task| task.status.is_active()).collect::<Vec<_>>();
                (!active.is_empty() && active.iter().all(|task| task.kind == RuntimeTaskKind::Agent), active.len())
            };
            if !agents_only || now.saturating_duration_since(live.last_activity().monotonic) < RETAINED_QUIET_LIMIT {
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
            tokio::spawn(async move {
                match tokio::time::timeout(RETAINED_CLOSE_LIMIT, live.session.close()).await {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => tracing::debug!(%thread_id, %error, "closing a quiet retained session failed"),
                    Err(_) => tracing::warn!(%thread_id, "a quiet retained session did not close in time"),
                }
            });
            if let Err(error) = self.emit(
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
            ) {
                tracing::warn!(%thread_id, %error, "could not tell the thread its quiet background agents were stopped");
            }
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
