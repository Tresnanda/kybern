//! Next-message targets, native continuation bindings, and intact portable deltas.
use super::*;
use anyhow::ensure;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Serialize, Deserialize)]
struct Binding {
    session_id: Option<String>,
    /// Account native storage/config identity, including profile environment.
    environment_fingerprint: String,
    through: EventSeq,
}

impl Orchestrator {
    pub(super) async fn session_admission(&self, thread_id: ThreadId) -> Arc<Mutex<()>> {
        self.inner.session_admission.lock().await.entry(thread_id).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
    }

    pub(super) fn stored_target(&self, thread: &Thread) -> Result<Option<SessionTarget>> {
        self.inner
            .store
            .meta_get(&format!("target:{}", thread.id))?
            .filter(|s| !s.is_empty())
            .map(|s| serde_json::from_str(&s).map_err(Into::into))
            .transpose()
    }

    pub fn thread_target(&self, thread_id: ThreadId) -> Result<methods::ThreadTargetState> {
        let thread = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("Thread not found."))?;
        let stored = self.stored_target(&thread)?;
        let override_id = self.inner.store.meta_get(&format!("account_override:{}", thread.id))?.filter(|s| !s.is_empty());
        let mut target = stored.unwrap_or(SessionTarget {
            provider: thread.provider.clone(),
            model: thread.model.clone(),
            effort: thread.effort.clone(),
        });
        let settings = self.inner.settings.get();
        let provider = settings.providers.get(&target.provider.kind).cloned().unwrap_or_default();
        let project = self.inner.store.project_get(thread.project_id)?.ok_or_else(|| anyhow!("Project not found."))?;
        target.provider.instance = crate::provider_accounts::resolve(&provider, Some(&project.path), override_id.as_deref());
        crate::provider_accounts::environment(&provider, target.provider.kind, &target.provider.instance)?;
        let pending_permission_mode = self
            .inner
            .store
            .meta_get(&format!("pending_permission:{}", thread.id))?
            .filter(|s| !s.is_empty())
            .map(|s| serde_json::from_str(&s))
            .transpose()?;
        Ok(methods::ThreadTargetState {
            target,
            account_override: override_id.is_some(),
            effective_permission_mode: thread.permission_mode,
            pending_permission_mode,
        })
    }

    pub async fn set_thread_target(&self, params: methods::ThreadTargetParams) -> Result<methods::ThreadTargetState> {
        self.ensure_not_subagent(params.thread_id)?;
        let thread = self.inner.store.thread_get(params.thread_id)?.ok_or_else(|| anyhow!("Thread not found."))?;
        self.validate_provider_selection(
            thread.project_id,
            &params.target.provider,
            params.target.model.as_deref(),
            params.target.effort.as_deref(),
        )
        .await?;
        let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
        let target_key = format!("target:{}", thread.id);
        let override_key = format!("account_override:{}", thread.id);
        let target_json = serde_json::to_string(&params.target)?;
        self.inner.store.meta_set_many(&[
            (&target_key, &target_json),
            (&override_key, if params.inherit_account { "" } else { &params.target.provider.instance }),
        ])?;
        self.thread_target(thread.id)
    }

    pub(super) fn account_environment(&self, thread: &Thread) -> Result<std::collections::BTreeMap<String, String>> {
        let settings = self.inner.settings.get();
        let project = self.inner.store.project_get(thread.project_id)?.ok_or_else(|| anyhow!("Project not found."))?;
        let mut provider = settings.providers.get(&thread.provider.kind).cloned().unwrap_or_default();
        if thread.provider.kind == ProviderKind::Omp
            && let Some(profile) = provider.project_profiles.get(&project.path).cloned()
        {
            provider.env.insert("OMP_PROFILE".into(), profile);
        }
        crate::provider_accounts::environment(&provider, thread.provider.kind, &thread.provider.instance)
    }

    pub(super) async fn native_runtime_task(&self, live: &LiveSession, task: &RuntimeTask) -> RuntimeTask {
        let mut native = task.clone();
        if let Some(raw) = live.task_aliases.lock().await.iter().find_map(|(raw, public)| (public == &task.id).then_some(raw.clone())) {
            native.id = raw;
        }
        native
    }

    pub(super) async fn task_session(&self, thread_id: ThreadId, task_id: &str) -> Result<Arc<LiveSession>> {
        let current = self.inner.sessions.lock().await.get(&thread_id).cloned();
        if let Some(live) = current
            && live.tasks.lock().await.contains_key(task_id)
        {
            return Ok(live);
        }
        let retained = self
            .inner
            .retained_sessions
            .lock()
            .await
            .iter()
            .filter(|((owner, _), _)| *owner == thread_id)
            .map(|(_, (_, live))| live.clone())
            .collect::<Vec<_>>();
        for live in retained {
            if live.tasks.lock().await.contains_key(task_id) {
                return Ok(live);
            }
        }
        Err(anyhow!("This task no longer has a live provider session."))
    }

    pub(super) async fn retire_or_close_session(&self, thread_id: ThreadId, live: Arc<LiveSession>, identity: String) -> Result<()> {
        let reusable = live.tasks.lock().await.values().any(|task| {
            task.status.is_active() && task.backgrounded && matches!(task.kind, RuntimeTaskKind::Process | RuntimeTaskKind::Monitor)
        });
        if reusable {
            let owner =
                self.inner.store.meta_get(&format!("live_owner:{thread_id}"))?.map(|s| serde_json::from_str(&s)).transpose()?.ok_or_else(
                    || anyhow!("The outgoing background session has no account identity. Stop its background work before switching."),
                )?;
            live.retained.store(true, Ordering::Relaxed);
            self.inner.sessions.lock().await.remove(&thread_id);
            self.inner.retained_sessions.lock().await.insert((thread_id, identity), (owner, live));
        } else {
            live.mark_released();
            self.revoke_native_session(&live);
            live.session.close().await?;
            self.inner.sessions.lock().await.remove(&thread_id);
        }
        Ok(())
    }

    pub(super) async fn close_retained_sessions(&self, thread_id: ThreadId) -> Result<()> {
        let owners = self.inner.retained_sessions.lock().await.keys().filter(|(owner, _)| *owner == thread_id).cloned().collect::<Vec<_>>();
        for owner in owners {
            let removed = { self.inner.retained_sessions.lock().await.remove(&owner) };
            if let Some((_, live)) = removed {
                live.mark_released();
                self.revoke_native_session(&live);
                live.session.close().await?;
            }
        }
        Ok(())
    }

    pub(super) async fn handle_retained_event(&self, thread_id: ThreadId, live: &Arc<LiveSession>, event: DriverEvent) -> Result<()> {
        match event {
            DriverEvent::RuntimeTaskUpdated(update) => {
                self.apply_runtime_task_update(thread_id, live, update, RuntimeTaskUpdateKind::Progress).await?;
            }
            DriverEvent::RuntimeTaskResumed(update) => {
                self.apply_runtime_task_update(thread_id, live, update, RuntimeTaskUpdateKind::Resume).await?;
            }
            DriverEvent::RuntimeTaskCompleted(update) => {
                self.apply_runtime_task_update(thread_id, live, update, RuntimeTaskUpdateKind::Complete).await?;
            }
            DriverEvent::PermissionRequest { request_id, .. } => {
                live.session
                    .respond_permission(
                        &request_id,
                        &ApprovalDecision::Deny {
                            reason: Some(
                                "The foreground conversation switched accounts. Background work cannot request new permission.".into(),
                            ),
                        },
                    )
                    .await?;
            }
            // The process owns its original native state; no outgoing root prose,
            // tool mutation, authentication report or completion affects the receiver.
            _ => {}
        }
        if !live.tasks.lock().await.values().any(|task| task.status.is_active()) {
            self.inner.retained_sessions.lock().await.retain(|_, (_, owner)| !Arc::ptr_eq(owner, live));
            live.mark_released();
            self.revoke_native_session(live);
            live.session.close().await?;
        }
        Ok(())
    }

    pub(super) fn environment_fingerprint(&self, thread: &Thread) -> Result<String> {
        let bytes = Sha256::digest(serde_json::to_vec(&self.account_environment(thread)?)?);
        Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
    }

    pub(super) fn session_identity(&self, thread: &Thread) -> Result<String> {
        let bytes = Sha256::digest(serde_json::to_vec(&(
            thread.provider.clone(),
            thread.model.clone(),
            thread.effort.clone(),
            thread.permission_mode,
            self.environment_fingerprint(thread)?,
        ))?);
        Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
    }

    pub(super) fn binding_key(thread: &Thread) -> String {
        format!("native_binding:{}:{}:{}", thread.id, thread.provider.kind, thread.provider.instance)
    }

    pub(super) fn save_account_binding(&self, thread: &Thread) -> Result<()> {
        let binding = Binding {
            session_id: thread.provider_session_id.clone(),
            environment_fingerprint: self.environment_fingerprint(thread)?,
            through: thread.last_seq,
        };
        self.inner.store.meta_set(&Self::binding_key(thread), &serde_json::to_string(&binding)?)
    }

    /// Called under the send admission gate, before appending the user's intent.
    pub(super) fn admit_target(&self, thread: &mut Thread, target: SessionTarget) -> Result<()> {
        let provider_changed = thread.provider != target.provider;
        let model_changed = thread.model != target.model || thread.effort != target.effort;
        if !provider_changed && !model_changed {
            return Ok(());
        }
        // A target selection never grants additional authority. Validate the effective
        // mode for the receiving native binding before writing any transition state.
        let mut receiving = thread.clone();
        receiving.provider = target.provider.clone();
        if provider_changed {
            receiving.provider_session_id = None;
        }
        validate_permission(&receiving, receiving.permission_mode)?;
        self.save_account_binding(thread)?;
        let previous = thread.provider.clone();
        thread.provider = target.provider;
        thread.model = target.model;
        thread.effort = target.effort;
        if provider_changed {
            let binding =
                self.inner.store.meta_get(&Self::binding_key(thread))?.map(|s| serde_json::from_str::<Binding>(&s)).transpose()?;
            let fingerprint = self.environment_fingerprint(thread)?;
            let compatible = binding.filter(|binding| binding.environment_fingerprint == fingerprint);
            let after = compatible.as_ref().map_or(0, |binding| binding.through);
            thread.provider_session_id = compatible.and_then(|binding| binding.session_id);
            // The provider receives only a saved, attributed delta. The UI keeps its original messages.
            self.inner.store.meta_set(&format!("handoff:{}", thread.id), &serde_json::to_string(&(after, thread.last_seq))?)?;
            self.emit(
                thread.id,
                None,
                EventPayload::SessionTransitioned {
                    from: previous,
                    to: thread.provider.clone(),
                    native_resume: thread.provider_session_id.is_some(),
                    text: format!(
                        "Using {} · {}. {} Conversation and workspace stay in this thread.",
                        thread.provider.kind.display_name(),
                        thread.provider.instance,
                        if thread.provider_session_id.is_some() {
                            "Resuming this account's native session with the conversation it missed."
                        } else {
                            "Starting a native session with portable conversation context."
                        }
                    ),
                },
            )?;
        }
        Ok(())
    }

    pub(super) fn portable_message(&self, thread: &Thread, message: &UserMessage) -> Result<UserMessage> {
        let Some(range) = self.inner.store.meta_get(&format!("handoff:{}", thread.id))?.filter(|s| !s.is_empty()) else {
            return Ok(message.clone());
        };
        let (after, through): (EventSeq, EventSeq) = serde_json::from_str(&range)?;
        let events = self.inner.store.events_for_thread(thread.id)?;
        let entries = kybern_store::project_transcript(&events.iter().filter(|event| event.seq <= through).cloned().collect::<Vec<_>>());
        let mut items = Vec::new();
        for entry in entries {
            let item = match entry {
                TranscriptEntry::User { seq, turn_id, message, .. } if seq > after => Some((seq, turn_id, "User", message.plain_text())),
                TranscriptEntry::Assistant { seq, turn_id, origin: EventOrigin::Root, text, .. } if seq > after && !text.is_empty() => {
                    Some((seq, turn_id, "Assistant", text))
                }
                _ => None,
            };
            if let Some((seq, turn_id, role, text)) = item {
                let source = self.inner.store.meta_get(&format!("turn_target:{turn_id}"))?.unwrap_or_else(|| "previous session".into());
                items.push(format!("[{role}; sequence {seq}; target {source}]\n{text}\n"));
            }
        }
        let mut copy = message.clone();
        if !items.is_empty() {
            let attachment_reserve =
                message.parts.iter().filter(|part| !matches!(part, ContentPart::Text { .. })).count().saturating_mul(8192);
            let remaining = 128_000usize.saturating_sub(32_000 + message.plain_text().len() + attachment_reserve);
            ensure!(
                remaining >= 1024,
                "The target has too little estimated capacity for portable context. Compact the conversation or choose a larger-context model before trying again."
            );
            let text = bounded_context(thread.id, &items, remaining.min(16_000));
            copy.parts.insert(0, ContentPart::Text { text });
        }
        Ok(copy)
    }

    pub async fn update_session_fields(&self, mut params: methods::ThreadsUpdateParams) -> Result<Thread> {
        self.ensure_not_subagent(params.thread_id)?;
        let thread = self.inner.store.thread_get(params.thread_id)?.ok_or_else(|| anyhow!("Thread not found."))?;
        if params.model.is_some() || params.effort.is_some() {
            let mut target = self.thread_target(thread.id)?.target;
            if let Some(model) = params.model.take() {
                target.model = (!model.is_empty()).then_some(model);
            }
            if let Some(effort) = params.effort.take() {
                target.effort = (!effort.is_empty()).then_some(effort);
            }
            self.set_thread_target(methods::ThreadTargetParams {
                thread_id: thread.id,
                target,
                inherit_account: !self.thread_target(thread.id)?.account_override,
            })
            .await?;
        }
        if let Some(mode) = params.permission_mode.take() {
            validate_permission(&thread, mode)?;
            let mut receiving = thread.clone();
            receiving.provider = self.thread_target(thread.id)?.target.provider;
            if receiving.provider != thread.provider {
                receiving.provider_session_id = None;
            }
            validate_permission(&receiving, mode)?;
            let _workspace = self.inner.workspace_ops.lock().await;
            let gate = self.session_admission(thread.id).await;
            let _admission = gate.lock().await;
            let current = self.inner.store.thread_get(thread.id)?.ok_or_else(|| anyhow!("Thread not found."))?;
            if matches!(current.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval) {
                self.inner.store.meta_set(&format!("pending_permission:{}", thread.id), &serde_json::to_string(&mode)?)?;
            } else {
                self.apply_permission_admitted(thread.id, mode).await?;
            }
        }
        self.update_thread_fields(params)
    }

    async fn apply_permission(&self, thread_id: ThreadId, mode: PermissionMode) -> Result<Thread> {
        let _workspace = self.inner.workspace_ops.lock().await;
        let gate = self.session_admission(thread_id).await;
        let _admission = gate.lock().await;
        self.apply_permission_admitted(thread_id, mode).await
    }

    pub(super) async fn apply_permission_admitted(&self, thread_id: ThreadId, mode: PermissionMode) -> Result<Thread> {
        let mut thread = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("Thread not found."))?;
        ensure!(
            !matches!(thread.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval),
            "Permission change is waiting for the active turn. Stop and apply now, or wait for it to finish."
        );
        validate_permission(&thread, mode)?;
        let live = self.inner.sessions.lock().await.get(&thread_id).cloned();
        if let Some(live) = live {
            // Claude bypassPermissions is a process launch flag. Restart/resume instead of persisting a rejected mode.
            if thread.provider.kind == ProviderKind::ClaudeCode
                && (mode == PermissionMode::FullAccess || thread.permission_mode == PermissionMode::FullAccess)
            {
                let mut desired = thread.clone();
                desired.permission_mode = mode;
                live.mark_released();
                self.revoke_native_session(&live);
                live.session.close().await?;
                self.inner.sessions.lock().await.remove(&thread_id);
                if let Err(error) = self.spawn_session(&desired, None).await {
                    return Err(error);
                }
            } else {
                live.session.set_permission_mode(mode).await?;
            }
        }
        thread.permission_mode = mode;
        self.inner.store.meta_set(&format!("pending_permission:{}", thread_id), "")?;
        self.update_thread(thread)
    }

    pub fn apply_pending_permission(&self, thread_id: ThreadId, stop_now: bool) -> futures::future::BoxFuture<'_, Result<Thread>> {
        Box::pin(async move {
            self.ensure_not_subagent(thread_id)?;
            let state = self.thread_target(thread_id)?;
            let thread = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("Thread not found."))?;
            let Some(mode) = state.pending_permission_mode else { return Ok(thread) };
            if matches!(thread.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval) {
                ensure!(stop_now, "Permission change is waiting for this turn to finish.");
                self.interrupt(thread_id).await?;
                for _ in 0..100 {
                    if self
                        .inner
                        .store
                        .thread_get(thread_id)?
                        .is_none_or(|t| !matches!(t.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval))
                    {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                ensure!(
                    self.inner
                        .store
                        .thread_get(thread_id)?
                        .is_some_and(|t| !matches!(t.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval)),
                    "The agent is still stopping. Try Apply again when it stops."
                );
            }
            self.apply_permission(thread_id, mode).await
        })
    }

    pub async fn switch_continue(&self, params: methods::ThreadsSwitchContinueParams) -> Result<methods::ThreadsSendResult> {
        if let Some((owner, turn_id, _)) = self.inner.store.turn_started_receipt(params.message_id)? {
            ensure!(owner == params.thread_id, "Continuation id belongs to another thread.");
            return Ok(methods::ThreadsSendResult { turn_id, message_id: params.message_id });
        }
        let thread = self.inner.store.thread_get(params.thread_id)?.ok_or_else(|| anyhow!("Thread not found."))?;
        let events = self.inner.store.events_for_thread(thread.id)?;
        let error = events
            .iter()
            .rev()
            .find_map(|event| match &event.payload {
                EventPayload::TurnFailed { error } => Some(error.as_str()),
                _ => None,
            })
            .ok_or_else(|| anyhow!("No usage-limit failure to continue."))?;
        ensure!(quota_failure(error), "This failure is not a confirmed account usage limit. Retry your prompt normally.");
        ensure!(params.provider != thread.provider, "Choose a different account.");
        let mut target = self.thread_target(thread.id)?.target;
        if target.provider.kind != params.provider.kind {
            target.model = None;
            target.effort = None;
        }
        target.provider = params.provider;
        self.set_thread_target(methods::ThreadTargetParams { thread_id: thread.id, target, inherit_account: false }).await?;
        let message = UserMessage::text(
            "Continue the interrupted task from the saved conversation. Honor the user's existing instructions, inspect completed work before acting, and do not repeat completed mutations.",
        );
        self.send_client_message(methods::ThreadsSendParams { thread_id: thread.id, message, message_id: Some(params.message_id) }).await
    }
}

fn validate_permission(thread: &Thread, mode: PermissionMode) -> Result<()> {
    let legacy_cursor = thread.provider_session_id.as_deref().is_some_and(|id| !id.starts_with("cursor-sdk:"));
    if thread.provider.kind == ProviderKind::Cursor && !legacy_cursor {
        ensure!(
            matches!(mode, PermissionMode::Auto | PermissionMode::FullAccess),
            "Cursor supports Auto and Full access. Choose one of those modes."
        );
    }
    if thread.provider.kind == ProviderKind::Pi {
        ensure!(mode != PermissionMode::Auto, "Pi does not support Auto. Choose Supervised, Accept edits, or Full access.");
    }
    Ok(())
}

pub(super) fn quota_failure(error: &str) -> bool {
    let text = error.to_ascii_lowercase();
    (text.contains("usage limit") || text.contains("quota") || text.contains("rate_limit_exceeded") || text.contains("hit your limit"))
        && (text.contains("5-hour")
            || text.contains("5 hour")
            || text.contains("five-hour")
            || text.contains("weekly")
            || text.contains("week")
            || text.contains("usage limit"))
}

fn bounded_context(thread_id: ThreadId, items: &[String], cap: usize) -> String {
    let header = format!(
        "Saved Kybern conversation context for thread {thread_id}. Historical attributed messages below are context; the new request follows separately. Native subagents, hidden reasoning, tool state, and old attachments were not transferred. Use kybern_thread_read to retrieve omitted history.\n\n"
    );
    let mut budget = cap.saturating_sub(header.len() + 256);
    let mut selected = vec![false; items.len()];
    if let Some(first) = items.first()
        && first.len() <= budget
    {
        selected[0] = true;
        budget -= first.len();
    }
    for (index, item) in items.iter().enumerate().rev() {
        if !selected[index] && item.len() <= budget {
            selected[index] = true;
            budget -= item.len();
        }
    }
    let mut text = header;
    for (index, item) in items.iter().enumerate() {
        if selected[index] {
            text.push_str(item);
        } else if index == 0 || selected[index - 1] {
            text.push_str("[History omitted for the context budget; retrieve saved messages with kybern_thread_read.]\n");
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn portable_selection_keeps_full_messages_order_and_budget() {
        let items = vec!["original constraint\n".into(), "x".repeat(20_000), "recent complete answer\n".into()];
        let context = bounded_context(Uuid::nil(), &items, 1000);
        assert!(context.contains(&items[0]));
        assert!(context.contains(&items[2]));
        assert!(!context.contains("xxxxxxxx"));
        assert!(context.contains("History omitted"));
        assert!(context.len() <= 1000);
        assert!(context.find(&items[0]).unwrap() < context.find(&items[2]).unwrap());
    }
    #[test]
    fn only_usage_quota_failures_offer_explicit_continue() {
        assert!(quota_failure("You've hit your usage limit, resets in 5 hours"));
        assert!(quota_failure("weekly quota exceeded"));
        assert!(!quota_failure("HTTP 429 service busy"));
        assert!(!quota_failure("authentication failed"));
    }
}
