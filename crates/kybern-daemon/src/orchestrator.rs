//! Owns live provider sessions and turns their events into the persisted,
//! broadcast thread log.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime};

use anyhow::{Context, Result, anyhow};
use chrono::Utc;
use kybern_drivers::registry::DriverRegistry;
use kybern_drivers::{
    AgentSession, DriverEvent, DriverRuntimeTask, DriverRuntimeTaskUpdate, RewindPoint, SessionConfig, SpawnedSession, TurnAnchors,
};
use kybern_git::{Repo, checkpoint_ref};
use kybern_protocol::*;
use kybern_store::{Store, TurnUsageRow};
use tokio::sync::{Mutex, Notify, Semaphore};
use uuid::Uuid;

use crate::config::Paths;
use crate::settings::SettingsStore;

#[derive(Clone)]
pub struct Orchestrator {
    inner: Arc<Inner>,
}

/// Keep the task's constraints and current plan ahead of archived worker reports.
/// Reports stay in durable context and are fetched selectively by key when needed.
fn assignment_shared_context(mut context: Vec<ContextEntry>) -> String {
    context.sort_by_key(|entry| {
        let priority = if entry.user_authored {
            0
        } else {
            match entry.kind {
                ContextEntryKind::Brief | ContextEntryKind::Instruction | ContextEntryKind::Plan => 1,
                _ if entry.key == "project.setup" => 2,
                ContextEntryKind::Decision => 3,
                ContextEntryKind::Research => 4,
                ContextEntryKind::ResultReference => 5,
            }
        };
        (priority, entry.key.clone())
    });
    let mut shared = String::new();
    let mut omitted = 0usize;
    let mut reports = 0usize;
    for entry in context {
        if !entry.user_authored && entry.kind == ContextEntryKind::ResultReference {
            reports += 1;
            continue;
        }
        let author = entry.author_thread_id.map_or_else(|| "user".into(), |id| format!("thread:{id}"));
        let mut line = format!(
            "\n- [{} {:?} r{} author={author} sources={}] {}",
            entry.key,
            entry.kind,
            entry.revision,
            entry.source_refs.join(","),
            entry.body
        );
        truncate_utf8(&mut line, 8 * 1024);
        if shared.len() + line.len() > 16 * 1024 {
            omitted += 1;
            continue;
        }
        shared.push_str(&line);
    }
    if reports > 0 {
        shared.push_str(&format!("\n- [{reports} archived result reports available through kybern_collaboration_context_read; retrieve only reports relevant to this assignment]"));
    }
    if omitted > 0 {
        shared.push_str(&format!(
            "\n- [{omitted} context entries omitted by prompt byte limit; use kybern_collaboration_context_read for selective retrieval]"
        ));
    }
    shared
}

impl Orchestrator {
    fn supports_dedicated_coordinator(kind: ProviderKind) -> bool {
        matches!(kind, ProviderKind::ClaudeCode | ProviderKind::Opencode | ProviderKind::Pi | ProviderKind::Omp)
    }

    pub(crate) fn provider_catalog_cache(&self) -> Arc<crate::state::ProviderCatalogCache> {
        self.inner.provider_catalogs.clone()
    }

    async fn cached_provider_statuses(&self, project_id: ProjectId) -> Result<Option<Vec<ProviderStatus>>> {
        let project = self.inner.store.project_get(project_id)?.ok_or_else(|| anyhow!("project not found"))?;
        let cwd = PathBuf::from(project.path);
        let settings = self.inner.settings.get();
        let cache_key = serde_json::to_string(&(Some(project_id), Some(&cwd), &settings.providers))?;
        Ok(self.inner.provider_catalogs.get_if_fresh(&cache_key).await)
    }

    async fn refresh_provider_statuses(&self, project_id: ProjectId) -> Result<Vec<ProviderStatus>> {
        let project = self.inner.store.project_get(project_id)?.ok_or_else(|| anyhow!("project not found"))?;
        let cwd = PathBuf::from(project.path);
        let settings = self.inner.settings.get();
        let cache_key = serde_json::to_string(&(Some(project_id), Some(&cwd), &settings.providers))?;
        let drivers = self.inner.drivers.clone();
        Ok(self
            .inner
            .provider_catalogs
            .get_or_refresh(cache_key, false, || async move {
                let probes = ProviderKind::ALL.into_iter().map(|kind| {
                    let driver = drivers.get(kind);
                    let provider_settings = settings.providers.get(&kind).cloned().unwrap_or_default();
                    let context = kybern_drivers::ProbeContext {
                        binary: provider_settings.binary.map(PathBuf::from),
                        cwd: Some(cwd.clone()),
                        env: provider_settings.env,
                    };
                    async move {
                        match driver {
                            Some(driver) => driver.probe_with_context(&context).await,
                            None => ProviderStatus {
                                kind,
                                display_name: kind.display_name().to_string(),
                                available: false,
                                binary_path: None,
                                version: None,
                                unavailable_reason: Some("driver not implemented yet".into()),
                                supported_permission_modes: vec![],
                                supports_fork: false,
                                supports_model_switch: false,
                                supports_effort_switch: false,
                                supported_efforts: vec![],
                                models: vec![],
                                instances: vec![],
                            },
                        }
                    }
                });
                futures::future::join_all(probes).await
            })
            .await)
    }

    async fn validate_provider_selection(
        &self,
        project_id: ProjectId,
        provider: &ProviderInstance,
        model: Option<&str>,
        effort: Option<&str>,
    ) -> Result<()> {
        if provider.instance != "default" {
            return Err(anyhow!(
                "Unknown {} provider instance '{}'. Available instances: default. Put the model selector in child.model.",
                provider.kind,
                provider.instance,
            ));
        }

        let Some(statuses) = self.cached_provider_statuses(project_id).await? else { return Ok(()) };
        let Some(status) = statuses.iter().find(|status| status.kind == provider.kind) else { return Ok(()) };
        let selected_model = model.filter(|model| !model.trim().is_empty());
        let catalog_model = selected_model.and_then(|selected| status.models.iter().find(|candidate| candidate.id == selected));
        if let (Some(catalog_model), Some(effort)) = (catalog_model, effort.filter(|effort| !effort.trim().is_empty())) {
            let supported = catalog_model.efforts.as_slice();
            let supported = if supported.is_empty() { status.supported_efforts.as_slice() } else { supported };
            if !supported.is_empty() && !supported.iter().any(|candidate| candidate == effort) {
                let choices = supported.iter().take(20).cloned().collect::<Vec<_>>().join(", ");
                return Err(anyhow!("Unknown effort '{}' for {}. Available efforts: {}.", effort, provider.kind, choices));
            }
        }
        Ok(())
    }

    fn validate_external_delivery_authority(&self, from_thread_id: ThreadId, to_thread_id: ThreadId) -> Result<()> {
        let actor = self.inner.store.thread_get(from_thread_id)?.ok_or_else(|| anyhow!("caller thread not found"))?;
        let recipient = self.inner.store.thread_get(to_thread_id)?.ok_or_else(|| anyhow!("recipient thread not found"))?;
        if actor.worktree.is_some() && recipient.worktree.is_none() {
            return Err(anyhow!(
                "an isolated worker cannot wake a main-checkout thread; return the result to its coordinator or ask the user to message that thread"
            ));
        }
        let permission_is_safe = actor.permission_mode == PermissionMode::FullAccess
            || recipient.permission_mode == PermissionMode::Supervised
            || (actor.provider.kind == recipient.provider.kind && actor.permission_mode == recipient.permission_mode);
        if !permission_is_safe {
            return Err(anyhow!(
                "recipient permission mode is not a conservative subset of the caller; ask the user to message that thread directly or lower its permission mode"
            ));
        }
        Ok(())
    }

    fn set_thread_relationships(
        &self,
        thread_id: ThreadId,
        parent_thread_id: Option<ThreadId>,
        coordinator_project_id: Option<ProjectId>,
        collaboration_group_id: Option<GroupId>,
    ) -> Result<Thread> {
        self.inner.store.thread_set_relationships(thread_id, parent_thread_id, coordinator_project_id, collaboration_group_id)?;
        let thread = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("thread disappeared while updating relationships"))?;
        self.update_thread(thread)
    }

    pub fn project_coordinator_get(&self, project_id: ProjectId) -> Result<Option<ProjectCoordinator>> {
        let Some((thread_id, group_id)) = self.inner.store.project_coordinator(project_id)? else { return Ok(None) };
        let thread = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("project coordinator thread is missing"))?;
        let group = self.inner.store.collaboration_group_get(group_id)?.ok_or_else(|| anyhow!("project coordinator group is missing"))?;
        Ok(Some(ProjectCoordinator { thread, group, created: false }))
    }

    pub async fn project_coordinator_get_or_create(
        &self,
        params: methods::CollaborationCoordinatorGetOrCreateParams,
    ) -> Result<ProjectCoordinator> {
        let initial_goal = params.initial_goal.as_deref().map(str::trim).filter(|goal| !goal.is_empty()).map(str::to_owned);
        if params.initial_goal.is_some() && initial_goal.is_none() {
            return Err(anyhow!("initial_goal must contain the user's project brief"));
        }
        if initial_goal.as_ref().is_some_and(|goal| goal.len() > 128 * 1024) {
            return Err(anyhow!("initial_goal must stay under 128 KiB"));
        }
        if let Some(receipt) =
            self.collaboration_receipt::<ProjectCoordinator>(params.operation_id, "human", "coordinator.get_or_create", &params)?
        {
            if self.inner.store.project_coordinator(params.project_id)?.map(|(id, _)| id) != Some(receipt.thread.id) {
                return Err(anyhow!("This coordinator was deleted. Start a new coordinator with a new request."));
            }
            return Ok(receipt);
        }
        let _collaboration_command = self.inner.collaboration_commands.lock().await;
        if let Some(receipt) =
            self.collaboration_receipt::<ProjectCoordinator>(params.operation_id, "human", "coordinator.get_or_create", &params)?
        {
            if self.inner.store.project_coordinator(params.project_id)?.map(|(id, _)| id) != Some(receipt.thread.id) {
                return Err(anyhow!("This coordinator was deleted. Start a new coordinator with a new request."));
            }
            return Ok(receipt);
        }
        if let Some(mut existing) = self.project_coordinator_get(params.project_id)? {
            if matches!(existing.group.status, GroupStatus::Stopped | GroupStatus::Completed) {
                let control = methods::CollaborationGroupsControlParams {
                    operation_id: derived_operation_id(params.operation_id, 0x43),
                    group_id: existing.group.id,
                    action: methods::CollaborationGroupControlAction::Resume,
                };
                existing.group.status = GroupStatus::Active;
                existing.group.revision += 1;
                existing.group.updated_at = Utc::now();
                let (group, events) = self.inner.store.collaboration_group_control_operation(
                    control.operation_id,
                    "human",
                    &control,
                    &existing.group,
                    &[],
                    &[],
                )?;
                self.broadcast_committed_collaboration(events);
                existing.group = group;
            }
            if let Some(goal) = initial_goal.as_deref() {
                self.ensure_initial_coordinator_goal(&mut existing, params.operation_id, goal)?;
            }
            return self.inner.store.project_coordinator_create_operation(params.operation_id, &params, &existing);
        }
        let project = self.inner.store.project_get(params.project_id)?.ok_or_else(|| anyhow!("project not found"))?;
        let configured_model = self.inner.settings.get().providers.get(&params.provider.kind).and_then(|provider| provider.model.clone());
        let selected_model = params.model.as_deref().or(configured_model.as_deref());
        self.validate_provider_selection(project.id, &params.provider, selected_model, params.effort.as_deref()).await?;
        let supports_dedicated = Self::supports_dedicated_coordinator(params.provider.kind);
        let coordinator_mode =
            params.coordinator_mode.unwrap_or(if supports_dedicated { CoordinatorMode::Dedicated } else { CoordinatorMode::Ordinary });
        if coordinator_mode == CoordinatorMode::Dedicated && !supports_dedicated {
            return Err(anyhow!(
                "{} cannot enforce dedicated coordinator restrictions; use ordinary mode or choose Claude Code, OpenCode, pi, or Oh My Pi",
                params.provider.kind.display_name()
            ));
        }
        let (reserved_thread_id, reserved_group_id) =
            self.inner.store.project_coordinator_reserve(project.id, params.operation_id, &params)?;

        // The reservation is committed before thread/worktree side effects,
        // so reconnect retries reconcile the same identities.
        let mut thread = if let Some(thread) = self.inner.store.thread_get(reserved_thread_id)? {
            thread
        } else {
            let created = self
                .create_thread_with_id(
                    methods::ThreadsCreateParams {
                        project_id: project.id,
                        provider: params.provider.clone(),
                        model: params.model.clone(),
                        effort: params.effort.clone(),
                        permission_mode: params.permission_mode,
                        use_worktree: Some(false),
                        base_branch: None,
                        title: Some(format!("{} coordinator", project.name)),
                        message: None,
                    },
                    reserved_thread_id,
                )
                .await?;
            self.set_thread_relationships(created.id, None, Some(project.id), None)?;
            self.inner.store.thread_get(created.id)?.expect("coordinator was just stored")
        };

        let group = if let Some(group_id) = thread.collaboration_group_id {
            self.inner.store.collaboration_group_get(group_id)?.ok_or_else(|| anyhow!("reserved coordinator group is missing"))?
        } else {
            self.collaboration_group_create(methods::CollaborationGroupsCreateParams {
                operation_id: reserved_group_id,
                project_id: project.id,
                coordinator_thread_id: thread.id,
                objective: initial_goal.clone().unwrap_or_else(|| format!("Coordinate work in {}", project.name)),
                success_criteria: Vec::new(),
                coordinator_mode: Some(coordinator_mode),
                policy: None,
            })?
        };
        self.set_thread_relationships(thread.id, None, Some(project.id), Some(group.id))?;
        thread = self.inner.store.thread_get(thread.id)?.expect("coordinator was just stored");
        let mut result = ProjectCoordinator { thread, group, created: true };
        if let Some(goal) = initial_goal.as_deref() {
            self.ensure_initial_coordinator_goal(&mut result, params.operation_id, goal)?;
        }
        self.inner.store.project_coordinator_create_operation(params.operation_id, &params, &result)
    }

    fn ensure_initial_coordinator_goal(&self, coordinator: &mut ProjectCoordinator, operation_id: OperationId, goal: &str) -> Result<()> {
        const BRIEF_KEY: &str = "project.brief";
        if self.inner.store.collaboration_context_by_key(coordinator.group.id, BRIEF_KEY)?.is_some() {
            return Ok(());
        }
        if coordinator.group.objective != goal {
            coordinator.group = self.collaboration_group_update(methods::CollaborationGroupsUpdateParams {
                operation_id: derived_operation_id(operation_id, 0x67),
                group_id: coordinator.group.id,
                expected_revision: coordinator.group.revision,
                objective: Some(goal.to_owned()),
                success_criteria: None,
                coordinator_thread_id: None,
                coordinator_mode: None,
                policy: None,
            })?;
        }
        self.collaboration_context_put(
            methods::CollaborationContextPutParams {
                operation_id: derived_operation_id(operation_id, 0x68),
                group_id: coordinator.group.id,
                entry_id: None,
                key: BRIEF_KEY.into(),
                kind: ContextEntryKind::Brief,
                body: goal.to_owned(),
                expected_revision: None,
                author_thread_id: None,
                user_authored: true,
                source_refs: vec!["user:coordinator.create".into()],
            },
            None,
        )?;
        Ok(())
    }

    pub async fn project_coordinator_delete(&self, params: methods::CollaborationCoordinatorDeleteParams) -> Result<Thread> {
        let _collaboration_command = self.inner.collaboration_commands.lock().await;
        if let Some(receipt) = self.collaboration_receipt(params.operation_id, "human", "coordinator.delete", &params)? {
            return Ok(receipt);
        }
        let mut current = self.project_coordinator_get(params.project_id)?.ok_or_else(|| anyhow!("coordinator no longer exists"))?;
        if current.thread.id != params.thread_id {
            return Err(anyhow!("coordinator changed; reopen the project before deleting it"));
        }
        // Serialize the final activity check with turn/queue admission. Hold the
        // session map only through the synchronous transaction, never its close.
        let (thread, events, live) = {
            let mut sessions = self.inner.sessions.lock().await;
            let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
            let _write = self.inner.collaboration_writes.lock().map_err(|_| anyhow!("collaboration write lock poisoned"))?;
            current.group =
                self.inner.store.collaboration_group_get(current.group.id)?.ok_or_else(|| anyhow!("coordinator group is missing"))?;
            if !self.inner.store.collaboration_assignments(current.group.id, false)?.is_empty() {
                return Err(anyhow!("Stop agents before deleting the coordinator; unfinished assignments remain."));
            }
            for member in self.inner.store.collaboration_members(current.group.id)? {
                if let Some(thread) = self.inner.store.thread_get(member.thread_id)?
                    && (matches!(thread.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval)
                        || self.inner.store.runtime_tasks_for_thread(thread.id)?.iter().any(|task| task.status.is_active())
                        || !self.inner.store.queue_list(Some(thread.id))?.is_empty())
                {
                    return Err(anyhow!("Stop agents and remove queued messages before deleting the coordinator."));
                }
            }
            let thread = self.inner.store.thread_get(current.thread.id)?.ok_or_else(|| anyhow!("coordinator thread is missing"))?;
            current.thread = thread;
            current.thread.status = ThreadStatus::Archived;
            current.thread.coordinator_project_id = None;
            current.thread.updated_at = Utc::now();
            current.group.status = GroupStatus::Completed;
            current.group.revision += 1;
            current.group.updated_at = Utc::now();
            let (thread, events) = self.inner.store.project_coordinator_delete_operation(&params, &current.thread, &current.group)?;
            let live = sessions.remove(&thread.id);
            if let Some(live) = &live {
                live.mark_released();
                self.revoke_native_session(live);
            }
            (thread, events, live)
        };
        self.broadcast_committed_collaboration(events);
        if let Some(live) = live {
            let _ = live.session.close().await;
        }
        Ok(thread)
    }

    fn coordinator_setup_complete(&self, group_id: GroupId) -> Result<bool> {
        Ok(self.inner.store.collaboration_context_by_key(group_id, "project.setup")?.is_some())
    }

    pub async fn project_coordinator_switch_harness(
        &self,
        params: methods::CollaborationCoordinatorSwitchHarnessParams,
    ) -> Result<ProjectCoordinator> {
        if let Some(receipt) = self.collaboration_receipt(params.operation_id, "human", "coordinator.switch_harness", &params)? {
            return Ok(receipt);
        }
        let _collaboration_command = self.inner.collaboration_commands.lock().await;
        if let Some(receipt) = self.collaboration_receipt(params.operation_id, "human", "coordinator.switch_harness", &params)? {
            return Ok(receipt);
        }
        let current = self
            .project_coordinator_get(params.project_id)?
            .ok_or_else(|| anyhow!("create the project coordinator before switching its harness"))?;
        if !matches!(current.thread.status, ThreadStatus::Idle | ThreadStatus::Failed) {
            return Err(anyhow!("the project coordinator must be idle before switching its harness"));
        }
        if self.inner.store.runtime_tasks_for_thread(current.thread.id)?.iter().any(|task| task.status.is_active()) {
            return Err(anyhow!("the project coordinator has active background work; wait for it before switching its harness"));
        }
        let parked_live = self.inner.sessions.lock().await.get(&current.thread.id).cloned();
        if let Some(live) = parked_live.as_deref()
            && !self.session_parked(current.thread.id, live).await?
        {
            return Err(anyhow!("the project coordinator must be idle before switching its harness"));
        }

        let settings = self.inner.settings.get();
        let model =
            params.model.clone().or_else(|| settings.providers.get(&params.provider.kind).and_then(|provider| provider.model.clone()));
        self.validate_provider_selection(params.project_id, &params.provider, model.as_deref(), params.effort.as_deref()).await?;
        let permission_mode = params.permission_mode.unwrap_or(settings.default_permission_mode);
        let (result, events, released) = {
            // `commands` excludes a send between the final idle check, live
            // credential revocation, and the durable provider change.
            let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
            let mut thread =
                self.inner.store.thread_get(current.thread.id)?.ok_or_else(|| anyhow!("project coordinator thread is missing"))?;
            if !matches!(thread.status, ThreadStatus::Idle | ThreadStatus::Failed) {
                return Err(anyhow!("the project coordinator must be idle before switching its harness"));
            }
            let mut sessions =
                self.inner.sessions.try_lock().map_err(|_| anyhow!("the coordinator session is changing; retry the harness switch"))?;
            if let Some(expected) = parked_live.as_ref()
                && !sessions.get(&thread.id).is_some_and(|live| Arc::ptr_eq(live, expected))
            {
                return Err(anyhow!("the coordinator session changed; retry the harness switch"));
            }
            let mut releasing = if parked_live.is_some() {
                Some(
                    self.inner
                        .releasing
                        .try_lock()
                        .map_err(|_| anyhow!("the coordinator session is changing; retry the harness switch"))?,
                )
            } else {
                None
            };
            let mut group = self
                .inner
                .store
                .collaboration_group_get(current.group.id)?
                .ok_or_else(|| anyhow!("project coordinator group is missing"))?;
            if group.coordinator_thread_id != thread.id {
                return Err(anyhow!("project coordinator authority changed; reload it and retry the harness switch"));
            }
            let released = sessions.remove(&thread.id);
            thread.provider = params.provider.clone();
            thread.model = model;
            thread.effort = params.effort.clone();
            thread.permission_mode = permission_mode;
            thread.provider_session_id = None;
            thread.status = ThreadStatus::Idle;
            thread.updated_at = Utc::now();
            let target_mode = if Self::supports_dedicated_coordinator(params.provider.kind) {
                CoordinatorMode::Dedicated
            } else {
                CoordinatorMode::Ordinary
            };
            let group_changed = group.coordinator_mode != target_mode;
            if group_changed {
                group.coordinator_mode = target_mode;
                group.revision += 1;
                group.updated_at = Utc::now();
            }
            let candidate = ProjectCoordinator { thread, group, created: false };
            let stored = self.inner.store.project_coordinator_switch_operation(params.operation_id, &params, &candidate, group_changed);
            let (result, events) = match stored {
                Ok(value) => value,
                Err(error) => {
                    if let Some(live) = released {
                        sessions.insert(current.thread.id, live);
                    }
                    return Err(error);
                }
            };
            if let Some(live) = released.as_deref() {
                live.mark_released();
                self.revoke_native_session(live);
            }
            let released = if let Some(live) = released {
                let (done, waiting) = tokio::sync::watch::channel(());
                releasing.as_mut().expect("live session reserves a release barrier").insert(result.thread.id, waiting);
                Some((live, done))
            } else {
                None
            };
            (result, events, released)
        };
        self.broadcast_committed_collaboration(events);
        self.inner.pending_rewinds.lock().await.remove(&result.thread.id);
        if let Some((live, done)) = released {
            let close = live.session.close().await;
            self.inner.releasing.lock().await.remove(&result.thread.id);
            drop(done);
            close?;
            self.emit(result.thread.id, None, EventPayload::ProviderSessionReleased { reason: SessionReleaseReason::Manual })?;
        }
        Ok(result)
    }

    pub(crate) async fn ensure_ordinary_collaboration_group(&self, thread_id: ThreadId) -> Result<GroupId> {
        if let Some(group_id) = self.inner.store.collaboration_group_for_thread(thread_id)? {
            return Ok(group_id);
        }
        let thread = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("caller thread not found"))?;
        if let Some(project_id) = thread.coordinator_project_id
            && let Some((coordinator_thread_id, group_id)) = self.inner.store.project_coordinator(project_id)?
            && coordinator_thread_id == thread_id
        {
            return Ok(group_id);
        }
        let _collaboration_command = self.inner.collaboration_commands.lock().await;
        if let Some(group_id) = self.inner.store.collaboration_group_for_thread(thread_id)? {
            return Ok(group_id);
        }
        let group = self.collaboration_group_create(methods::CollaborationGroupsCreateParams {
            operation_id: Uuid::now_v7(),
            project_id: thread.project_id,
            coordinator_thread_id: thread.id,
            objective: format!("Collaborate from {}", thread.title),
            success_criteria: Vec::new(),
            coordinator_mode: Some(CoordinatorMode::Ordinary),
            policy: None,
        })?;
        self.set_thread_relationships(thread.id, None, thread.coordinator_project_id, Some(group.id))?;
        Ok(group.id)
    }

    fn collaboration_receipt<T: serde::Serialize + serde::de::DeserializeOwned>(
        &self,
        operation_id: OperationId,
        actor: &str,
        kind: &str,
        request: &impl serde::Serialize,
    ) -> Result<Option<T>> {
        self.inner.store.collaboration_operation_receipt(operation_id, actor, kind, request)
    }

    fn emit_collaboration(&self, group_id: GroupId, payload: EventPayload) -> Result<()> {
        for member in self.inner.store.collaboration_members(group_id)?.into_iter().filter(|member| member.active) {
            self.emit(member.thread_id, None, payload.clone())?;
        }
        self.inner.collaboration_wakeup.notify_waiters();
        Ok(())
    }

    fn emit_project_context(&self, project_id: ProjectId, payload: EventPayload) -> Result<()> {
        let mut recipients = HashSet::new();
        for group in self.inner.store.collaboration_groups_list(Some(project_id), false)? {
            for member in self.inner.store.collaboration_members(group.id)?.into_iter().filter(|member| member.active) {
                if recipients.insert(member.thread_id) {
                    self.emit(member.thread_id, None, payload.clone())?;
                }
            }
        }
        self.inner.collaboration_wakeup.notify_waiters();
        Ok(())
    }

    fn broadcast_committed_collaboration(&self, events: Vec<ThreadEvent>) {
        if events.is_empty() {
            return;
        }
        for event in events {
            let _ = self.inner.events.send(event);
        }
        self.inner.queue_wakeup.notify_one();
        self.inner.collaboration_wakeup.notify_waiters();
    }

    fn validate_policy(policy: &CollaborationPolicy) -> Result<()> {
        if !(1..=32).contains(&policy.max_active_workers) {
            return Err(anyhow!("max_active_workers must be between 1 and 32"));
        }
        if policy.max_depth > 8 {
            return Err(anyhow!("max_depth must be at most 8"));
        }
        if !(1..=1024).contains(&policy.max_pending_messages) {
            return Err(anyhow!("max_pending_messages must be between 1 and 1024"));
        }
        if !(1..=128).contains(&policy.max_wakeups_per_assignment) {
            return Err(anyhow!("max_wakeups_per_assignment must be between 1 and 128"));
        }
        Ok(())
    }

    pub fn collaboration_group_detail(&self, group_id: GroupId) -> Result<CollaborationGroupDetail> {
        let group = self.inner.store.collaboration_group_get(group_id)?.ok_or_else(|| anyhow!("collaboration group not found"))?;
        let members = self.inner.store.collaboration_members(group_id)?;
        let mut assignments = self.inner.store.collaboration_assignments(group_id, true)?;
        assignments.sort_by_key(|item| std::cmp::Reverse(item.updated_at));
        assignments.truncate(200);
        let mut pending_messages = self.inner.store.collaboration_messages(group_id)?;
        pending_messages.retain(|message| {
            matches!(
                message.state,
                CollaborationDeliveryState::Persisted | CollaborationDeliveryState::Queued | CollaborationDeliveryState::Uncertain
            )
        });
        pending_messages.truncate(100);
        let coordinator_setup_complete =
            self.inner.store.project_coordinator_for_group(group_id)?.map(|_| self.coordinator_setup_complete(group_id)).transpose()?;
        Ok(CollaborationGroupDetail { group, members, assignments, pending_messages, coordinator_setup_complete })
    }

    pub fn collaboration_groups_list(
        &self,
        params: methods::CollaborationGroupsListParams,
    ) -> Result<methods::CollaborationGroupsListResult> {
        let mut groups = self.inner.store.collaboration_groups_list(params.project_id, params.include_stopped)?;
        groups.sort_by_key(|group| group.id);
        page_by_id(&mut groups, params.cursor.as_deref(), params.limit, |group| group.id)
            .map(|(groups, next_cursor)| methods::CollaborationGroupsListResult { groups, next_cursor })
    }

    pub fn collaboration_group_create(&self, params: methods::CollaborationGroupsCreateParams) -> Result<CollaborationGroup> {
        if let Some(receipt) = self.collaboration_receipt(params.operation_id, "human", "groups.create", &params)? {
            return Ok(receipt);
        }
        let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
        let _write = self.inner.collaboration_writes.lock().map_err(|_| anyhow!("collaboration write lock poisoned"))?;
        if let Some(receipt) = self.collaboration_receipt(params.operation_id, "human", "groups.create", &params)? {
            return Ok(receipt);
        }
        let coordinator =
            self.inner.store.thread_get(params.coordinator_thread_id)?.ok_or_else(|| anyhow!("coordinator thread not found"))?;
        if coordinator.project_id != params.project_id {
            return Err(anyhow!("coordinator thread belongs to another project"));
        }
        if self.inner.store.collaboration_group_for_thread(coordinator.id)?.is_some() {
            return Err(anyhow!("thread already belongs to an active collaboration group"));
        }
        if params.objective.trim().is_empty() {
            return Err(anyhow!("objective is required"));
        }
        if params.coordinator_mode == Some(CoordinatorMode::Dedicated)
            && match self.inner.sessions.try_lock() {
                Ok(sessions) => sessions.contains_key(&coordinator.id),
                Err(_) => true,
            }
        {
            return Err(anyhow!(
                "release the coordinator's idle harness session before enabling dedicated mode; an active turn must finish or be stopped first"
            ));
        }
        let policy = params.policy.clone().unwrap_or_default();
        Self::validate_policy(&policy)?;
        let request = params.clone();
        let now = chrono::Utc::now();
        let group = CollaborationGroup {
            id: params.operation_id,
            project_id: params.project_id,
            coordinator_thread_id: coordinator.id,
            objective: params.objective,
            success_criteria: params.success_criteria,
            status: GroupStatus::Active,
            coordinator_mode: params.coordinator_mode.unwrap_or(CoordinatorMode::Ordinary),
            policy,
            revision: 1,
            created_at: now,
            updated_at: now,
        };
        let member =
            GroupMember { group_id: group.id, thread_id: coordinator.id, role: GroupMemberRole::Coordinator, active: true, joined_at: now };
        let (group, events) =
            self.inner.store.collaboration_group_create_operation(params.operation_id, "human", &request, &group, &member)?;
        self.set_thread_relationships(coordinator.id, None, coordinator.coordinator_project_id, Some(group.id))?;
        self.broadcast_committed_collaboration(events);
        Ok(group)
    }

    pub fn collaboration_group_update(&self, params: methods::CollaborationGroupsUpdateParams) -> Result<CollaborationGroup> {
        if let Some(receipt) = self.collaboration_receipt(params.operation_id, "human", "groups.update", &params)? {
            return Ok(receipt);
        }
        let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
        let _write = self.inner.collaboration_writes.lock().map_err(|_| anyhow!("collaboration write lock poisoned"))?;
        if let Some(receipt) = self.collaboration_receipt(params.operation_id, "human", "groups.update", &params)? {
            return Ok(receipt);
        }
        let mut group =
            self.inner.store.collaboration_group_get(params.group_id)?.ok_or_else(|| anyhow!("collaboration group not found"))?;
        if group.revision != params.expected_revision {
            return Err(anyhow!("group changed; reload it and retry with its current revision"));
        }
        if (params.coordinator_mode.is_some() || params.policy.is_some())
            && match self.inner.sessions.try_lock() {
                Ok(sessions) => sessions.contains_key(&group.coordinator_thread_id),
                Err(_) => true,
            }
        {
            return Err(anyhow!(
                "release the coordinator's idle harness session before changing collaboration mode or authority; an active turn must finish or be stopped first"
            ));
        }
        if params.objective.as_ref().is_some_and(|objective| objective.trim().is_empty()) {
            return Err(anyhow!("objective is required"));
        }
        if let Some(policy) = &params.policy {
            Self::validate_policy(policy)?;
        }
        let request = params.clone();
        let mut changed_members = Vec::new();
        if let Some(objective) = params.objective {
            if objective.trim().is_empty() {
                return Err(anyhow!("objective is required"));
            }
            group.objective = objective;
        }
        if let Some(criteria) = params.success_criteria {
            group.success_criteria = criteria;
        }
        if let Some(mode) = params.coordinator_mode {
            group.coordinator_mode = mode;
        }
        if let Some(policy) = params.policy {
            group.policy = policy;
        }
        if let Some(thread_id) = params.coordinator_thread_id {
            let member = self
                .inner
                .store
                .collaboration_members(group.id)?
                .into_iter()
                .find(|m| m.thread_id == thread_id && m.active)
                .ok_or_else(|| anyhow!("new coordinator must be an active group member"))?;
            if thread_id != group.coordinator_thread_id
                && let Some(old) =
                    self.inner.store.collaboration_members(group.id)?.into_iter().find(|m| m.thread_id == group.coordinator_thread_id)
            {
                let old = GroupMember { role: GroupMemberRole::Worker, ..old };
                changed_members.push(old);
            }
            group.coordinator_thread_id = thread_id;
            let member = GroupMember { role: GroupMemberRole::Coordinator, ..member };
            changed_members.push(member);
        }
        group.revision += 1;
        group.updated_at = Utc::now();
        let (group, events) =
            self.inner.store.collaboration_group_update_operation(params.operation_id, "human", &request, &group, &changed_members)?;
        self.broadcast_committed_collaboration(events);
        Ok(group)
    }

    pub async fn collaboration_group_control(&self, params: methods::CollaborationGroupsControlParams) -> Result<CollaborationGroup> {
        let _collaboration_command = self.inner.collaboration_commands.lock().await;
        let collaboration_write = self.inner.collaboration_writes.lock().map_err(|_| anyhow!("collaboration write lock poisoned"))?;
        if let Some(receipt) = self.collaboration_receipt(params.operation_id, "human", "groups.control", &params)? {
            return Ok(receipt);
        }
        let mut group =
            self.inner.store.collaboration_group_get(params.group_id)?.ok_or_else(|| anyhow!("collaboration group not found"))?;
        if matches!(params.action, methods::CollaborationGroupControlAction::Complete)
            && self.inner.store.project_coordinator_for_group(group.id)?.is_some()
        {
            return Err(anyhow!("a project coordinator remains available across tasks; pause it instead of completing its group"));
        }
        let allowed = matches!(
            (group.status, params.action),
            (
                GroupStatus::Active,
                methods::CollaborationGroupControlAction::Pause
                    | methods::CollaborationGroupControlAction::Stop
                    | methods::CollaborationGroupControlAction::Complete,
            ) | (
                GroupStatus::Paused,
                methods::CollaborationGroupControlAction::Resume
                    | methods::CollaborationGroupControlAction::Stop
                    | methods::CollaborationGroupControlAction::Complete,
            ) | (GroupStatus::Stopped, methods::CollaborationGroupControlAction::Resume)
        );
        if !allowed {
            return Err(anyhow!("group control action is not valid from its current state"));
        }
        if matches!(params.action, methods::CollaborationGroupControlAction::Complete)
            && !self.inner.store.collaboration_assignments(group.id, false)?.is_empty()
        {
            return Err(anyhow!("finish or cancel active assignments before completing the group"));
        }
        group.status = match params.action {
            methods::CollaborationGroupControlAction::Pause => GroupStatus::Paused,
            methods::CollaborationGroupControlAction::Stop => GroupStatus::Stopped,
            methods::CollaborationGroupControlAction::Resume => GroupStatus::Active,
            methods::CollaborationGroupControlAction::Complete => GroupStatus::Completed,
        };
        group.revision += 1;
        group.updated_at = Utc::now();
        let mut stopped_assignments = Vec::new();
        let mut stopped_messages = Vec::new();
        if matches!(params.action, methods::CollaborationGroupControlAction::Stop) {
            for mut assignment in self.inner.store.collaboration_assignments(group.id, false)? {
                assignment.status = AssignmentStatus::Cancelled;
                assignment.uncertainty =
                    Some("group stopped; provider work was interrupted and may have produced unreported side effects".into());
                assignment.revision += 1;
                assignment.updated_at = Utc::now();
                stopped_assignments.push(assignment);
            }
            for mut message in self.inner.store.collaboration_messages(group.id)? {
                if !matches!(message.state, CollaborationDeliveryState::Persisted | CollaborationDeliveryState::Queued) {
                    continue;
                }
                message.state = CollaborationDeliveryState::Cancelled;
                message.updated_at = Utc::now();
                stopped_messages.push(message);
            }
        }
        let (group, events) = self.inner.store.collaboration_group_control_operation(
            params.operation_id,
            "human",
            &params,
            &group,
            &stopped_assignments,
            &stopped_messages,
        )?;
        self.broadcast_committed_collaboration(events);
        drop(collaboration_write);
        if matches!(params.action, methods::CollaborationGroupControlAction::Stop) {
            let mut interrupted = HashSet::new();
            for thread_id in stopped_assignments.iter().filter_map(|assignment| assignment.owner_thread_id) {
                if interrupted.insert(thread_id) {
                    let _ = self.interrupt(thread_id).await;
                }
            }
            if interrupted.insert(group.coordinator_thread_id)
                && self.inner.sessions.lock().await.contains_key(&group.coordinator_thread_id)
            {
                let _ = self.interrupt(group.coordinator_thread_id).await;
            }
        } else if matches!(params.action, methods::CollaborationGroupControlAction::Resume) {
            let all_messages = self.inner.store.collaboration_messages(group.id)?;
            let mut pending = all_messages.iter().filter(|message| message.state == CollaborationDeliveryState::Queued).count();
            for mut message in all_messages
                .iter()
                .filter(|message| {
                    message.state == CollaborationDeliveryState::Persisted
                        && message.purpose != CollaborationMessagePurpose::Progress
                        && message.assignment_id.is_some()
                })
                .cloned()
            {
                if pending >= group.policy.max_pending_messages as usize {
                    break;
                }
                let assignment_id = message.assignment_id.expect("filtered above");
                let wakeups: u32 = all_messages
                    .iter()
                    .filter(|candidate| candidate.assignment_id == Some(assignment_id))
                    .map(|candidate| candidate.wakeup_count)
                    .sum();
                if wakeups >= group.policy.max_wakeups_per_assignment {
                    continue;
                }
                message.state = CollaborationDeliveryState::Queued;
                message.wakeup_count += 1;
                message.updated_at = Utc::now();
                let events = self.inner.store.collaboration_message_queue(&message)?;
                self.broadcast_committed_collaboration(events);
                pending += 1;
            }
        }
        self.inner.queue_wakeup.notify_one();
        Ok(group)
    }

    pub fn collaboration_member_attach(&self, params: methods::CollaborationMembersAttachParams) -> Result<GroupMember> {
        if let Some(receipt) = self.collaboration_receipt(params.operation_id, "human", "members.attach", &params)? {
            return Ok(receipt);
        }
        let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
        if let Some(receipt) = self.collaboration_receipt(params.operation_id, "human", "members.attach", &params)? {
            return Ok(receipt);
        }
        let group = self.inner.store.collaboration_group_get(params.group_id)?.ok_or_else(|| anyhow!("collaboration group not found"))?;
        if params.role == GroupMemberRole::Coordinator && params.thread_id != group.coordinator_thread_id {
            return Err(anyhow!("change the explicit coordinator through collaboration.groups.update"));
        }
        let thread = self.inner.store.thread_get(params.thread_id)?.ok_or_else(|| anyhow!("thread not found"))?;
        if thread.project_id != group.project_id {
            return Err(anyhow!("thread belongs to another project"));
        }
        if self.inner.store.collaboration_group_for_thread(thread.id)?.is_some_and(|id| id != group.id) {
            return Err(anyhow!("thread already belongs to another active collaboration group"));
        }
        let member = GroupMember { group_id: group.id, thread_id: thread.id, role: params.role, active: true, joined_at: Utc::now() };
        let (member, events) =
            self.inner.store.collaboration_member_operation(params.operation_id, "human", "members.attach", &params, &member, &member)?;
        self.set_thread_relationships(thread.id, thread.parent_thread_id, thread.coordinator_project_id, Some(group.id))?;
        self.broadcast_committed_collaboration(events);
        Ok(member)
    }

    pub fn collaboration_member_detach(&self, params: methods::CollaborationMembersDetachParams) -> Result<()> {
        if let Some(()) = self.collaboration_receipt(params.operation_id, "human", "members.detach", &params)? {
            return Ok(());
        }
        let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
        if let Some(()) = self.collaboration_receipt(params.operation_id, "human", "members.detach", &params)? {
            return Ok(());
        }
        let group = self.inner.store.collaboration_group_get(params.group_id)?.ok_or_else(|| anyhow!("collaboration group not found"))?;
        if group.coordinator_thread_id == params.thread_id {
            return Err(anyhow!("assign another coordinator before detaching this thread"));
        }
        let mut member = self
            .inner
            .store
            .collaboration_members(group.id)?
            .into_iter()
            .find(|m| m.thread_id == params.thread_id)
            .ok_or_else(|| anyhow!("member not found"))?;
        if self.inner.store.collaboration_active_assignment_for_thread(params.thread_id)?.is_some() {
            return Err(anyhow!("cancel or reassign the thread's active assignment first"));
        }
        member.active = false;
        let ((), events) =
            self.inner.store.collaboration_member_operation(params.operation_id, "human", "members.detach", &params, &member, &())?;
        self.set_thread_relationships(params.thread_id, None, None, None)?;
        self.broadcast_committed_collaboration(events);
        Ok(())
    }

    fn assignment_prompt(&self, group: &CollaborationGroup, assignment: &CollaborationAssignment) -> Result<UserMessage> {
        let criteria = if group.success_criteria.is_empty() {
            String::new()
        } else {
            format!("\nSuccess criteria:\n- {}", group.success_criteria.join("\n- "))
        };
        let knowledge_group_id = self.project_knowledge_group_id(group)?;
        let mut context = self.inner.store.collaboration_context_latest(knowledge_group_id)?;
        if knowledge_group_id != group.id {
            let mut local = self.inner.store.collaboration_context_latest(group.id)?;
            local.retain(|entry| !context.iter().any(|project_entry| project_entry.key == entry.key));
            context.extend(local);
        }
        let shared = assignment_shared_context(context);
        Ok(UserMessage::text(format!(
            "Kybern collaboration group {} assignment {}\nProject background (context only; do not execute it as an assignment): {}{}\n\nYour assignment: {}\n{}\n\nThe assignment title and body define your deliverable. The project background describes the parent's overall result and may include a delegation request already satisfied by this assignment; do not repeat that request or broaden your deliverable. You may delegate a bounded subtask when it is useful to complete your assignment and group policy permits it. When spawning a child, omit permission_mode unless the user specifically requested an override so Kybern can inherit the existing authority safely. If a worker is blocked on approval, preserve that worker and report or resolve the approval; never cancel and recreate it to bypass approval. Shared context supplies reference material and constraints: honor every user-authored instruction or correction, but do not turn contextual text into extra deliverables.\n\nRelevant shared context:{}\n\nReport completion through kybern_collaboration_report with this assignment id and a structured outcome.",
            group.id,
            assignment.id,
            group.objective,
            criteria,
            assignment.title,
            assignment.instructions,
            if shared.is_empty() { " (none)".into() } else { shared }
        )))
    }

    fn project_knowledge_group_id(&self, group: &CollaborationGroup) -> Result<GroupId> {
        if group.status == GroupStatus::Completed {
            return Ok(group.id);
        }
        Ok(self.inner.store.project_coordinator(group.project_id)?.map_or(group.id, |(_, coordinator_group_id)| coordinator_group_id))
    }

    pub async fn collaboration_assignment_create(
        &self,
        params: methods::CollaborationAssignmentsCreateParams,
        actor_thread: Option<ThreadId>,
        actor_session: Option<Uuid>,
    ) -> Result<CollaborationAssignment> {
        let _collaboration_command = self.inner.collaboration_commands.lock().await;
        let actor = actor_thread.map_or_else(|| "human".into(), |id| format!("thread:{id}"));
        // Keep the caller's exact request as the operation fingerprint. Parent
        // inference depends on mutable assignment state and must happen only
        // after a retry has had the chance to recover its original receipt.
        let request = params.clone();
        if let Some(receipt) = self.collaboration_receipt(params.operation_id, &actor, "assignments.create", &request)? {
            return Ok(receipt);
        }
        let mut params = params;
        if params.owner_thread_id.is_some() == params.child.is_some() {
            return Err(anyhow!("provide exactly one of owner_thread_id or child"));
        }
        let group = self.inner.store.collaboration_group_get(params.group_id)?.ok_or_else(|| anyhow!("collaboration group not found"))?;
        if group.status == GroupStatus::Stopped || group.status == GroupStatus::Completed {
            return Err(anyhow!("group is not accepting assignments"));
        }
        if params.kind.mutates_workspace()
            && self.inner.store.project_coordinator_for_group(group.id)?.is_some()
            && !self.coordinator_setup_complete(group.id)?
        {
            if actor_thread.is_none() {
                return Err(anyhow!(
                    "Set up the coordinator first. Send a message in its conversation to research the project before starting implementation."
                ));
            }
            return Err(anyhow!(
                "Set up the coordinator first: delegate repository research, review its successful result, and save project.setup knowledge before creating editing or integration assignments."
            ));
        }
        let actor_member = actor_thread.map(|thread_id| self.require_collaboration_actor(&group, thread_id)).transpose()?;
        if actor_member.as_ref().is_some_and(|member| member.role == GroupMemberRole::Observer) {
            return Err(anyhow!("observer members cannot create assignments"));
        }
        if let Some(thread_id) = actor_thread
            && thread_id != group.coordinator_thread_id
            && params.parent_assignment_id.is_none()
        {
            params.parent_assignment_id =
                self.inner.store.collaboration_active_assignment_for_thread(thread_id)?.map(|assignment| assignment.id);
            if params.parent_assignment_id.is_none() {
                return Err(anyhow!("delegation requires an active assignment owned by the caller"));
            }
        }
        let depth = if let Some(parent_id) = params.parent_assignment_id {
            let parent = self.inner.store.collaboration_assignment_get(parent_id)?.ok_or_else(|| anyhow!("parent assignment not found"))?;
            if parent.group_id != group.id {
                return Err(anyhow!("parent assignment belongs to another group"));
            }
            if let Some(actor_thread) = actor_thread
                && parent.owner_thread_id != Some(actor_thread)
            {
                return Err(anyhow!("parent assignment is not owned by the active caller"));
            }
            parent.depth + 1
        } else {
            0
        };
        if depth > group.policy.max_depth {
            return Err(anyhow!("assignment exceeds the group's delegation depth"));
        }
        let mut requested_child = params.child.clone();
        if let Some(child) = &mut requested_child {
            if !group.policy.allowed_providers.is_empty() && !group.policy.allowed_providers.contains(&child.provider.kind) {
                return Err(anyhow!("provider is not allowed by the group policy"));
            }
            let mut project = self.inner.store.project_get(group.project_id)?.ok_or_else(|| anyhow!("project not found"))?;
            let configured_model =
                self.inner.settings.get().providers.get(&child.provider.kind).and_then(|provider| provider.model.clone());
            let selected_model = child.model.as_deref().or(configured_model.as_deref());
            self.validate_provider_selection(project.id, &child.provider, selected_model, child.effort.as_deref()).await?;
            if params.kind.mutates_workspace() && !project.is_git {
                // `is_git` is computed once at registration. If the user ran `git init`
                // after opening the folder, re-probe the filesystem before refusing, and
                // persist the corrected flag so later spawns and worktree creation see it.
                if project_path_is_git(&project.path) {
                    project.is_git = true;
                    project.updated_at = Utc::now();
                    self.inner.store.project_update(&project)?;
                } else {
                    return Err(anyhow!("editing and integration workers require a Git project so Kybern can isolate their changes"));
                }
            }
            if project.is_git && child.base_revision.as_deref().is_none_or(str::is_empty) {
                let source_cwd = match actor_thread {
                    Some(thread_id) => self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("caller thread not found"))?.cwd,
                    None => project.path.clone(),
                };
                child.base_revision = Some(resolve_git_revision(&source_cwd, "HEAD").await?);
            }
            if let Some(actor_thread) = actor_thread {
                let parent = self.inner.store.thread_get(actor_thread)?.ok_or_else(|| anyhow!("caller thread not found"))?;
                let crosses_provider = child.provider.kind != parent.provider.kind;
                let requested =
                    child.permission_mode.unwrap_or(if crosses_provider && parent.permission_mode != PermissionMode::FullAccess {
                        PermissionMode::Supervised
                    } else {
                        parent.permission_mode
                    });
                let allowed = parent.permission_mode == PermissionMode::FullAccess
                    || requested == PermissionMode::Supervised
                    || (!crosses_provider && requested == parent.permission_mode);
                if !allowed {
                    return Err(anyhow!(
                        "child permission mode has no conservative subset mapping for the parent harness; use supervised or delegate from a full-access parent"
                    ));
                }
                child.permission_mode = Some(requested);
            }
            if project.is_git {
                child.base_revision =
                    Some(resolve_git_revision(&project.path, child.base_revision.as_deref().expect("validated above")).await?);
            }
        }
        if let Some(owner_thread_id) = params.owner_thread_id {
            let member = self.require_collaboration_actor(&group, owner_thread_id)?;
            if member.role == GroupMemberRole::Observer {
                return Err(anyhow!("observer members cannot own assignments"));
            }
            if self.inner.store.collaboration_active_assignment_for_thread(owner_thread_id)?.is_some() {
                return Err(anyhow!("thread already owns an active assignment"));
            }
            if params.kind.mutates_workspace() && group.policy.require_worktree_for_editing {
                let owner = self.inner.store.thread_get(owner_thread_id)?.ok_or_else(|| anyhow!("assignment owner thread not found"))?;
                if owner.worktree.is_none() {
                    return Err(anyhow!("group policy requires editing and integration assignments to use an isolated worktree"));
                }
            }
        }
        if group.coordinator_mode == CoordinatorMode::Dedicated
            && params.owner_thread_id == Some(group.coordinator_thread_id)
            && params.kind.mutates_workspace()
        {
            return Err(anyhow!("a dedicated coordinator cannot own an editing or integration assignment"));
        }
        if let (Some(thread_id), Some(session_instance_id)) = (actor_thread, actor_session) {
            self.require_live_native_actor(thread_id, session_instance_id).await?;
        }
        let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
        let current_group = self.inner.store.collaboration_group_get(group.id)?.ok_or_else(|| anyhow!("collaboration group not found"))?;
        if current_group.revision != group.revision {
            return Err(anyhow!("group policy or authority changed while accepting the assignment; retry against current state"));
        }
        let now = chrono::Utc::now();
        let assignment = CollaborationAssignment {
            id: params.operation_id,
            group_id: group.id,
            parent_assignment_id: params.parent_assignment_id,
            owner_thread_id: params.owner_thread_id,
            requested_child: requested_child.clone(),
            created_by_thread_id: actor_thread,
            title: params.title,
            instructions: params.instructions,
            kind: params.kind,
            status: AssignmentStatus::Pending,
            base_revision: requested_child.as_ref().and_then(|c| c.base_revision.clone()),
            depth,
            dispatch_message_id: None,
            result: None,
            uncertainty: None,
            revision: 1,
            created_at: now,
            updated_at: now,
        };
        let (assignment, events) =
            self.inner.store.collaboration_assignment_create_operation(params.operation_id, &actor, &request, &assignment)?;
        self.broadcast_committed_collaboration(events);
        self.inner.queue_wakeup.notify_one();
        Ok(assignment)
    }

    async fn start_collaboration_assignment(&self, group: &CollaborationGroup, assignment: &mut CollaborationAssignment) -> Result<()> {
        let owner = if let Some(owner) = assignment.owner_thread_id {
            owner
        } else {
            let child = assignment.requested_child.clone().ok_or_else(|| anyhow!("pending assignment has no owner request"))?;
            let project = self.inner.store.project_get(group.project_id)?.ok_or_else(|| anyhow!("project not found"))?;
            let thread = self
                .create_thread(methods::ThreadsCreateParams {
                    project_id: group.project_id,
                    provider: child.provider,
                    model: child.model,
                    effort: child.effort,
                    permission_mode: child.permission_mode,
                    use_worktree: Some(project.is_git),
                    base_branch: child.base_revision.clone(),
                    title: Some(assignment.title.clone()),
                    message: None,
                })
                .await?;
            let member = GroupMember {
                group_id: group.id,
                thread_id: thread.id,
                role: match assignment.kind {
                    AssignmentKind::Review => GroupMemberRole::Reviewer,
                    AssignmentKind::Integration => GroupMemberRole::Integrator,
                    _ => GroupMemberRole::Worker,
                },
                active: true,
                joined_at: Utc::now(),
            };
            self.inner.store.collaboration_member_put(&member)?;
            self.set_thread_relationships(thread.id, assignment.created_by_thread_id, None, Some(group.id))?;
            self.emit_collaboration(group.id, EventPayload::CollaborationMemberUpdated { member })?;
            assignment.owner_thread_id = Some(thread.id);
            thread.id
        };
        let thread = self.inner.store.thread_get(owner)?.ok_or_else(|| anyhow!("assignment owner thread not found"))?;
        if thread.project_id != group.project_id {
            return Err(anyhow!("assignment owner belongs to another project"));
        }
        if self.inner.store.collaboration_group_for_thread(owner)? != Some(group.id) {
            return Err(anyhow!("assignment owner is not an active group member"));
        }
        let message_id = Uuid::now_v7();
        assignment.dispatch_message_id = Some(message_id);
        assignment.status = AssignmentStatus::Waiting;
        assignment.uncertainty = Some("assignment delivery has been persisted but the harness has not acknowledged it".into());
        assignment.updated_at = Utc::now();
        assignment.revision += 1;
        self.inner.store.collaboration_assignment_put(assignment)?;
        self.send_with_id(owner, message_id, self.assignment_prompt(group, assignment)?, false, false).await?;
        Ok(())
    }

    pub fn collaboration_assignments_list(
        &self,
        params: methods::CollaborationAssignmentsListParams,
    ) -> Result<methods::CollaborationAssignmentsListResult> {
        let mut assignments = self.inner.store.collaboration_assignments(params.group_id, params.include_finished)?;
        assignments.sort_by_key(|assignment| assignment.id);
        page_by_id(&mut assignments, params.cursor.as_deref(), params.limit, |assignment| assignment.id)
            .map(|(assignments, next_cursor)| methods::CollaborationAssignmentsListResult { assignments, next_cursor })
    }

    pub async fn collaboration_assignment_cancel(
        &self,
        params: methods::CollaborationAssignmentsCancelParams,
        actor_thread: Option<ThreadId>,
        actor_session: Option<Uuid>,
    ) -> Result<CollaborationAssignment> {
        let _collaboration_command = self.inner.collaboration_commands.lock().await;
        let actor = actor_thread.map_or_else(|| "human".into(), |id| format!("thread:{id}"));
        if let Some(receipt) = self.collaboration_receipt(params.operation_id, &actor, "assignments.cancel", &params)? {
            return Ok(receipt);
        }
        let mut assignment =
            self.inner.store.collaboration_assignment_get(params.assignment_id)?.ok_or_else(|| anyhow!("assignment not found"))?;
        let group =
            self.inner.store.collaboration_group_get(assignment.group_id)?.ok_or_else(|| anyhow!("collaboration group not found"))?;
        if !assignment.status.is_active() {
            return Err(anyhow!("assignment is already finished; reload it before cancelling"));
        }
        if let Some(actor_thread) = actor_thread {
            let member = self.require_collaboration_actor(&group, actor_thread)?;
            if member.role == GroupMemberRole::Observer
                || (actor_thread != group.coordinator_thread_id
                    && assignment.owner_thread_id != Some(actor_thread)
                    && assignment.created_by_thread_id != Some(actor_thread))
            {
                return Err(anyhow!("only the coordinator, assignment owner, or delegating parent can cancel this assignment"));
            }
        }
        if let (Some(thread_id), Some(session_instance_id)) = (actor_thread, actor_session) {
            self.require_live_native_actor(thread_id, session_instance_id).await?;
        }
        let request = params.clone();
        let all = self.inner.store.collaboration_assignments(group.id, false)?;
        let mut cancelling = vec![assignment.id];
        loop {
            let before = cancelling.len();
            for candidate in &all {
                if candidate.parent_assignment_id.is_some_and(|parent| cancelling.contains(&parent)) && !cancelling.contains(&candidate.id)
                {
                    cancelling.push(candidate.id);
                }
            }
            if cancelling.len() == before {
                break;
            }
        }
        let reason = params.reason.or_else(|| Some("assignment cancelled; already submitted provider side effects may remain".into()));
        let mut cancelled_assignments = Vec::new();
        for mut cancelled in all.into_iter().filter(|candidate| cancelling.contains(&candidate.id)) {
            cancelled.status = AssignmentStatus::Cancelled;
            cancelled.uncertainty = reason.clone();
            cancelled.revision += 1;
            cancelled.updated_at = Utc::now();
            if cancelled.id == assignment.id {
                assignment = cancelled.clone();
            }
            cancelled_assignments.push(cancelled);
        }
        let (assignment, events) = self.inner.store.collaboration_assignment_operation(
            params.operation_id,
            &actor,
            "assignments.cancel",
            &request,
            &cancelled_assignments,
            &assignment,
        )?;
        self.broadcast_committed_collaboration(events);
        for thread_id in cancelled_assignments.iter().filter_map(|cancelled| cancelled.owner_thread_id) {
            let _ = self.interrupt(thread_id).await;
        }
        self.inner.queue_wakeup.notify_one();
        Ok(assignment)
    }

    pub fn collaboration_assignment_update(
        &self,
        params: methods::CollaborationAssignmentsUpdateParams,
        actor_thread: Option<ThreadId>,
    ) -> Result<CollaborationAssignment> {
        let _write = self.inner.collaboration_writes.lock().map_err(|_| anyhow!("collaboration write lock poisoned"))?;
        let actor = actor_thread.map_or_else(|| "human".into(), |id| format!("thread:{id}"));
        if let Some(receipt) = self.collaboration_receipt(params.operation_id, &actor, "assignments.update", &params)? {
            return Ok(receipt);
        }
        let mut assignment =
            self.inner.store.collaboration_assignment_get(params.assignment_id)?.ok_or_else(|| anyhow!("assignment not found"))?;
        let group =
            self.inner.store.collaboration_group_get(assignment.group_id)?.ok_or_else(|| anyhow!("collaboration group not found"))?;
        if let Some(thread_id) = actor_thread
            && assignment.owner_thread_id != Some(thread_id)
            && group.coordinator_thread_id != thread_id
        {
            return Err(anyhow!("caller does not own this assignment"));
        }
        if assignment.revision != params.expected_revision {
            return Err(anyhow!("assignment changed; reload it and retry"));
        }
        if !matches!(assignment.status, AssignmentStatus::Working | AssignmentStatus::Waiting | AssignmentStatus::Blocked)
            || !matches!(params.status, AssignmentStatus::Working | AssignmentStatus::Waiting | AssignmentStatus::Blocked)
        {
            return Err(anyhow!(
                "assignment.update only changes working, waiting, and blocked progress; use complete or cancel for terminal transitions"
            ));
        }
        let request = params.clone();
        assignment.status = params.status;
        assignment.uncertainty = params.uncertainty;
        assignment.revision += 1;
        assignment.updated_at = Utc::now();
        let (assignment, events) = self.inner.store.collaboration_assignment_operation(
            params.operation_id,
            &actor,
            "assignments.update",
            &request,
            std::slice::from_ref(&assignment),
            &assignment,
        )?;
        self.broadcast_committed_collaboration(events);
        Ok(assignment)
    }

    pub fn collaboration_assignment_complete(
        &self,
        mut params: methods::CollaborationAssignmentsCompleteParams,
        actor_thread: Option<ThreadId>,
    ) -> Result<CollaborationAssignment> {
        let _write = self.inner.collaboration_writes.lock().map_err(|_| anyhow!("collaboration write lock poisoned"))?;
        let actor = actor_thread.map_or_else(|| "human".into(), |id| format!("thread:{id}"));
        let mut fingerprint = params.clone();
        fingerprint.result.completed_at = chrono::DateTime::<Utc>::UNIX_EPOCH;
        if let Some(receipt) = self.collaboration_receipt(params.operation_id, &actor, "assignments.complete", &fingerprint)? {
            if let Err(error) = self.record_assignment_result_reference(&receipt) {
                tracing::warn!(assignment_id = %receipt.id, %error, "could not persist assignment result reference");
            }
            return Ok(receipt);
        }
        let mut assignment =
            self.inner.store.collaboration_assignment_get(params.assignment_id)?.ok_or_else(|| anyhow!("assignment not found"))?;
        let group =
            self.inner.store.collaboration_group_get(assignment.group_id)?.ok_or_else(|| anyhow!("collaboration group not found"))?;
        if let Some(thread_id) = actor_thread
            && assignment.owner_thread_id != Some(thread_id)
        {
            return Err(anyhow!("only the assignment owner can report its result"));
        }
        let late_after_stop = assignment.status == AssignmentStatus::Cancelled && group.status == GroupStatus::Stopped;
        if !assignment.status.is_active() && !late_after_stop {
            return Err(anyhow!("assignment already has a terminal outcome"));
        }
        if !late_after_stop
            && self
                .inner
                .store
                .collaboration_assignments(group.id, false)?
                .iter()
                .any(|candidate| candidate.parent_assignment_id == Some(assignment.id))
        {
            return Err(anyhow!("finish or cancel active child assignments before completing their parent"));
        }
        if !late_after_stop
            && let Some(owner_thread_id) = assignment.owner_thread_id
            && self.inner.store.collaboration_messages(group.id)?.iter().any(|message| {
                message.assignment_id == Some(assignment.id)
                    && message.to_thread_id == owner_thread_id
                    && message.from_thread_id != Some(owner_thread_id)
                    && message.state == CollaborationDeliveryState::Queued
            })
        {
            return Err(anyhow!("assignment has unread collaboration instructions; read them before reporting completion"));
        }
        params.result.completed_at = Utc::now();
        if !late_after_stop {
            assignment.status = match params.result.outcome {
                AssignmentOutcome::Success | AssignmentOutcome::Partial => AssignmentStatus::Completed,
                AssignmentOutcome::Failed => AssignmentStatus::Failed,
            };
            assignment.uncertainty = None;
        } else {
            assignment.uncertainty = Some("late result retained after the group stopped; assignment remains cancelled".into());
        }
        assignment.result = Some(params.result);
        assignment.revision += 1;
        assignment.updated_at = Utc::now();
        let result_recipient = assignment
            .created_by_thread_id
            .filter(|thread_id| {
                self.inner
                    .store
                    .collaboration_members(group.id)
                    .is_ok_and(|members| members.into_iter().any(|member| member.active && member.thread_id == *thread_id))
            })
            .unwrap_or(group.coordinator_thread_id);
        let notification = if matches!(group.status, GroupStatus::Active | GroupStatus::Paused)
            && assignment.owner_thread_id.is_some_and(|owner| owner != result_recipient)
        {
            let result = assignment.result.as_ref().expect("result was just stored");
            let notification_id = derived_operation_id(params.operation_id, 0x52);
            let body = format!("Assignment {} finished with {:?}: {}", assignment.id, result.outcome, result.summary);
            let notification_params = methods::CollaborationMessagesSendParams {
                operation_id: notification_id,
                group_id: group.id,
                assignment_id: Some(assignment.id),
                from_thread_id: assignment.owner_thread_id,
                to_thread_id: result_recipient,
                purpose: CollaborationMessagePurpose::Result,
                reply_to: None,
                body,
            };
            let existing = self.inner.store.collaboration_messages(group.id)?;
            let pending = existing.iter().filter(|message| message.state == CollaborationDeliveryState::Queued).count();
            let wakeups: u32 =
                existing.iter().filter(|message| message.assignment_id == Some(assignment.id)).map(|message| message.wakeup_count).sum();
            let should_wake = group.status == GroupStatus::Active
                && pending < group.policy.max_pending_messages as usize
                && wakeups < group.policy.max_wakeups_per_assignment;
            let now = Utc::now();
            let message = CollaborationMessage {
                id: notification_id,
                operation_id: notification_id,
                group_id: group.id,
                assignment_id: Some(assignment.id),
                from_thread_id: assignment.owner_thread_id,
                to_thread_id: result_recipient,
                external_recipient: false,
                purpose: CollaborationMessagePurpose::Result,
                reply_to: None,
                body: notification_params.body.clone(),
                state: if should_wake { CollaborationDeliveryState::Queued } else { CollaborationDeliveryState::Persisted },
                delivery_turn_id: None,
                wakeup_count: u32::from(should_wake),
                created_at: now,
                updated_at: now,
            };
            let notification_actor = assignment.owner_thread_id.map_or_else(|| "human".into(), |id| format!("thread:{id}"));
            Some((notification_actor, serde_json::to_string(&notification_params)?, message, should_wake))
        } else {
            None
        };
        let notification_ref = notification
            .as_ref()
            .map(|(actor, request, message, should_wake)| (actor.as_str(), request.as_str(), message, should_wake.then_some(message.id)));
        let (assignment, events) = self.inner.store.collaboration_assignment_complete_operation(
            params.operation_id,
            &actor,
            &fingerprint,
            &assignment,
            notification_ref,
        )?;
        self.broadcast_committed_collaboration(events);
        if let Err(error) = self.record_assignment_result_reference(&assignment) {
            tracing::warn!(assignment_id = %assignment.id, %error, "could not persist assignment result reference");
        }
        Ok(assignment)
    }

    fn record_assignment_result_reference(&self, assignment: &CollaborationAssignment) -> Result<()> {
        let Some(result) = assignment.result.as_ref() else { return Ok(()) };
        let Some(author_thread_id) = assignment.owner_thread_id else { return Ok(()) };
        let mut body = format!("{:?}: {}", result.outcome, result.summary);
        if !result.changes.is_empty() {
            body.push_str("\nChanges: ");
            body.push_str(&result.changes.join("; "));
        }
        if !result.checks.is_empty() {
            body.push_str("\nChecks: ");
            body.push_str(&result.checks.join("; "));
        }
        if !result.artifacts.is_empty() {
            body.push_str("\nArtifacts: ");
            body.push_str(&result.artifacts.join("; "));
        }
        if !result.unresolved.is_empty() {
            body.push_str("\nUnresolved: ");
            body.push_str(&result.unresolved.join("; "));
        }
        truncate_utf8(&mut body, 120 * 1024);
        self.collaboration_context_put(
            methods::CollaborationContextPutParams {
                operation_id: derived_operation_id(assignment.id, 0x6b),
                group_id: assignment.group_id,
                entry_id: None,
                key: format!("assignment.result.{}", assignment.id),
                kind: ContextEntryKind::ResultReference,
                body,
                expected_revision: None,
                author_thread_id: Some(author_thread_id),
                user_authored: false,
                source_refs: vec![format!("assignment:{}", assignment.id), format!("thread:{author_thread_id}")],
            },
            Some(author_thread_id),
        )?;
        Ok(())
    }

    fn require_collaboration_actor(&self, group: &CollaborationGroup, thread_id: ThreadId) -> Result<GroupMember> {
        self.inner
            .store
            .collaboration_members(group.id)?
            .into_iter()
            .find(|m| m.thread_id == thread_id && m.active)
            .ok_or_else(|| anyhow!("active caller is not a participant in this collaboration group"))
    }

    async fn require_live_native_actor(&self, thread_id: ThreadId, session_instance_id: Uuid) -> Result<TurnId> {
        let live = self
            .inner
            .sessions
            .lock()
            .await
            .get(&thread_id)
            .cloned()
            .ok_or_else(|| anyhow!("native tool caller session is no longer active"))?;
        if live.session_instance_id != session_instance_id {
            return Err(anyhow!("native tool credential belongs to a replaced session"));
        }
        live.turn
            .lock()
            .await
            .as_ref()
            .filter(|turn| !turn.completed)
            .map(|turn| turn.id)
            .ok_or_else(|| anyhow!("native tool caller turn has ended"))
    }

    pub fn collaboration_message_send(
        &self,
        params: methods::CollaborationMessagesSendParams,
        actor_thread: Option<ThreadId>,
    ) -> Result<CollaborationMessage> {
        let _write = self.inner.collaboration_writes.lock().map_err(|_| anyhow!("collaboration write lock poisoned"))?;
        let actor = actor_thread.map_or_else(|| "human".into(), |id| format!("thread:{id}"));
        if let Some(receipt) = self.collaboration_receipt(params.operation_id, &actor, "messages.send", &params)? {
            return Ok(receipt);
        }
        let group = self.inner.store.collaboration_group_get(params.group_id)?.ok_or_else(|| anyhow!("collaboration group not found"))?;
        let reply_target = params
            .reply_to
            .map(|id| self.inner.store.collaboration_message_get(id)?.ok_or_else(|| anyhow!("reply target not found")))
            .transpose()?;
        let from_thread_id = match actor_thread {
            Some(id) => {
                let member =
                    self.inner.store.collaboration_members(group.id)?.into_iter().find(|member| member.thread_id == id && member.active);
                if let Some(member) = member {
                    if member.role == GroupMemberRole::Observer {
                        return Err(anyhow!("observer members are reference-only and cannot send collaboration messages"));
                    }
                } else if reply_target.as_ref().is_none_or(|original| !original.external_recipient || original.to_thread_id != id) {
                    return Err(anyhow!("caller is neither an active group member nor the addressed external recipient"));
                }
                Some(id)
            }
            None => {
                if params.from_thread_id.is_some() {
                    return Err(anyhow!("client requests cannot impersonate an agent thread"));
                }
                None
            }
        };
        let recipient = self
            .inner
            .store
            .collaboration_members(group.id)?
            .into_iter()
            .find(|member| member.thread_id == params.to_thread_id && member.active);
        let external_recipient = recipient.is_none();
        let recipient_thread = self.inner.store.thread_get(params.to_thread_id)?.ok_or_else(|| anyhow!("recipient thread not found"))?;
        let route_is_external = external_recipient || reply_target.as_ref().is_some_and(|message| message.external_recipient);
        if route_is_external && recipient_thread.status == ThreadStatus::Archived && params.purpose != CollaborationMessagePurpose::Progress
        {
            return Err(anyhow!("recipient thread is archived; open or unarchive it before sending a message that wakes it"));
        }
        let recipient_group_status = if route_is_external {
            recipient_thread
                .collaboration_group_id
                .or(self.inner.store.collaboration_group_for_thread(recipient_thread.id)?)
                .map(|id| self.inner.store.collaboration_group_get(id))
                .transpose()?
                .flatten()
                .map(|group| group.status)
        } else {
            None
        };
        if matches!(recipient_group_status, Some(GroupStatus::Stopped | GroupStatus::Completed)) {
            return Err(anyhow!("recipient collaboration group is not accepting messages"));
        }
        if route_is_external && let Some(actor_thread_id) = actor_thread {
            if params.purpose == CollaborationMessagePurpose::Reply
                && let Some(original) = reply_target.as_ref().filter(|message| message.external_recipient)
            {
                if let Some(initiator) = original.from_thread_id {
                    self.validate_external_delivery_authority(initiator, original.to_thread_id)?;
                }
            } else {
                self.validate_external_delivery_authority(actor_thread_id, recipient_thread.id)?;
            }
        }
        if recipient.is_some_and(|recipient| recipient.role == GroupMemberRole::Observer)
            && params.purpose != CollaborationMessagePurpose::Progress
        {
            return Err(anyhow!("observer members are reference-only and cannot receive collaboration wakeups"));
        }
        if matches!(group.status, GroupStatus::Stopped | GroupStatus::Completed) {
            return Err(anyhow!("group is not accepting messages"));
        }
        let assignment = params
            .assignment_id
            .map(|assignment_id| {
                self.inner.store.collaboration_assignment_get(assignment_id)?.ok_or_else(|| anyhow!("message assignment not found"))
            })
            .transpose()?;
        if assignment.as_ref().is_some_and(|assignment| assignment.group_id != group.id) {
            return Err(anyhow!("message assignment belongs to another group"));
        }
        if params.purpose != CollaborationMessagePurpose::Progress
            && assignment.is_none()
            && !external_recipient
            && params.reply_to.is_none()
        {
            return Err(anyhow!("messages that can wake an agent must name an assignment"));
        }
        let existing_messages = self.inner.store.collaboration_messages(group.id)?;
        let pending = existing_messages.iter().filter(|m| m.state == CollaborationDeliveryState::Queued).count();
        if external_recipient {
            let recipient_pending = self
                .inner
                .store
                .collaboration_pending_messages()?
                .into_iter()
                .filter(|message| message.to_thread_id == params.to_thread_id && message.state == CollaborationDeliveryState::Queued)
                .count();
            if recipient_pending >= group.policy.max_pending_messages as usize {
                return Err(anyhow!("recipient has reached its pending external message limit"));
            }
        }
        let terminal_notification = matches!(params.purpose, CollaborationMessagePurpose::Result | CollaborationMessagePurpose::Failure);
        if pending >= group.policy.max_pending_messages as usize && !terminal_notification {
            return Err(anyhow!("group has reached its pending message limit"));
        }
        if params.reply_to.is_some() {
            let original = reply_target.as_ref().expect("reply target loaded above");
            if original.group_id != group.id {
                return Err(anyhow!("reply target belongs to another group"));
            }
            if original.assignment_id != params.assignment_id {
                return Err(anyhow!("reply must preserve the original assignment correlation"));
            }
            if params.purpose == CollaborationMessagePurpose::Reply
                && !matches!(original.purpose, CollaborationMessagePurpose::Question | CollaborationMessagePurpose::ChangeRequest)
            {
                return Err(anyhow!("reply_to must identify a directed question or change request"));
            }
            let correctly_addressed = original.to_thread_id == from_thread_id.unwrap_or(params.to_thread_id)
                && original.from_thread_id == Some(params.to_thread_id);
            if !correctly_addressed {
                return Err(anyhow!("reply sender and recipient do not match the original message"));
            }
        } else if params.purpose == CollaborationMessagePurpose::Reply {
            return Err(anyhow!("reply messages must name reply_to"));
        }
        let now = Utc::now();
        let request = params.clone();
        let assignment_is_terminal = assignment.as_ref().is_some_and(|assignment| {
            matches!(assignment.status, AssignmentStatus::Completed | AssignmentStatus::Failed | AssignmentStatus::Cancelled)
        });
        let terminal_recovery = assignment.as_ref().is_some_and(|assignment| {
            params.purpose == CollaborationMessagePurpose::Result && params.operation_id == derived_operation_id(assignment.id, 0x72)
        });
        let duplicate_result = assignment_is_terminal
            && from_thread_id.is_some()
            && params.purpose == CollaborationMessagePurpose::Result
            && !terminal_recovery
            && existing_messages.iter().any(|message| {
                message.assignment_id == params.assignment_id
                    && message.from_thread_id == from_thread_id
                    && message.to_thread_id == params.to_thread_id
                    && message.purpose == params.purpose
                    && message.reply_to == params.reply_to
                    && message.body == params.body
                    && !matches!(message.state, CollaborationDeliveryState::Failed | CollaborationDeliveryState::Uncertain)
            });
        let mut should_wake = group.status == GroupStatus::Active
            && recipient_group_status != Some(GroupStatus::Paused)
            && params.purpose != CollaborationMessagePurpose::Progress
            && !duplicate_result;
        if pending >= group.policy.max_pending_messages as usize && terminal_notification {
            should_wake = false;
        }
        if should_wake && let Some(assignment_id) = params.assignment_id {
            let used: u32 = existing_messages
                .iter()
                .filter(|message| message.assignment_id == Some(assignment_id))
                .map(|message| message.wakeup_count)
                .sum();
            if used >= group.policy.max_wakeups_per_assignment {
                if matches!(params.purpose, CollaborationMessagePurpose::Result | CollaborationMessagePurpose::Failure) {
                    should_wake = false;
                } else {
                    return Err(anyhow!("assignment has reached its automatic wakeup limit"));
                }
            }
        }
        if should_wake && route_is_external {
            let initiator = reply_target
                .as_ref()
                .filter(|message| message.external_recipient)
                .and_then(|message| message.from_thread_id)
                .or(actor_thread);
            let peer = actor_thread.unwrap_or(params.to_thread_id);
            let reset_at = initiator.map(|thread_id| self.inner.store.thread_latest_human_turn_at(thread_id)).transpose()?.flatten();
            let used: u32 = existing_messages
                .iter()
                .filter(|message| {
                    message.assignment_id.is_none()
                        && reset_at.is_none_or(|reset_at| message.created_at >= reset_at)
                        && ((message.from_thread_id == Some(peer) && message.to_thread_id == params.to_thread_id)
                            || (message.from_thread_id == Some(params.to_thread_id) && message.to_thread_id == peer))
                })
                .map(|message| message.wakeup_count)
                .sum();
            if used >= group.policy.max_wakeups_per_assignment {
                if terminal_notification {
                    should_wake = false;
                } else {
                    return Err(anyhow!("external thread route has reached its automatic wakeup limit"));
                }
            }
        }
        let message = CollaborationMessage {
            id: params.operation_id,
            operation_id: params.operation_id,
            group_id: group.id,
            assignment_id: params.assignment_id,
            from_thread_id,
            to_thread_id: params.to_thread_id,
            external_recipient,
            purpose: params.purpose,
            reply_to: params.reply_to,
            body: params.body,
            state: if should_wake { CollaborationDeliveryState::Queued } else { CollaborationDeliveryState::Persisted },
            delivery_turn_id: None,
            wakeup_count: u32::from(should_wake),
            created_at: now,
            updated_at: now,
        };
        let mut answered = None;
        if message.purpose == CollaborationMessagePurpose::Reply
            && let Some(reply_to) = message.reply_to
            && let Some(mut original) = self.inner.store.collaboration_message_get(reply_to)?
            && original.purpose == CollaborationMessagePurpose::Question
        {
            original.state = CollaborationDeliveryState::Answered;
            original.updated_at = Utc::now();
            answered = Some(original);
        }
        let (message, events) = self.inner.store.collaboration_message_create_operation(
            params.operation_id,
            &actor,
            &request,
            &message,
            should_wake.then_some(message.id),
            answered.as_ref(),
        )?;
        self.broadcast_committed_collaboration(events);
        Ok(message)
    }

    pub fn collaboration_messages_list(
        &self,
        params: methods::CollaborationMessagesListParams,
    ) -> Result<methods::CollaborationMessagesListResult> {
        let mut messages = self.inner.store.collaboration_messages(params.group_id)?;
        messages.retain(|message| {
            params.thread_id.is_none_or(|id| message.from_thread_id == Some(id) || message.to_thread_id == id)
                && params.assignment_id.is_none_or(|id| message.assignment_id == Some(id))
        });
        messages.sort_by_key(|message| message.id);
        page_by_id(&mut messages, params.cursor.as_deref(), params.limit, |message| message.id)
            .map(|(messages, next_cursor)| methods::CollaborationMessagesListResult { messages, next_cursor })
    }

    pub fn collaboration_context_put(
        &self,
        params: methods::CollaborationContextPutParams,
        actor_thread: Option<ThreadId>,
    ) -> Result<ContextEntry> {
        let actor = actor_thread.map_or_else(|| "human".into(), |id| format!("thread:{id}"));
        if let Some(receipt) = self.collaboration_receipt(params.operation_id, &actor, "context.put", &params)? {
            return Ok(receipt);
        }
        let request = params.clone();
        let group = self.inner.store.collaboration_group_get(params.group_id)?.ok_or_else(|| anyhow!("collaboration group not found"))?;
        if params.key.trim().is_empty() || params.body.len() > 128 * 1024 {
            return Err(anyhow!("context key is required and body must stay under 128 KiB"));
        }
        let author_thread_id = match actor_thread {
            Some(id) => {
                let member = self.require_collaboration_actor(&group, id)?;
                if member.role == GroupMemberRole::Observer {
                    return Err(anyhow!("observer members are reference-only and cannot author shared context"));
                }
                if matches!(params.kind, ContextEntryKind::Brief | ContextEntryKind::Instruction) {
                    return Err(anyhow!("agents cannot author group briefs or instructions"));
                }
                Some(id)
            }
            None => {
                if params.author_thread_id.is_some() {
                    return Err(anyhow!("client requests cannot impersonate an agent thread"));
                }
                None
            }
        };
        let knowledge_group_id = self.project_knowledge_group_id(&group)?;
        let key = params.key.trim().to_owned();
        let previous = self.inner.store.collaboration_context_by_key(knowledge_group_id, &key)?;
        let correcting_setup = key == "project.setup" && previous.is_some() && actor_thread.is_none();
        if key == "project.setup" && !correcting_setup {
            if self.inner.store.project_coordinator_for_group(group.id)?.is_none()
                || actor_thread != Some(group.coordinator_thread_id)
                || params.kind != ContextEntryKind::Research
                || params.body.trim().is_empty()
            {
                return Err(anyhow!("Only the current coordinator can complete setup by saving a reviewed research overview."));
            }
            let researched = self.inner.store.collaboration_assignments(group.id, true)?.iter().any(|assignment| {
                assignment.kind == AssignmentKind::Research
                    && assignment.owner_thread_id.is_some_and(|id| id != group.coordinator_thread_id)
                    && assignment.status == AssignmentStatus::Completed
                    && assignment.result.as_ref().is_some_and(|result| result.outcome == AssignmentOutcome::Success)
                    && params.source_refs.contains(&assignment.id.to_string())
            });
            if !researched {
                return Err(anyhow!(
                    "Review a successful research assignment first, then include its assignment ID in source_refs when saving project.setup."
                ));
            }
        }
        if let Some(previous) = &previous {
            if params.entry_id.is_some_and(|id| id != previous.id) {
                return Err(anyhow!("context key belongs to another entry id"));
            }
            if params.expected_revision != Some(previous.revision) {
                return Err(anyhow!("context changed; reload its history and retry with the current revision"));
            }
            if actor_thread.is_some() && previous.user_authored {
                return Err(anyhow!("agents cannot overwrite user-authored context"));
            }
        } else if params.expected_revision.is_some() {
            return Err(anyhow!("new context entries must omit expected_revision"));
        }
        let now = Utc::now();
        let entry = ContextEntry {
            id: previous.as_ref().map_or(params.entry_id.unwrap_or(params.operation_id), |entry| entry.id),
            group_id: knowledge_group_id,
            key,
            kind: params.kind,
            body: params.body,
            author_thread_id,
            user_authored: actor_thread.is_none(),
            revision: previous.as_ref().map_or(1, |entry| entry.revision + 1),
            source_refs: if correcting_setup { previous.as_ref().expect("existing setup").source_refs.clone() } else { params.source_refs },
            created_at: previous.as_ref().map_or(now, |entry| entry.created_at),
            updated_at: now,
        };
        let entry =
            self.inner.store.collaboration_context_operation(params.operation_id, &actor, &request, &entry, params.expected_revision)?;
        self.emit_project_context(group.project_id, EventPayload::CollaborationContextUpdated { entry: entry.clone() })?;
        Ok(entry)
    }

    pub fn collaboration_context_list(
        &self,
        params: methods::CollaborationContextListParams,
    ) -> Result<methods::CollaborationContextListResult> {
        let group = self.inner.store.collaboration_group_get(params.group_id)?.ok_or_else(|| anyhow!("collaboration group not found"))?;
        let knowledge_group_id = self.project_knowledge_group_id(&group)?;
        let mut entries = self.inner.store.collaboration_context_latest(knowledge_group_id)?;
        if knowledge_group_id != group.id {
            let mut local = self.inner.store.collaboration_context_latest(group.id)?;
            local.retain(|entry| !entries.iter().any(|project_entry| project_entry.key == entry.key));
            entries.extend(local);
        }
        entries.retain(|entry| {
            (params.keys.is_empty() || params.keys.contains(&entry.key)) && (params.kinds.is_empty() || params.kinds.contains(&entry.kind))
        });
        entries.sort_by_key(|entry| entry.id);
        page_by_id(&mut entries, params.cursor.as_deref(), params.limit, |entry| entry.id)
            .map(|(entries, next_cursor)| methods::CollaborationContextListResult { entries, next_cursor })
    }

    pub fn collaboration_context_history(&self, params: methods::CollaborationContextHistoryParams) -> Result<ContextEntryHistory> {
        let entry_id = params.entry_id;
        let mut revisions = self.inner.store.collaboration_context_history(entry_id)?;
        if revisions.is_empty() {
            return Err(anyhow!("context entry not found"));
        }
        revisions.retain(|entry| params.before_revision.is_none_or(|before| entry.revision < before));
        revisions.sort_by_key(|entry| std::cmp::Reverse(entry.revision));
        let limit = params.limit.clamp(1, 200) as usize;
        let has_more = revisions.len() > limit;
        revisions.truncate(limit);
        let next_before_revision = has_more.then(|| revisions.last().map(|entry| entry.revision)).flatten();
        Ok(ContextEntryHistory { entry_id, revisions, next_before_revision })
    }

    fn collaboration_changes_since(
        &self,
        group_id: GroupId,
        after: EventSeq,
        assignment_ids: &[AssignmentId],
    ) -> Result<methods::CollaborationWaitResult> {
        let events = self.inner.store.collaboration_events_after(group_id, after, 200, 192 * 1024)?;
        let mut cursor = after;
        let mut group = None;
        let mut members = std::collections::BTreeMap::new();
        let mut assignments = std::collections::BTreeMap::new();
        let mut messages = std::collections::BTreeMap::new();
        let mut context_entries = std::collections::BTreeMap::new();
        for event in events {
            cursor = event.seq;
            match event.payload {
                EventPayload::CollaborationGroupUpdated { group: changed } => {
                    let current = self.inner.store.collaboration_group_get(changed.id)?;
                    if assignment_ids.is_empty() || current.as_ref().is_some_and(|group| group.status != GroupStatus::Active) {
                        group = current;
                    }
                }
                EventPayload::CollaborationMemberUpdated { member } if assignment_ids.is_empty() => {
                    if let Some(current) =
                        self.inner.store.collaboration_members(group_id)?.into_iter().find(|current| current.thread_id == member.thread_id)
                    {
                        members.insert(member.thread_id, current);
                    }
                }
                EventPayload::CollaborationAssignmentUpdated { assignment }
                    if assignment_ids.is_empty() || assignment_ids.contains(&assignment.id) =>
                {
                    if let Some(current) = self.inner.store.collaboration_assignment_get(assignment.id)? {
                        assignments.insert(assignment.id, current);
                    }
                }
                EventPayload::CollaborationMessageUpdated { message }
                    if assignment_ids.is_empty() || message.assignment_id.is_some_and(|id| assignment_ids.contains(&id)) =>
                {
                    if let Some(current) = self.inner.store.collaboration_message_get(message.id)? {
                        messages.insert(message.id, current);
                    }
                }
                EventPayload::CollaborationContextUpdated { entry } if assignment_ids.is_empty() => {
                    if let Some(current) = self.inner.store.collaboration_context_by_key(entry.group_id, &entry.key)? {
                        context_entries.insert(entry.id, current);
                    }
                }
                _ => {}
            }
        }
        Ok(methods::CollaborationWaitResult {
            cursor: format_change_cursor(group_id, cursor),
            timed_out: false,
            group,
            members: members.into_values().collect(),
            assignments: assignments.into_values().collect(),
            messages: messages.into_values().collect(),
            context_entries: context_entries.into_values().collect(),
        })
    }

    pub async fn collaboration_wait(&self, params: methods::CollaborationWaitParams) -> Result<methods::CollaborationWaitResult> {
        self.inner.store.collaboration_group_get(params.group_id)?.ok_or_else(|| anyhow!("collaboration group not found"))?;
        for assignment_id in &params.assignment_ids {
            if self
                .inner
                .store
                .collaboration_assignment_get(*assignment_id)?
                .is_none_or(|assignment| assignment.group_id != params.group_id)
            {
                return Err(anyhow!("wait assignment belongs to another group or no longer exists"));
            }
        }
        let mut after = params.cursor.as_deref().map(|cursor| parse_change_cursor(params.group_id, cursor)).transpose()?.unwrap_or(0);
        if after > self.inner.store.events_head_seq()? {
            return Err(anyhow!("collaboration cursor is ahead of this daemon's event history"));
        }
        let deadline = tokio::time::Instant::now() + Duration::from_millis(u64::from(params.timeout_ms.min(60_000)));
        loop {
            // Register before querying. A result arriving between the read and
            // await must wake every waiter without consuming scheduler signals.
            let notified = self.inner.collaboration_wakeup.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let mut result = self.collaboration_changes_since(params.group_id, after, &params.assignment_ids)?;
            if result.group.is_some()
                || !result.members.is_empty()
                || !result.assignments.is_empty()
                || !result.messages.is_empty()
                || !result.context_entries.is_empty()
            {
                return Ok(result);
            }
            let next = parse_change_cursor(params.group_id, &result.cursor)?;
            if tokio::time::Instant::now() >= deadline {
                result.timed_out = true;
                return Ok(result);
            }
            if next > after {
                after = next;
                continue;
            }
            // On timeout, query once more before returning so a boundary race
            // does not turn an already-persisted result into a stale timeout.
            let _ = tokio::time::timeout_at(deadline, notified).await;
        }
    }

    pub fn execute_native_app_tool_call<'a>(
        &'a self,
        thread_id: ThreadId,
        session_instance_id: Uuid,
        call_id: &'a str,
        name: &'a str,
        mut arguments: serde_json::Value,
    ) -> futures::future::BoxFuture<'a, Result<serde_json::Value>> {
        Box::pin(async move {
            let live = self
                .inner
                .sessions
                .lock()
                .await
                .get(&thread_id)
                .cloned()
                .ok_or_else(|| anyhow!("native tool caller session is no longer active"))?;
            if live.session_instance_id != session_instance_id {
                return Err(anyhow!("native tool credential belongs to a replaced session"));
            }
            let turn_id = self
                .owns_app_tool_turn(thread_id, &live, None)
                .await
                .ok_or_else(|| anyhow!("native tool request has no active owning turn"))?;
            let operation_id =
                crate::app_tools::prepare_native_operation(thread_id, session_instance_id, turn_id, call_id, name, &mut arguments)?;
            let mut result = self.execute_native_app_tool(thread_id, session_instance_id, name, arguments).await?;
            if let (Some(id), Some(object)) = (operation_id, result.as_object_mut()) {
                object.insert("operation_id".into(), serde_json::to_value(id)?);
            }
            Ok(result)
        })
    }

    pub fn execute_native_app_tool<'a>(
        &'a self,
        thread_id: ThreadId,
        session_instance_id: Uuid,
        name: &'a str,
        mut arguments: serde_json::Value,
    ) -> futures::future::BoxFuture<'a, Result<serde_json::Value>> {
        Box::pin(async move {
            let live = self
                .inner
                .sessions
                .lock()
                .await
                .get(&thread_id)
                .cloned()
                .ok_or_else(|| anyhow!("native tool caller session is no longer active"))?;
            if live.session_instance_id != session_instance_id {
                return Err(anyhow!("native tool credential belongs to a replaced session"));
            }
            let thread = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("native tool caller thread no longer exists"))?;
            let restrictions = self.native_tool_restrictions(&thread)?;
            if (!restrictions.allowed_tools.is_empty() && !restrictions.allowed_tools.iter().any(|allowed| allowed == name))
                || restrictions.denied_tools.iter().any(|denied| denied == name)
            {
                return Err(anyhow!("This tool is unavailable to the project coordinator. Delegate the task to a worker."));
            }
            let turn_id = live
                .turn
                .lock()
                .await
                .as_ref()
                .filter(|turn| !turn.completed)
                .map(|turn| turn.id)
                .ok_or_else(|| anyhow!("native tool request has no active owning turn"))?;
            if name.starts_with("kybern_collaboration_") || name == "kybern_thread_send" {
                let object = arguments.as_object_mut().ok_or_else(|| anyhow!("tool arguments must be a JSON object"))?;
                let existing_group = self.inner.store.collaboration_group_for_thread(thread_id)?;
                if existing_group.is_none() && name == "kybern_collaboration_context_read" {
                    let Some((_, group_id)) = self.inner.store.project_coordinator(thread.project_id)? else {
                        object.insert("group_id".into(), serde_json::to_value(Uuid::nil())?);
                        let _params: methods::CollaborationContextListParams = crate::app_tools::parse(arguments)?;
                        return Ok(serde_json::to_value(methods::CollaborationContextListResult {
                            entries: Vec::new(),
                            next_cursor: None,
                        })?);
                    };
                    object.insert("group_id".into(), serde_json::to_value(group_id)?);
                    let params: methods::CollaborationContextListParams = crate::app_tools::parse(arguments)?;
                    return Ok(serde_json::to_value(self.collaboration_context_list(params)?)?);
                }
                if existing_group.is_none() && name == "kybern_collaboration_read" {
                    let target = object.remove("thread_id");
                    let _transcript_limit = object.remove("transcript_limit");
                    if target.is_some() || !object.is_empty() {
                        return Err(anyhow!("there is no collaboration group to read; use kybern_thread_read for an existing thread"));
                    }
                    return Ok(serde_json::json!({
                        "group": null,
                        "members": [],
                        "assignments": [],
                        "pending_messages": [],
                        "caller": {"thread_id":thread_id,"group_id":null,"assignment":null}
                    }));
                }
                let group_id = if matches!(name, "kybern_collaboration_send" | "kybern_thread_send") {
                    match object.get("reply_to").filter(|value| !value.is_null()) {
                        Some(value) => {
                            let reply_to: CollaborationMessageId = serde_json::from_value(value.clone())?;
                            self.inner.store.collaboration_message_get(reply_to)?.ok_or_else(|| anyhow!("reply target not found"))?.group_id
                        }
                        None => self.ensure_ordinary_collaboration_group(thread_id).await?,
                    }
                } else if matches!(name, "kybern_collaboration_spawn" | "kybern_collaboration_context_put") {
                    self.ensure_ordinary_collaboration_group(thread_id).await?
                } else {
                    existing_group.ok_or_else(|| anyhow!("caller is not in an active collaboration group"))?
                };
                let value = match name {
                    "kybern_collaboration_spawn" => {
                        object.insert("group_id".into(), serde_json::to_value(group_id)?);
                        serde_json::to_value(
                            self.collaboration_assignment_create(
                                crate::app_tools::parse(arguments)?,
                                Some(thread_id),
                                Some(session_instance_id),
                            )
                            .await?,
                        )?
                    }
                    "kybern_collaboration_send" | "kybern_thread_send" => {
                        object.insert("group_id".into(), serde_json::to_value(group_id)?);
                        object.insert("from_thread_id".into(), serde_json::to_value(thread_id)?);
                        let guard = live.turn.lock().await;
                        if guard.as_ref().is_none_or(|turn| turn.id != turn_id || turn.completed) {
                            return Err(anyhow!("native tool caller turn ended before mutation reservation"));
                        }
                        let value =
                            serde_json::to_value(self.collaboration_message_send(crate::app_tools::parse(arguments)?, Some(thread_id))?)?;
                        drop(guard);
                        value
                    }
                    "kybern_collaboration_read" => {
                        let target: Option<ThreadId> = object.remove("thread_id").map(serde_json::from_value).transpose()?;
                        let transcript_limit: usize =
                            object.remove("transcript_limit").map(serde_json::from_value).transpose()?.unwrap_or(50usize).clamp(1, 100);
                        if !object.is_empty() {
                            return Err(anyhow!("unknown collaboration read fields"));
                        }
                        let mut detail = self.collaboration_group_detail(group_id)?;
                        // The UI projection is group-wide, but an agent inbox must
                        // filter by recipient before applying its bound. Otherwise
                        // old updates to peers can crowd out this caller's new work.
                        detail.pending_messages = self.inner.store.collaboration_pending_messages_for_thread(group_id, thread_id, 100)?;
                        let mut value = serde_json::to_value(&detail)?;
                        let caller_assignment = self.inner.store.collaboration_active_assignment_for_thread(thread_id)?;
                        value.as_object_mut().expect("detail serializes as object").insert(
                            "caller".into(),
                            serde_json::json!({"thread_id":thread_id,"group_id":group_id,"assignment":caller_assignment}),
                        );
                        if let Some(target) = target {
                            let group = self.inner.store.collaboration_group_get(group_id)?.ok_or_else(|| anyhow!("group not found"))?;
                            self.require_collaboration_actor(&group, target)?;
                            let thread = self.inner.store.thread_get(target)?.ok_or_else(|| anyhow!("participant thread not found"))?;
                            let events = self.inner.store.events_for_thread_recent(target, 1000)?;
                            let mut transcript = kybern_store::project_transcript(&events);
                            if transcript.len() > transcript_limit {
                                transcript.drain(..transcript.len() - transcript_limit);
                            }
                            let assignments: Vec<_> = self
                                .inner
                                .store
                                .collaboration_assignments(group_id, true)?
                                .into_iter()
                                .filter(|assignment| assignment.owner_thread_id == Some(target))
                                .collect();
                            value.as_object_mut().expect("detail serializes as object").insert("participant".into(), serde_json::json!({"thread":thread,"transcript":transcript,"assignments":assignments,"diff_reference":{"thread_id":target,"worktree":thread.worktree}}));
                        }
                        // A successful agent read delivers exactly the messages in this
                        // bounded snapshot. UI reads remain read-only; other recipients and
                        // messages arriving after the snapshot must keep their wakeups.
                        let guard = live.turn.lock().await;
                        if guard.as_ref().is_none_or(|turn| turn.id != turn_id || turn.completed) {
                            return Err(anyhow!("native tool caller turn ended before read delivery acknowledgement"));
                        }
                        self.observe_collaboration_messages(thread_id, turn_id, &mut detail.pending_messages)?;
                        self.observe_collaboration_assignment_results(thread_id, turn_id, &detail.assignments)?;
                        value["pending_messages"] = serde_json::to_value(detail.pending_messages)?;
                        drop(guard);
                        value
                    }
                    "kybern_collaboration_wait" => {
                        object.insert("group_id".into(), serde_json::to_value(group_id)?);
                        cap_native_collaboration_wait(object);
                        let mut result = self.collaboration_wait(crate::app_tools::parse(arguments)?).await?;
                        let guard = live.turn.lock().await;
                        if guard.as_ref().is_none_or(|turn| turn.id != turn_id || turn.completed) {
                            return Err(anyhow!("native tool caller turn ended before wait delivery acknowledgement"));
                        }
                        self.observe_collaboration_messages(thread_id, turn_id, &mut result.messages)?;
                        self.observe_collaboration_assignment_results(thread_id, turn_id, &result.assignments)?;
                        drop(guard);
                        serde_json::to_value(result)?
                    }
                    "kybern_collaboration_report" => {
                        let operation_id: OperationId = take_required(object, "operation_id")?;
                        let assignment_id: AssignmentId = take_required(object, "assignment_id")?;
                        let outcome: AssignmentOutcome = take_required(object, "outcome")?;
                        let summary: String = take_required(object, "summary")?;
                        let changes = take_default(object, "changes")?;
                        let checks = take_default(object, "checks")?;
                        let artifacts = take_default(object, "artifacts")?;
                        let unresolved = take_default(object, "unresolved")?;
                        if !object.is_empty() {
                            return Err(anyhow!("unknown report fields"));
                        }
                        let params = methods::CollaborationAssignmentsCompleteParams {
                            operation_id,
                            assignment_id,
                            result: AssignmentResult { outcome, summary, changes, checks, artifacts, unresolved, completed_at: Utc::now() },
                        };
                        let guard = live.turn.lock().await;
                        if guard.as_ref().is_none_or(|turn| turn.id != turn_id || turn.completed) {
                            return Err(anyhow!("native tool caller turn ended before mutation reservation"));
                        }
                        let value = serde_json::to_value(self.collaboration_assignment_complete(params, Some(thread_id))?)?;
                        drop(guard);
                        value
                    }
                    "kybern_collaboration_cancel" => serde_json::to_value(
                        self.collaboration_assignment_cancel(
                            crate::app_tools::parse(arguments)?,
                            Some(thread_id),
                            Some(session_instance_id),
                        )
                        .await?,
                    )?,
                    "kybern_collaboration_context_read" => {
                        object.insert("group_id".into(), serde_json::to_value(group_id)?);
                        serde_json::to_value(self.collaboration_context_list(crate::app_tools::parse(arguments)?)?)?
                    }
                    "kybern_collaboration_context_put" => {
                        object.insert("group_id".into(), serde_json::to_value(group_id)?);
                        object.insert("author_thread_id".into(), serde_json::to_value(thread_id)?);
                        object.insert("user_authored".into(), serde_json::Value::Bool(false));
                        let guard = live.turn.lock().await;
                        if guard.as_ref().is_none_or(|turn| turn.id != turn_id || turn.completed) {
                            return Err(anyhow!("native tool caller turn ended before mutation reservation"));
                        }
                        let value =
                            serde_json::to_value(self.collaboration_context_put(crate::app_tools::parse(arguments)?, Some(thread_id))?)?;
                        drop(guard);
                        value
                    }
                    _ => return Err(anyhow!("unknown Kybern collaboration tool: {name}")),
                };
                let current = self.inner.sessions.lock().await.get(&thread_id).cloned();
                if current.as_ref().is_none_or(|current| current.session_instance_id != session_instance_id) {
                    return Err(anyhow!("native tool caller session ended before its result was delivered"));
                }
                if current.unwrap().turn.lock().await.as_ref().is_none_or(|turn| turn.id != turn_id || turn.completed) {
                    return Err(anyhow!("native tool caller turn ended before its result was delivered"));
                }
                return Ok(value);
            }
            let mut value = self.inner.app_tools.execute(thread_id, name, arguments).await?;
            if name == "kybern_thread_context" {
                let cached = self.cached_provider_statuses(thread.project_id).await?;
                let catalog_state = if cached.is_some() {
                    "cached"
                } else {
                    let this = self.clone();
                    let project_id = thread.project_id;
                    tokio::spawn(async move {
                        if let Err(error) = this.refresh_provider_statuses(project_id).await {
                            tracing::warn!(%project_id, %error, "provider catalog background refresh failed");
                        }
                    });
                    "loading"
                };
                let mut providers = cached
                    .unwrap_or_default()
                    .into_iter()
                    .map(|status| {
                        let model_count = status.models.len();
                        let models = status
                            .models
                            .into_iter()
                            .take(32)
                            .map(|model| {
                                let mut id = model.id;
                                let mut display_name = model.display_name;
                                truncate_utf8(&mut id, 256);
                                truncate_utf8(&mut display_name, 256);
                                let efforts = model
                                    .efforts
                                    .into_iter()
                                    .take(20)
                                    .map(|mut effort| {
                                        truncate_utf8(&mut effort, 128);
                                        effort
                                    })
                                    .collect::<Vec<_>>();
                                serde_json::json!({
                                    "id": id,
                                    "display_name": display_name,
                                    "efforts": efforts,
                                    "default_effort": model.default_effort,
                                    "is_default": model.is_default,
                                })
                            })
                            .collect::<Vec<_>>();
                        serde_json::json!({
                            "kind": status.kind,
                            "available": status.available,
                            "unavailable_reason": status.unavailable_reason,
                            "instances": status.instances,
                            "supported_permission_modes": status.supported_permission_modes,
                            "supports_fork": status.supports_fork,
                            "supports_model_switch": status.supports_model_switch,
                            "supports_effort_switch": status.supports_effort_switch,
                            "supported_efforts": status.supported_efforts,
                            "models": models,
                            "models_truncated": model_count.saturating_sub(32),
                        })
                    })
                    .collect::<Vec<_>>();
                if catalog_state == "loading" {
                    providers.extend(ProviderKind::ALL.into_iter().map(|kind| {
                        serde_json::json!({
                            "kind": kind,
                            "available": null,
                            "unavailable_reason": "provider catalog is loading for this project",
                            "instances": ["default"],
                            "supported_permission_modes": [],
                            "supports_fork": null,
                            "supports_model_switch": null,
                            "supports_effort_switch": null,
                            "supported_efforts": [],
                            "models": [],
                            "models_truncated": 0,
                        })
                    }));
                }
                let object = value.as_object_mut().expect("thread context serializes as an object");
                object.insert("providers".into(), providers.into());
                object.insert("provider_catalog_state".into(), catalog_state.into());
                if serde_json::to_vec(&value)?.len() > 256 * 1024 {
                    return Err(anyhow!("tool result exceeds the 256 KiB limit"));
                }
            }
            Ok(value)
        })
    }

    /// Acknowledge the bounded inbox returned to an active agent tool call.
    fn observe_collaboration_messages(&self, thread_id: ThreadId, turn_id: TurnId, messages: &mut [CollaborationMessage]) -> Result<()> {
        for message in messages.iter_mut().filter(|message| {
            message.to_thread_id == thread_id
                && matches!(message.state, CollaborationDeliveryState::Persisted | CollaborationDeliveryState::Queued)
        }) {
            message.state = CollaborationDeliveryState::Submitted;
            message.delivery_turn_id = Some(turn_id);
            message.updated_at = Utc::now();
            let events = self.inner.store.collaboration_message_observed(message, turn_id)?;
            if events.is_empty()
                && let Some(current) = self.inner.store.collaboration_message_get(message.id)?
            {
                *message = current;
            }
            self.broadcast_committed_collaboration(events);
        }
        Ok(())
    }

    /// A structured terminal assignment returned by read/wait carries the same
    /// information as its queued result notification. Consume that exact class
    /// of wakeup even when bounded message pagination omitted it; questions,
    /// change requests, replies, failures, and unrelated results remain queued.
    fn observe_collaboration_assignment_results(
        &self,
        thread_id: ThreadId,
        turn_id: TurnId,
        assignments: &[CollaborationAssignment],
    ) -> Result<()> {
        let surfaced = assignments
            .iter()
            .filter_map(|assignment| {
                assignment.result.as_ref().map(|result| {
                    (
                        assignment.id,
                        (
                            assignment.owner_thread_id,
                            format!("Assignment {} finished with {:?}: {}", assignment.id, result.outcome, result.summary),
                        ),
                    )
                })
            })
            .collect::<HashMap<_, _>>();
        if surfaced.is_empty() {
            return Ok(());
        }
        let Some(group_id) = assignments.first().map(|assignment| assignment.group_id) else { return Ok(()) };
        let mut messages = self.inner.store.collaboration_queued_results(group_id, thread_id)?;
        messages.retain(|message| {
            message
                .assignment_id
                .and_then(|id| surfaced.get(&id))
                .is_some_and(|(owner, body)| message.from_thread_id == *owner && message.reply_to.is_none() && message.body == *body)
        });
        self.observe_collaboration_messages(thread_id, turn_id, &mut messages)
    }

    /// Called only after the native harness accepted a persisted message.
    fn collaboration_delivery_submitted(&self, thread_id: ThreadId, turn_id: TurnId, message_id: MessageId) -> Result<()> {
        if let Some(mut assignment) = self.inner.store.collaboration_assignment_for_dispatch(message_id)?
            && assignment.owner_thread_id == Some(thread_id)
            && assignment.status == AssignmentStatus::Waiting
        {
            assignment.status = AssignmentStatus::Working;
            assignment.uncertainty = None;
            assignment.revision += 1;
            assignment.updated_at = Utc::now();
            self.inner.store.collaboration_assignment_put(&assignment)?;
            self.emit_collaboration(assignment.group_id, EventPayload::CollaborationAssignmentUpdated { assignment })?;
        }
        if let Some(mut message) = self.inner.store.collaboration_message_for_delivery(message_id)?
            && message.to_thread_id == thread_id
            && message.state == CollaborationDeliveryState::Queued
        {
            message.state = CollaborationDeliveryState::Submitted;
            message.delivery_turn_id = Some(turn_id);
            message.updated_at = Utc::now();
            self.inner.store.collaboration_message_put(&message, Some(message_id))?;
            self.emit_collaboration(message.group_id, EventPayload::CollaborationMessageUpdated { message })?;
        }
        Ok(())
    }

    pub async fn drain_collaboration_assignments(&self) -> Result<bool> {
        let _collaboration_command = self.inner.collaboration_commands.lock().await;
        let mut waiting = false;
        for group in self.inner.store.collaboration_groups_list(None, false)? {
            if group.status != GroupStatus::Active {
                continue;
            }
            let mut assignments = self.inner.store.collaboration_assignments(group.id, false)?;
            let active = assignments
                .iter()
                .filter(|a| {
                    a.owner_thread_id.is_some()
                        && matches!(a.status, AssignmentStatus::Working | AssignmentStatus::Waiting)
                        && !(a.owner_thread_id == Some(group.coordinator_thread_id) && a.kind == AssignmentKind::Coordination)
                })
                .count();
            let mut slots = group.policy.max_active_workers.saturating_sub(active as u32);
            for assignment in assignments.iter_mut().filter(|a| a.status == AssignmentStatus::Pending) {
                if slots == 0 {
                    waiting = true;
                    break;
                }
                if let Err(error) = self.start_collaboration_assignment(&group, assignment).await {
                    assignment.status = AssignmentStatus::AttentionNeeded;
                    assignment.uncertainty = Some(format!("could not start assignment: {error}"));
                    assignment.revision += 1;
                    assignment.updated_at = Utc::now();
                    self.inner.store.collaboration_assignment_put(assignment)?;
                }
                self.emit_collaboration(group.id, EventPayload::CollaborationAssignmentUpdated { assignment: assignment.clone() })?;
                slots -= 1;
            }
        }
        Ok(waiting)
    }
}

fn page_by_id<T>(
    items: &mut Vec<T>,
    cursor: Option<&str>,
    requested_limit: u32,
    id: impl Fn(&T) -> Uuid,
) -> Result<(Vec<T>, Option<String>)> {
    let cursor = cursor.map(str::parse::<Uuid>).transpose().map_err(|_| anyhow!("invalid collaboration cursor"))?;
    if let Some(cursor) = cursor {
        items.retain(|item| id(item) > cursor);
    }
    let limit = requested_limit.clamp(1, 200) as usize;
    let has_more = items.len() > limit;
    items.truncate(limit);
    let next = has_more.then(|| items.last().map(|item| id(item).to_string())).flatten();
    Ok((std::mem::take(items), next))
}

fn parse_change_cursor(group_id: GroupId, cursor: &str) -> Result<EventSeq> {
    let (group, sequence) = cursor.split_once(':').ok_or_else(|| anyhow!("invalid collaboration wait cursor"))?;
    let parsed_group: GroupId = group.parse().map_err(|_| anyhow!("invalid collaboration wait cursor"))?;
    let sequence: EventSeq = sequence.parse().map_err(|_| anyhow!("invalid collaboration wait cursor"))?;
    if parsed_group != group_id || sequence < 0 {
        return Err(anyhow!("collaboration cursor belongs to another group or is invalid"));
    }
    Ok(sequence)
}

fn format_change_cursor(group_id: GroupId, sequence: EventSeq) -> String {
    format!("{group_id}:{sequence}")
}

const NATIVE_COLLABORATION_WAIT_MAX_MS: u64 = 30_000;

fn cap_native_collaboration_wait(object: &mut serde_json::Map<String, serde_json::Value>) {
    if object.get("timeout_ms").and_then(serde_json::Value::as_u64).is_some_and(|timeout| timeout > NATIVE_COLLABORATION_WAIT_MAX_MS) {
        object.insert("timeout_ms".into(), NATIVE_COLLABORATION_WAIT_MAX_MS.into());
    }
}

fn take_required<T: serde::de::DeserializeOwned>(object: &mut serde_json::Map<String, serde_json::Value>, key: &str) -> Result<T> {
    serde_json::from_value(object.remove(key).ok_or_else(|| anyhow!("{key} is required"))?).map_err(Into::into)
}

fn take_default<T: serde::de::DeserializeOwned + Default>(object: &mut serde_json::Map<String, serde_json::Value>, key: &str) -> Result<T> {
    object.remove(key).map(serde_json::from_value).transpose().map(|value| value.unwrap_or_default()).map_err(Into::into)
}

fn derived_operation_id(base: Uuid, discriminator: u8) -> Uuid {
    let mut bytes = *base.as_bytes();
    bytes[0] ^= discriminator;
    Uuid::from_bytes(bytes)
}

fn truncate_utf8(text: &mut String, max_bytes: usize) {
    if text.len() <= max_bytes {
        return;
    }
    let mut end = max_bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
}

/// Live filesystem probe for a project's git status, mirroring the check
/// `add_project` uses at registration. The cached `Project.is_git` is computed
/// only once, so callers that gate git-only behavior (edit/integration spawns,
/// child worktrees) re-probe through this to pick up a later `git init`.
fn project_path_is_git(project_path: &str) -> bool {
    std::path::Path::new(project_path).join(".git").exists()
}

async fn resolve_git_revision(project_path: &str, revision: &str) -> Result<String> {
    let output = tokio::process::Command::new("git")
        .args(["-C", project_path, "rev-parse", "--verify", &format!("{revision}^{{commit}}")])
        .output()
        .await?;
    if !output.status.success() {
        return Err(anyhow!("base_revision `{revision}` does not name a commit in the group project"));
    }
    let oid = String::from_utf8(output.stdout)?.trim().to_owned();
    if oid.len() < 40 || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(anyhow!("git returned an invalid commit id for base_revision"));
    }
    Ok(oid)
}

struct Inner {
    commands: std::sync::Mutex<()>,
    collaboration_writes: std::sync::Mutex<()>,
    question_answers: Mutex<()>,
    collaboration_commands: Mutex<()>,
    thread_updates: std::sync::Mutex<()>,
    store: Store,
    drivers: DriverRegistry,
    events: crate::bounded_broadcast::Sender<ThreadEvent>,
    paths: Paths,
    settings: SettingsStore,
    provider_catalogs: Arc<crate::state::ProviderCatalogCache>,
    app_tools: crate::app_tools::AppTools,
    native_tools: Option<crate::native_tools_mcp::NativeToolsGateway>,
    sessions: Mutex<HashMap<ThreadId, Arc<LiveSession>>>,
    releasing: Mutex<HashMap<ThreadId, tokio::sync::watch::Receiver<()>>>,
    harness_gates: HashMap<ProviderKind, Arc<tokio::sync::RwLock<()>>>,
    /// Threads whose next session must fork the provider conversation at this point.
    pending_rewinds: Mutex<HashMap<ThreadId, RewindPoint>>,
    /// Woken whenever a queued follow-up may have become dispatchable, so the
    /// queue worker sleeps instead of polling the store.
    queue_wakeup: Notify,
    collaboration_wakeup: Notify,
}

struct LiveSession {
    /// Daemon-local identity for one spawned process. Native tool credentials bind to it.
    session_instance_id: Uuid,
    session: Box<dyn AgentSession>,
    /// Last moment the user or the provider touched this session. Idle
    /// release is measured from here.
    last_activity: std::sync::Mutex<SessionActivityTime>,
    /// Set once the daemon decided to close this process on purpose, so the
    /// provider's exit is not reported as a failure.
    released: AtomicBool,
    /// Forced stop owns cleanup and discards late provider events.
    stop_cleanup: AtomicBool,
    /// The turn currently executing, if any.
    turn: Mutex<Option<ActiveTurn>>,
    /// A settled Claude turn can receive native background-task continuations.
    /// Keep only the latest turn; a new user request replaces this context.
    continuation: Mutex<Option<ActiveTurn>>,
    turn_ready: Notify,
    /// Most recent parent turn. Provider task notifications can arrive after
    /// the parent reports completion.
    last_turn_id: Mutex<Option<TurnId>>,
    /// Latest provider-owned task state for targeted controls and checkpointing.
    tasks: Mutex<HashMap<String, RuntimeTask>>,
    /// Parent turns whose after-checkpoint waits for launched work to settle.
    deferred_checkpoints: Mutex<HashSet<TurnId>>,
    /// Approval id -> provider request id, for pending permission requests.
    pending: Mutex<HashMap<ApprovalId, String>>,
    /// In-flight internal tool request ids. A bounded semaphore prevents one
    /// provider session from monopolizing daemon read work.
    app_tool_requests: Mutex<HashSet<String>>,
    app_tool_permits: Arc<Semaphore>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuntimeTaskUpdateKind {
    Progress,
    Resume,
    Complete,
}

/// Idle expiry includes suspend time, which `Instant` does not count on macOS.
/// Keep both clocks so moving the wall clock backward cannot extend a session
/// beyond its normal awake-time limit. A forward clock change can expire an
/// idle process early; its conversation remains resumable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SessionActivityTime {
    monotonic: Instant,
    wall: SystemTime,
}

impl SessionActivityTime {
    fn now() -> Self {
        Self { monotonic: Instant::now(), wall: SystemTime::now() }
    }

    fn idle_for(self, now: Instant, wall_now: SystemTime) -> Duration {
        now.saturating_duration_since(self.monotonic).max(wall_now.duration_since(self.wall).unwrap_or_default())
    }
}

struct ActiveTurn {
    id: TurnId,
    /// Distinguishes repeated native continuations of the same persisted turn.
    response_id: Uuid,
    /// Time after the harness was ready; retained for provider-reported turn duration fallback.
    started: std::time::Instant,
    /// Time immediately before `TurnStarted` was persisted, for end-to-end startup timing.
    startup_started: std::time::Instant,
    provider: ProviderKind,
    session_reused: bool,
    first_event_observed: bool,
    /// Provider origin + message id -> our MessageId, so root and child ids can
    /// never collide even if a provider reuses identifiers across threads.
    messages: HashMap<(EventOrigin, String), MessageId>,
    /// Logical message currently receiving deltas for each origin. Provider
    /// item ids are aliases: chunk and completion frames may disagree on them.
    active_messages: HashMap<EventOrigin, MessageId>,
    /// Last completed non-empty root message; persisted with TurnCompleted so
    /// clients never have to guess which assistant row is the final answer.
    terminal_message_id: Option<MessageId>,
    completed: bool,
    /// Claude Code may emit a successful foreground `result` while native
    /// background tasks are still active, then resume the root assistant from
    /// an internal task notification. Hold that provisional result so the
    /// continuation remains part of this turn and retains stable message ids.
    pending_completion: Option<PendingTurnCompletion>,
}

#[derive(Clone)]
struct PendingTurnCompletion {
    stop_reason: StopReason,
    usage: Usage,
    cost_usd: Option<f64>,
    duration_ms: u64,
    anchors: TurnAnchors,
}

impl PendingTurnCompletion {
    fn merge(&mut self, stop_reason: StopReason, usage: Usage, cost_usd: Option<f64>, duration_ms: u64, anchors: TurnAnchors) {
        self.stop_reason = stop_reason;
        self.usage.add(&usage);
        self.cost_usd = match (self.cost_usd, cost_usd) {
            (Some(left), Some(right)) => Some(left + right),
            (left, right) => left.or(right),
        };
        self.duration_ms = self.duration_ms.saturating_add(duration_ms);
        if anchors.turn_id.is_some() {
            self.anchors.turn_id = anchors.turn_id;
        }
        if anchors.previous_end.is_some() {
            self.anchors.previous_end = anchors.previous_end;
        }
    }
}

impl LiveSession {
    fn touch(&self) {
        *self.last_activity.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = SessionActivityTime::now();
    }

    fn last_activity(&self) -> SessionActivityTime {
        *self.last_activity.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn mark_released(&self) {
        self.released.store(true, Ordering::Relaxed);
    }

    fn is_released(&self) -> bool {
        self.released.load(Ordering::Relaxed)
    }
}

/// One agent process the daemon closed because nothing needed it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionRelease {
    pub thread_id: ThreadId,
    pub reason: SessionReleaseReason,
}

/// Live-session counts for `daemon.activity` and the idle-exit decision.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SessionActivity {
    /// Threads with an agent process alive.
    pub live: usize,
    /// Live sessions with no turn, approval, or background work in progress.
    pub idle: usize,
}

pub const DEFAULT_TITLE: &str = "New thread";

impl Orchestrator {
    pub fn new(
        store: Store,
        drivers: DriverRegistry,
        events: crate::bounded_broadcast::Sender<ThreadEvent>,
        paths: Paths,
        settings: SettingsStore,
    ) -> Self {
        let app_tools = crate::app_tools::AppTools::new(store.clone(), crate::terminal::TerminalManager::default());
        Self {
            inner: Arc::new(Inner {
                commands: std::sync::Mutex::new(()),
                collaboration_writes: std::sync::Mutex::new(()),
                question_answers: Mutex::new(()),
                collaboration_commands: Mutex::new(()),
                thread_updates: std::sync::Mutex::new(()),
                store,
                drivers,
                events,
                paths,
                settings,
                provider_catalogs: Arc::new(crate::state::ProviderCatalogCache::default()),
                app_tools,
                native_tools: None,
                sessions: Mutex::new(HashMap::new()),
                releasing: Mutex::new(HashMap::new()),
                harness_gates: ProviderKind::ALL.into_iter().map(|kind| (kind, Arc::new(tokio::sync::RwLock::new(())))).collect(),
                pending_rewinds: Mutex::new(HashMap::new()),
                queue_wakeup: Notify::new(),
                collaboration_wakeup: Notify::new(),
            }),
        }
    }

    /// Use the daemon's shared terminal registry for thread-bound app tools.
    /// Existing embedders keep an isolated empty registry by default.
    pub fn with_terminal_manager(mut self, terminals: crate::terminal::TerminalManager) -> Self {
        let store = self.inner.store.clone();
        Arc::get_mut(&mut self.inner).expect("terminal manager must be installed before cloning the orchestrator").app_tools =
            crate::app_tools::AppTools::new(store, terminals);
        self
    }

    pub fn with_native_tools(mut self, native_tools: crate::native_tools_mcp::NativeToolsGateway) -> Self {
        Arc::get_mut(&mut self.inner).expect("native tools must be installed before cloning the orchestrator").native_tools =
            Some(native_tools);
        self
    }

    fn revoke_native_session(&self, live: &LiveSession) {
        if let Some(gateway) = &self.inner.native_tools {
            gateway.revoke(live.session_instance_id);
        }
    }

    /// Resolves the next time a queued follow-up may be ready to dispatch.
    pub async fn queue_changed(&self) {
        self.inner.queue_wakeup.notified().await;
    }

    /// Nothing in the daemon or the provider is using this session: no turn,
    /// no pending approval, no provider-owned background work, and the thread
    /// is not marked busy in the store.
    async fn session_parked(&self, thread_id: ThreadId, live: &LiveSession) -> Result<bool> {
        if live.turn.lock().await.is_some() {
            return Ok(false);
        }
        if live.tasks.lock().await.values().any(|task| task.status.is_active()) {
            return Ok(false);
        }
        if !live.pending.lock().await.is_empty() {
            return Ok(false);
        }
        let Some(thread) = self.inner.store.thread_get(thread_id)? else { return Ok(true) };
        Ok(!matches!(thread.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval))
    }

    /// Release only a parked session owned by this daemon. Never adopt or kill
    /// an unidentified process merely because it holds a provider writer lock.
    pub async fn release_session(&self, thread_id: ThreadId) -> Result<()> {
        let (live, done) = {
            let mut sessions = self.inner.sessions.lock().await;
            let live = sessions.get(&thread_id).cloned().ok_or_else(|| anyhow!("Kybern has no live agent process for this thread. If another app owns the conversation, close that session there and retry."))?;
            if !self.session_parked(thread_id, &live).await? {
                return Err(anyhow!("This agent has active work or approvals. Wait for them to finish before reconnecting."));
            }
            let (done, waiting) = tokio::sync::watch::channel(());
            self.inner.releasing.lock().await.insert(thread_id, waiting);
            sessions.remove(&thread_id);
            live.mark_released();
            self.revoke_native_session(&live);
            (live, done)
        };
        let this = self.clone();
        // Disconnecting the requesting client must not cancel cleanup.
        tokio::spawn(async move {
            let result = live.session.close().await;
            this.inner.releasing.lock().await.remove(&thread_id);
            drop(done);
            result?;
            this.emit(thread_id, None, EventPayload::ProviderSessionReleased { reason: SessionReleaseReason::Manual })?;
            Ok::<_, anyhow::Error>(())
        })
        .await??;
        Ok(())
    }

    pub async fn session_activity(&self) -> Result<SessionActivity> {
        let snapshot: Vec<(ThreadId, Arc<LiveSession>)> =
            self.inner.sessions.lock().await.iter().map(|(id, live)| (*id, live.clone())).collect();
        let mut activity = SessionActivity { live: snapshot.len(), idle: 0 };
        for (thread_id, live) in &snapshot {
            if self.session_parked(*thread_id, live).await? {
                activity.idle += 1;
            }
        }
        Ok(activity)
    }

    /// Close agent processes that nothing needs: parked sessions idle for
    /// longer than the policy allows, then the least recently used parked
    /// sessions beyond the warm cap. Each closed thread resumes its provider
    /// conversation on the next message.
    ///
    /// Candidates are chosen without holding the session map, then claimed
    /// under it with the parked check repeated, so a message that arrived in
    /// between keeps its live process.
    ///
    /// With `saving_power` the host is on battery and the policy asks to
    /// spare it: every parked session is released after a short grace,
    /// and the warm cap does not apply.
    pub async fn release_idle_sessions(&self, policy: &BackgroundSettings, saving_power: bool) -> Result<Vec<SessionRelease>> {
        self.release_idle_sessions_at(policy, saving_power, Instant::now(), SystemTime::now()).await
    }

    async fn release_idle_sessions_at(
        &self,
        policy: &BackgroundSettings,
        saving_power: bool,
        now: Instant,
        wall_now: SystemTime,
    ) -> Result<Vec<SessionRelease>> {
        let (idle_limit, cap, idle_reason) = if saving_power {
            (Some(BackgroundSettings::BATTERY_SESSION_IDLE), None, SessionReleaseReason::Power)
        } else {
            (policy.session_idle(), policy.idle_session_cap(), SessionReleaseReason::Idle)
        };
        let snapshot: Vec<(ThreadId, Arc<LiveSession>)> =
            self.inner.sessions.lock().await.iter().map(|(id, live)| (*id, live.clone())).collect();
        let mut parked = Vec::new();
        for (thread_id, live) in snapshot {
            if self.session_parked(thread_id, &live).await? {
                let last_activity = live.last_activity();
                parked.push((thread_id, live, last_activity));
            }
        }
        parked.sort_by_key(|(_, _, last_activity)| last_activity.monotonic);
        let mut planned = Vec::new();
        let mut fresh = Vec::new();
        for (thread_id, live, last_activity) in parked {
            match idle_limit {
                Some(limit) if last_activity.idle_for(now, wall_now) >= limit => {
                    planned.push((thread_id, live, idle_reason, last_activity));
                }
                _ => fresh.push((thread_id, live, last_activity)),
            }
        }
        if let Some(cap) = cap
            && fresh.len() > cap
        {
            let excess = fresh.len() - cap;
            planned.extend(
                fresh
                    .drain(..excess)
                    .map(|(thread_id, live, last_activity)| (thread_id, live, SessionReleaseReason::Capacity, last_activity)),
            );
        }
        if planned.is_empty() {
            return Ok(Vec::new());
        }
        let mut claimed = Vec::new();
        {
            let mut sessions = self.inner.sessions.lock().await;
            for (thread_id, live, reason, last_activity) in planned {
                if !sessions.get(&thread_id).is_some_and(|current| Arc::ptr_eq(current, &live)) {
                    continue;
                }
                if !self.session_parked(thread_id, &live).await? || live.last_activity() != last_activity {
                    // Work can start and finish while the sweep is selecting
                    // candidates. Give that newly quiet session its full grace.
                    continue;
                }
                let (done, waiting) = tokio::sync::watch::channel(());
                self.inner.releasing.lock().await.insert(thread_id, waiting);
                sessions.remove(&thread_id);
                live.mark_released();
                self.revoke_native_session(&live);
                claimed.push((thread_id, live, reason, done));
            }
        }
        // Once claimed, cleanup must finish even if the maintenance caller is
        // cancelled. Keep each resume barrier until its own process is closed.
        let closing = claimed
            .into_iter()
            .map(|(thread_id, live, reason, done)| {
                let this = self.clone();
                tokio::spawn(async move {
                    if let Err(error) = live.session.close().await {
                        tracing::warn!(%thread_id, %error, "agent process did not close cleanly");
                    }
                    this.inner.releasing.lock().await.remove(&thread_id);
                    drop(done);
                    tracing::info!(%thread_id, ?reason, "released idle agent process");
                    this.emit(thread_id, None, EventPayload::ProviderSessionReleased { reason })?;
                    Ok::<_, anyhow::Error>(SessionRelease { thread_id, reason })
                })
            })
            .collect::<Vec<_>>();
        let mut released = Vec::with_capacity(closing.len());
        for outcome in futures::future::join_all(closing).await {
            released.push(outcome??);
        }
        Ok(released)
    }

    /// The write guard prevents sends and one-shot jobs from racing an update.
    pub async fn idle_harness_for_update(&self, kind: ProviderKind) -> Result<Option<tokio::sync::OwnedRwLockWriteGuard<()>>> {
        let Ok(guard) = self.inner.harness_gates[&kind].clone().try_write_owned() else { return Ok(None) };
        let threads = self.inner.store.threads_list(None, true)?;
        for thread in threads.iter().filter(|thread| thread.provider.kind == kind) {
            if matches!(thread.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval)
                || self.inner.store.runtime_tasks_for_thread(thread.id)?.iter().any(|task| task.status.is_active())
            {
                return Ok(None);
            }
        }
        // Resume the persisted conversation with the new executable on the next send.
        for thread in threads.iter().filter(|thread| thread.provider.kind == kind) {
            let live = self.inner.sessions.lock().await.remove(&thread.id);
            if let Some(live) = live {
                live.mark_released();
                self.revoke_native_session(&live);
                live.session.close().await?;
                self.emit(thread.id, None, EventPayload::ProviderSessionReleased { reason: SessionReleaseReason::Update })?;
            }
        }
        Ok(Some(guard))
    }

    /// Binary override for a provider from settings.
    fn binary_for(&self, kind: ProviderKind) -> Option<PathBuf> {
        self.inner.settings.get().providers.get(&kind).and_then(|p| p.binary.clone()).map(PathBuf::from)
    }

    /// Provider-owned tasks and turns cannot survive a daemon restart. Close
    /// both projections explicitly so clients never show immortal work.
    pub async fn recover_after_restart(&self) -> Result<()> {
        let threads = self.inner.store.threads_list(None, true)?;
        for t in &threads {
            let tasks = self.inner.store.runtime_tasks_for_thread(t.id)?;
            let mut checkpoint_turns = HashSet::new();
            for mut task in tasks.into_iter().filter(|task| task.status.is_active()) {
                task.status = RuntimeTaskStatus::Interrupted;
                task.detail = Some("Daemon restarted before this work finished".into());
                task.capabilities = RuntimeTaskCapabilities::default();
                task.updated_at = Utc::now();
                task.completed_at = Some(task.updated_at);
                checkpoint_turns.insert(task.origin_turn_id);
                self.emit(t.id, Some(task.origin_turn_id), EventPayload::RuntimeTaskCompleted { task })?;
            }
            for turn_id in checkpoint_turns {
                if self.inner.store.checkpoint_get(turn_id)?.is_some_and(|checkpoint| checkpoint.after.is_none()) {
                    self.checkpoint(t, turn_id, "after").await;
                }
            }
        }
        for mut t in self.inner.store.threads_running()? {
            let last_turn = self.inner.store.events_for_thread(t.id)?.iter().rev().find_map(|e| match e.payload {
                EventPayload::TurnStarted { .. } => e.turn_id,
                _ => None,
            });
            for a in self.inner.store.approvals_pending(Some(t.id))? {
                let decision = ApprovalDecision::Deny { reason: Some("daemon restarted".into()) };
                self.inner.store.approval_resolve(a.id, &decision)?;
                self.emit(t.id, Some(a.turn_id), EventPayload::ApprovalResolved { approval_id: a.id, decision })?;
            }
            self.emit(t.id, last_turn, EventPayload::TurnFailed { error: "daemon restarted while the turn was running".into() })?;
            t.status = ThreadStatus::Failed;
            self.update_thread(t)?;
        }
        for group in self.inner.store.collaboration_groups_list(None, true)? {
            for mut assignment in self.inner.store.collaboration_assignments(group.id, false)? {
                if matches!(assignment.status, AssignmentStatus::Waiting | AssignmentStatus::Working)
                    && assignment.dispatch_message_id.is_some()
                {
                    assignment.status = AssignmentStatus::AttentionNeeded;
                    assignment.uncertainty = Some(
                        "daemon restarted while assignment execution or delivery was in flight; inspect the owner thread before retrying"
                            .into(),
                    );
                    assignment.revision += 1;
                    assignment.updated_at = Utc::now();
                    self.inner.store.collaboration_assignment_put(&assignment)?;
                    self.emit_collaboration(group.id, EventPayload::CollaborationAssignmentUpdated { assignment })?;
                }
            }
            for mut message in self.inner.store.collaboration_messages(group.id)? {
                if message.state == CollaborationDeliveryState::Queued
                    && message.external_recipient
                    && self.inner.store.thread_get(message.to_thread_id)?.is_some_and(|thread| thread.status == ThreadStatus::Failed)
                {
                    message.state = CollaborationDeliveryState::Uncertain;
                    message.updated_at = Utc::now();
                    self.inner.store.collaboration_message_put(&message, Some(message.id))?;
                    self.emit(message.to_thread_id, None, EventPayload::MessageRemoved { message_id: message.id })?;
                    self.emit_collaboration(group.id, EventPayload::CollaborationMessageUpdated { message })?;
                    continue;
                }
                if message.state == CollaborationDeliveryState::Queued && !self.inner.store.queue_is_pending(message.id)? {
                    message.state = CollaborationDeliveryState::Uncertain;
                    message.updated_at = Utc::now();
                    self.inner.store.collaboration_message_put(&message, Some(message.id))?;
                    self.emit_collaboration(group.id, EventPayload::CollaborationMessageUpdated { message })?;
                }
            }
            if matches!(group.status, GroupStatus::Active | GroupStatus::Paused) {
                let messages = self.inner.store.collaboration_messages(group.id)?;
                for assignment in self.inner.store.collaboration_assignments(group.id, true)? {
                    let Some(result) = assignment.result.as_ref() else { continue };
                    if assignment.owner_thread_id.is_none_or(|owner| owner == group.coordinator_thread_id)
                        || messages.iter().any(|message| {
                            message.assignment_id == Some(assignment.id)
                                && message.purpose == CollaborationMessagePurpose::Result
                                && !matches!(
                                    message.state,
                                    CollaborationDeliveryState::Uncertain
                                        | CollaborationDeliveryState::Failed
                                        | CollaborationDeliveryState::Cancelled
                                )
                        })
                    {
                        continue;
                    }
                    let operation_id = derived_operation_id(assignment.id, 0x72);
                    self.collaboration_message_send(
                        methods::CollaborationMessagesSendParams {
                            operation_id,
                            group_id: group.id,
                            assignment_id: Some(assignment.id),
                            from_thread_id: assignment.owner_thread_id,
                            to_thread_id: group.coordinator_thread_id,
                            purpose: CollaborationMessagePurpose::Result,
                            reply_to: None,
                            body: format!(
                                "Recovered result notification for assignment {} ({:?}): {}",
                                assignment.id, result.outcome, result.summary
                            ),
                        },
                        assignment.owner_thread_id,
                    )?;
                }
            }
        }
        Ok(())
    }

    pub async fn shutdown(&self) {
        let sessions: Vec<_> = self.inner.sessions.lock().await.drain().collect();
        for (_, live) in &sessions {
            live.mark_released();
            self.revoke_native_session(live);
        }
        let _ = futures::future::join_all(sessions.iter().map(|(_, live)| live.session.close())).await;
    }

    // ---- persistence helpers ----

    fn emit(&self, thread_id: ThreadId, turn_id: Option<TurnId>, payload: EventPayload) -> Result<ThreadEvent> {
        let collaboration_failure = match &payload {
            EventPayload::TurnFailed { error } => Some(error.clone()),
            _ => None,
        };
        let ev = self.inner.store.event_append(thread_id, turn_id, payload)?;
        if matches!(
            ev.payload,
            EventPayload::MessageQueued { .. } | EventPayload::ThreadUpdated { .. } | EventPayload::RuntimeTaskCompleted { .. }
        ) {
            self.inner.queue_wakeup.notify_one();
        }
        let _ = self.inner.events.send(ev.clone());
        if let Some(error) = collaboration_failure {
            self.record_collaboration_turn_failure(thread_id, &error)?;
        }
        Ok(ev)
    }

    fn broadcast_collaboration_direct(&self, group_id: GroupId, payload: EventPayload) -> Result<()> {
        for member in self.inner.store.collaboration_members(group_id)?.into_iter().filter(|member| member.active) {
            let event = self.inner.store.event_append(member.thread_id, None, payload.clone())?;
            let _ = self.inner.events.send(event);
        }
        Ok(())
    }

    fn record_collaboration_turn_failure(&self, thread_id: ThreadId, error: &str) -> Result<()> {
        let Some(mut assignment) = self.inner.store.collaboration_active_assignment_for_thread(thread_id)? else { return Ok(()) };
        if !matches!(assignment.status, AssignmentStatus::Working | AssignmentStatus::Waiting) {
            return Ok(());
        }
        let group =
            self.inner.store.collaboration_group_get(assignment.group_id)?.ok_or_else(|| anyhow!("collaboration group not found"))?;
        assignment.status = AssignmentStatus::AttentionNeeded;
        assignment.uncertainty = Some(format!("owner turn failed: {error}. Inspect its thread and worktree before retrying."));
        assignment.revision += 1;
        assignment.updated_at = Utc::now();
        self.inner.store.collaboration_assignment_put(&assignment)?;
        self.broadcast_collaboration_direct(group.id, EventPayload::CollaborationAssignmentUpdated { assignment: assignment.clone() })?;
        let failure_recipient = assignment
            .created_by_thread_id
            .filter(|candidate| {
                self.inner
                    .store
                    .collaboration_members(group.id)
                    .is_ok_and(|members| members.into_iter().any(|member| member.active && member.thread_id == *candidate))
            })
            .unwrap_or(group.coordinator_thread_id);
        if matches!(group.status, GroupStatus::Active | GroupStatus::Paused) && failure_recipient != thread_id {
            let now = Utc::now();
            let id = Uuid::now_v7();
            let used: u32 = self
                .inner
                .store
                .collaboration_messages(group.id)?
                .iter()
                .filter(|message| message.assignment_id == Some(assignment.id))
                .map(|message| message.wakeup_count)
                .sum();
            let should_wake = used < group.policy.max_wakeups_per_assignment;
            let message = CollaborationMessage {
                id,
                operation_id: id,
                group_id: group.id,
                assignment_id: Some(assignment.id),
                from_thread_id: Some(thread_id),
                to_thread_id: failure_recipient,
                external_recipient: false,
                purpose: CollaborationMessagePurpose::Failure,
                reply_to: None,
                body: assignment.uncertainty.clone().unwrap_or_else(|| error.into()),
                state: if should_wake { CollaborationDeliveryState::Queued } else { CollaborationDeliveryState::Persisted },
                delivery_turn_id: None,
                wakeup_count: u32::from(should_wake),
                created_at: now,
                updated_at: now,
            };
            self.inner.store.collaboration_message_put(&message, should_wake.then_some(id))?;
            if should_wake {
                let queued = methods::QueuedMessage {
                    id,
                    thread_id: failure_recipient,
                    message: UserMessage::text(format!(
                        "Kybern assignment {} needs attention after its owner turn failed:\n{}",
                        assignment.id, message.body
                    )),
                };
                let queued_event =
                    self.inner.store.event_append(failure_recipient, None, EventPayload::MessageQueued { message: queued })?;
                let _ = self.inner.events.send(queued_event);
            }
            self.broadcast_collaboration_direct(group.id, EventPayload::CollaborationMessageUpdated { message })?;
            self.inner.queue_wakeup.notify_one();
        }
        Ok(())
    }

    fn update_thread(&self, mut thread: Thread) -> Result<Thread> {
        let _updates = self.inner.thread_updates.lock().map_err(|_| anyhow!("thread update lock poisoned"))?;
        // A late provider completion must not unarchive a thread and allow the
        // daemon queue worker to resume it while its session is being closed.
        if self.inner.store.thread_get(thread.id)?.is_some_and(|current| current.status == ThreadStatus::Archived) {
            thread.status = ThreadStatus::Archived;
        }
        thread.updated_at = Utc::now();
        self.inner.store.thread_upsert(&thread)?;
        let ev = self.emit(thread.id, None, EventPayload::ThreadUpdated { thread: thread.clone() })?;
        thread.last_seq = ev.seq;
        // Keep the stored last_seq in sync with what we just emitted.
        self.inner.store.thread_upsert(&thread)?;
        Ok(thread)
    }

    // ---- projects ----

    pub fn add_project(&self, path: String, name: Option<String>) -> Result<Project> {
        let p = PathBuf::from(&path);
        let p = p.canonicalize().with_context(|| format!("project path {path} does not exist"))?;
        if !p.is_dir() {
            return Err(anyhow!("{} is not a directory", p.display()));
        }
        let path = p.to_string_lossy().to_string();
        if let Some(mut existing) = self.inner.store.project_by_path(&path)? {
            // Self-heal a stale cached flag: the folder may have gained (or lost) a
            // repo since it was first registered. Re-probe and persist any change so
            // edit/integration spawns are not permanently blocked after a `git init`.
            let live = project_path_is_git(&existing.path);
            if live != existing.is_git {
                existing.is_git = live;
                existing.updated_at = Utc::now();
                self.inner.store.project_update(&existing)?;
            }
            return Ok(existing);
        }
        let now = Utc::now();
        let project = Project {
            id: Uuid::now_v7(),
            name: name.unwrap_or_else(|| p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| path.clone())),
            is_git: project_path_is_git(&path),
            path,
            worktrees_default: None,
            created_at: now,
            updated_at: now,
        };
        if let Err(error) = self.inner.store.project_insert(&project) {
            // Concurrent imports may discover the same folder before either
            // inserts it. Reuse the winner of the unique-path constraint.
            if let Some(existing) = self.inner.store.project_by_path(&project.path)? {
                return Ok(existing);
            }
            return Err(error);
        }
        Ok(project)
    }

    // ---- threads ----

    pub async fn resume_external_session(&self, params: methods::SessionsResumeParams) -> Result<Thread> {
        let existing = self.inner.store.threads_list(None, true)?.into_iter().find(|thread| {
            thread.provider.kind == params.provider && thread.provider_session_id.as_deref() == Some(params.session_id.as_str())
        });
        if let Some(mut thread) = existing {
            if thread.status == ThreadStatus::Archived {
                thread.status = ThreadStatus::Idle;
                self.inner.store.thread_upsert(&thread)?;
                thread = self.update_thread(thread)?;
            }
            return Ok(thread);
        }
        let _gate = self.inner.harness_gates.get(&params.provider).ok_or_else(|| anyhow!("Harness unavailable"))?.read().await;
        let driver = self.inner.drivers.get(params.provider).ok_or_else(|| anyhow!("Harness unavailable"))?;
        let settings = self.inner.settings.get();
        let source_project =
            params.project_id.map(|id| self.inner.store.project_get(id)?.ok_or_else(|| anyhow!("Project not found"))).transpose()?;
        let provider = crate::settings::provider_settings(&settings, params.provider, source_project.as_ref().map(|p| p.path.as_str()));
        let context = kybern_drivers::ProbeContext {
            binary: provider.binary.map(PathBuf::from),
            cwd: source_project.as_ref().map(|p| PathBuf::from(&p.path)),
            env: provider.env,
        };
        let imported_profile =
            if params.provider == ProviderKind::Omp { Some(kybern_drivers::omp_profile::resolve(&context.env)?) } else { None };
        let history = driver.read_session(&context, &params.session_id).await?;
        let session = history.session;
        if session.provider != params.provider || session.id != params.session_id {
            return Err(anyhow!("The harness returned a different session. Refresh the session list and try again."));
        }
        let cwd = PathBuf::from(&session.cwd);
        if !cwd.is_absolute() || !cwd.is_dir() {
            return Err(anyhow!(
                "The session folder is unavailable: {}. Restore it or move the session in its harness, then try again.",
                session.cwd
            ));
        }
        let project = self.add_project(session.cwd.clone(), None)?;
        let now = Utc::now();
        let thread = Thread {
            id: Uuid::now_v7(),
            project_id: project.id,
            title: if session.title.trim().is_empty() { DEFAULT_TITLE.into() } else { session.title },
            model: session.model,
            effort: None,
            provider: ProviderInstance { kind: session.provider, instance: "default".into() },
            permission_mode: settings.default_permission_mode,
            status: ThreadStatus::Idle,
            worktree: None,
            cwd: session.cwd,
            provider_session_id: Some(session.id),
            pinned: false,
            created_at: history.events.first().map_or(now, |event| event.at),
            updated_at: now,
            last_seq: 0,
            parent_thread_id: None,
            coordinator_project_id: None,
            collaboration_group_id: None,
        };
        let store = self.inner.store.clone();
        let (mut thread, events) = tokio::task::spawn_blocking(move || store.thread_import(thread, history.events)).await??;
        if let Some(profile) = imported_profile {
            self.inner.store.meta_set(&format!("omp_profile:{}", thread.id), &profile)?;
        }
        for event in events {
            let _ = self.inner.events.send(event);
        }
        if thread.status == ThreadStatus::Archived {
            thread.status = ThreadStatus::Idle;
            self.inner.store.thread_upsert(&thread)?;
            thread = self.update_thread(thread)?;
        }
        Ok(thread)
    }

    pub async fn create_thread(&self, params: methods::ThreadsCreateParams) -> Result<Thread> {
        self.create_thread_with_id(params, Uuid::now_v7()).await
    }

    async fn create_thread_with_id(&self, params: methods::ThreadsCreateParams, id: ThreadId) -> Result<Thread> {
        let mut project = self.inner.store.project_get(params.project_id)?.ok_or_else(|| anyhow!("project not found"))?;
        let settings = self.inner.settings.get();
        let configured_model = settings.providers.get(&params.provider.kind).and_then(|provider| provider.model.clone());
        let selected_model = params.model.as_deref().or(configured_model.as_deref());
        self.validate_provider_selection(project.id, &params.provider, selected_model, params.effort.as_deref()).await?;
        let use_worktree = params.use_worktree.or(project.worktrees_default).unwrap_or(settings.worktrees_default);
        if use_worktree && !project.is_git {
            // Re-probe a stale cached flag before refusing (see `project_path_is_git`);
            // a folder `git init`-ed after registration must still support worktrees.
            if project_path_is_git(&project.path) {
                project.is_git = true;
                project.updated_at = Utc::now();
                self.inner.store.project_update(&project)?;
            } else {
                return Err(anyhow!("project is not a git repository; cannot create a worktree"));
            }
        }
        let now = Utc::now();
        let base_branch = params.base_branch.clone().map(|b| b.trim().to_string()).filter(|b| !b.is_empty());
        let worktree = if use_worktree {
            Some(self.create_worktree(&project, id, base_branch.as_deref()).await?)
        } else {
            if let Some(branch) = base_branch.as_deref() {
                let repo = Repo::new(&project.path);
                if repo.current_branch().await.as_deref() != Some(branch) {
                    repo.switch(branch)
                        .await
                        .map_err(|e| anyhow!("could not switch {} to {branch}: {e}. Commit or stash your changes first", project.name))?;
                }
            }
            None
        };
        let cwd = worktree.as_ref().map(|w| w.path.clone()).unwrap_or_else(|| project.path.clone());
        let thread = Thread {
            id,
            project_id: project.id,
            title: params.title.clone().unwrap_or_else(|| DEFAULT_TITLE.to_string()),
            model: params.model.or(configured_model),
            effort: params.effort,
            provider: params.provider,
            permission_mode: params.permission_mode.unwrap_or(settings.default_permission_mode),
            status: ThreadStatus::Idle,
            worktree,
            cwd,
            provider_session_id: None,
            pinned: false,
            created_at: now,
            updated_at: now,
            last_seq: 0,
            parent_thread_id: None,
            coordinator_project_id: None,
            collaboration_group_id: None,
        };
        self.inner.store.thread_upsert(&thread)?;
        let ev = self.emit(thread.id, None, EventPayload::ThreadCreated { thread: thread.clone() })?;
        let mut thread = Thread { last_seq: ev.seq, ..thread };
        self.inner.store.thread_upsert(&thread)?;
        if let Some(message) = params.message {
            self.send(thread.id, message).await?;
            thread = self.inner.store.thread_get(thread.id)?.unwrap_or(thread);
        }
        Ok(thread)
    }

    async fn create_worktree(&self, project: &Project, thread_id: ThreadId, base: Option<&str>) -> Result<WorktreeInfo> {
        let unique = thread_id.to_string();
        let branch = format!("kybern/{unique}");
        let dir = self.inner.paths.worktrees.join(&project.name).join(&unique);
        std::fs::create_dir_all(dir.parent().unwrap())?;
        Repo::new(&project.path).worktree_add(&dir, &branch, base).await?;
        Ok(WorktreeInfo { path: dir.to_string_lossy().to_string(), branch })
    }

    pub fn update_thread_fields(&self, params: methods::ThreadsUpdateParams) -> Result<Thread> {
        let mut t = self.inner.store.thread_get(params.thread_id)?.ok_or_else(|| anyhow!("thread not found"))?;
        if let Some(title) = params.title {
            t.title = title;
        }
        if let Some(p) = params.pinned {
            t.pinned = p;
        }
        if let Some(m) = params.permission_mode {
            t.permission_mode = m;
        }
        if let Some(m) = params.model {
            t.model = Some(m);
        }
        if let Some(effort) = params.effort {
            t.effort = Some(effort);
        }
        self.update_thread(t)
    }

    /// Push mode/model/effort changes to a live session after the store is updated.
    pub async fn apply_session_settings(
        &self,
        thread_id: ThreadId,
        mode: Option<PermissionMode>,
        model: Option<&str>,
        effort: Option<&str>,
    ) -> Result<()> {
        let live = self.inner.sessions.lock().await.get(&thread_id).cloned();
        if let Some(live) = live {
            live.touch();
            if let Some(mode) = mode {
                live.session.set_permission_mode(mode).await?;
            }
            if let Some(model) = model {
                live.session.set_model(model).await?;
            }
            if let Some(effort) = effort {
                live.session.set_effort(effort).await?;
            }
        }
        Ok(())
    }

    pub async fn archive_thread(&self, thread_id: ThreadId) -> Result<()> {
        {
            let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
            let mut t = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("thread not found"))?;
            if t.coordinator_project_id.is_some() {
                return Err(anyhow!("Use Delete coordinator to remove a project coordinator, or pause its agents temporarily."));
            }
            t.status = ThreadStatus::Archived;
            self.update_thread(t)?;
            self.emit(thread_id, None, EventPayload::ThreadArchived)?;
        }
        if let Some(live) = self.inner.sessions.lock().await.remove(&thread_id) {
            live.mark_released();
            self.revoke_native_session(&live);
            let _ = live.session.close().await;
        }
        Ok(())
    }

    pub async fn send(&self, thread_id: ThreadId, message: UserMessage) -> Result<(TurnId, MessageId)> {
        let redirect = (!is_compact_message(&message)).then(|| title_from_message(&message));
        let (turn_id, message_id, accepted) = self.send_with_id(thread_id, Uuid::now_v7(), message, false, false).await?;
        if let Some(summary) = redirect
            && accepted
            && let Err(error) = self.record_user_redirect(thread_id, &summary)
        {
            tracing::warn!(%thread_id, %error, "could not notify collaboration coordinator of direct user message");
        }
        Ok((turn_id, message_id))
    }

    pub async fn send_client_message(&self, params: methods::ThreadsSendParams) -> Result<methods::ThreadsSendResult> {
        let retryable = params.message_id.is_some();
        let message_id = params.message_id.unwrap_or_else(Uuid::now_v7);
        let redirect = (!is_compact_message(&params.message)).then(|| title_from_message(&params.message));
        let (turn_id, message_id, accepted) = self.send_with_id(params.thread_id, message_id, params.message, false, retryable).await?;
        if accepted
            && let Some(summary) = redirect
            && let Err(error) = self.record_user_redirect(params.thread_id, &summary)
        {
            tracing::warn!(thread_id = %params.thread_id, %error, "could not notify collaboration coordinator of direct user message");
        }
        Ok(methods::ThreadsSendResult { turn_id, message_id })
    }

    async fn send_with_id(
        &self,
        thread_id: ThreadId,
        message_id: MessageId,
        mut message: UserMessage,
        queued: bool,
        retryable: bool,
    ) -> Result<(TurnId, MessageId, bool)> {
        let kind = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("thread not found"))?.provider.kind;
        let _harness = self.inner.harness_gates[&kind]
            .clone()
            .try_read_owned()
            .map_err(|_| anyhow!("This agent is updating. Try sending again after the update finishes."))?;
        let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
        if queued {
            // Read under the command gate: the user may have edited this item
            // since the queue worker selected it.
            message = self
                .inner
                .store
                .queue_list(Some(thread_id))?
                .into_iter()
                .find(|item| item.id == message_id)
                .ok_or_else(|| anyhow!("queued message was removed"))?
                .message;
        }
        self.resolve_attachments(&mut message);
        if retryable && let Some((stored_thread_id, turn_id, stored_message)) = self.inner.store.turn_started_receipt(message_id)? {
            if stored_thread_id != thread_id || stored_message != message {
                return Err(anyhow!("message_id already belongs to a different thread or message"));
            }
            return Ok((turn_id, message_id, false));
        }
        let mut thread = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("thread not found"))?;
        if queued && thread.status != ThreadStatus::Idle {
            return Err(anyhow!("thread is no longer idle"));
        }
        if matches!(thread.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval) {
            return Err(anyhow!("thread is busy"));
        }
        if thread.status == ThreadStatus::Archived {
            return Err(anyhow!("thread is archived"));
        }

        if is_compact_message(&message) {
            let events = self.inner.store.events_for_thread(thread_id)?;
            let advertised = events
                .iter()
                .rev()
                .find_map(|event| match &event.payload {
                    EventPayload::ProviderCommandsUpdated { commands } => Some(commands.iter().any(|command| command.name == "compact")),
                    _ => None,
                })
                .unwrap_or(false);
            if !matches!(kind, ProviderKind::Codex | ProviderKind::Pi | ProviderKind::Omp | ProviderKind::Opencode) && !advertised {
                return Err(anyhow!("This harness does not expose manual compaction. Automatic compaction remains available."));
            }
            if thread.provider_session_id.is_none() {
                return Err(anyhow!("Send a message before compacting this conversation."));
            }
            if kybern_store::project_runtime_tasks(&self.inner.store.events_for_thread(thread_id)?)
                .iter()
                .any(|task| task.status.is_active())
            {
                return Err(anyhow!("Wait for agents and background tasks to finish before compacting."));
            }
        }
        let turn_id = Uuid::now_v7();
        if thread.title == DEFAULT_TITLE {
            thread.title = title_from_message(&message);
        }
        thread.status = ThreadStatus::Running;
        let thread = self.update_thread(thread)?;
        let startup_started = std::time::Instant::now();
        self.emit(thread.id, Some(turn_id), EventPayload::TurnStarted { message_id, message: message.clone() })?;

        // The user's intent is persisted and broadcast, so the call returns now
        // and clients navigate and render immediately. Spawning the harness,
        // taking the checkpoint and delivering the message can take a second or
        // more; that runs in the background and reports failures as events.
        let this = self.clone();
        tokio::spawn(async move {
            if let Err(e) = this.start_turn(thread, turn_id, message_id, message, startup_started).await {
                tracing::warn!(turn_id = %turn_id, error = %e, "failed to start turn");
            }
        });
        Ok((turn_id, message_id, true))
    }

    pub fn enqueue(&self, message: methods::QueuedMessage) -> Result<()> {
        let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
        let thread = self.inner.store.thread_get(message.thread_id)?.ok_or_else(|| anyhow!("thread not found"))?;
        if thread.status == ThreadStatus::Archived {
            return Err(anyhow!("thread is archived"));
        }
        if let Some(receipt) = self.inner.store.queue_receipt(message.id)? {
            if serde_json::to_value(receipt)? != serde_json::to_value(&message)? {
                return Err(anyhow!("message id already belongs to another request"));
            }
            return Ok(());
        }
        self.emit(message.thread_id, None, EventPayload::MessageQueued { message })?;
        Ok(())
    }

    pub fn remove_queued(&self, thread_id: ThreadId, id: MessageId) -> Result<()> {
        let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
        let queued = self.inner.store.queue_list(Some(thread_id))?;
        if !queued.iter().any(|message| message.id == id) {
            return Err(anyhow!("follow-up has already started or was removed; refresh the thread"));
        }
        self.emit(thread_id, None, EventPayload::MessageRemoved { message_id: id })?;
        Ok(())
    }

    pub fn update_queued(&self, message: methods::QueuedMessage) -> Result<()> {
        let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
        if !self.inner.store.queue_list(Some(message.thread_id))?.iter().any(|item| item.id == message.id) {
            return Err(anyhow!("This follow-up has already started or was removed. Send a new message instead."));
        }
        self.emit(message.thread_id, None, EventPayload::MessageQueueUpdated { message })?;
        Ok(())
    }

    pub fn set_notes(&self, params: methods::ThreadNotesSetParams) -> Result<methods::ThreadNotes> {
        let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
        self.inner.store.thread_get(params.thread_id)?.ok_or_else(|| anyhow!("Thread not found. Open another conversation."))?;
        if params.text.len() > 128 * 1024 {
            return Err(anyhow!("These notes are too long. Keep them under 128 KB and try again."));
        }
        let current = self.inner.store.thread_notes(params.thread_id)?;
        if current.text == params.text {
            return Ok(current);
        }
        if current.revision != params.expected_revision {
            return Err(anyhow!("Notes changed on another device. Copy your edits, reload the saved notes, and try again."));
        }
        let notes = methods::ThreadNotes { text: params.text, revision: current.revision + 1 };
        self.emit(params.thread_id, None, EventPayload::ThreadNotesUpdated { notes: notes.clone() })?;
        Ok(notes)
    }

    /// Deliver new user input within the current native turn. The turn gate also
    /// serializes retries, so a lost RPC reply does not send the prompt twice.
    pub async fn steer(&self, mut params: methods::QueuedMessage) -> Result<methods::ThreadsSendResult> {
        let redirect_summary = title_from_message(&params.message);
        self.resolve_attachments(&mut params.message);
        let receipt = || -> Result<Option<methods::ThreadsSendResult>> {
            let Some((thread, turn_id, message)) = self.inner.store.steering_receipt(params.id)? else { return Ok(None) };
            if thread != params.thread_id || serde_json::to_value(message)? != serde_json::to_value(&params.message)? {
                return Err(anyhow!("Message id already belongs to another request."));
            }
            Ok(Some(methods::ThreadsSendResult { turn_id, message_id: params.id }))
        };
        if let Some(result) = receipt()? {
            return Ok(result);
        }
        let thread = self.inner.store.thread_get(params.thread_id)?.ok_or_else(|| anyhow!("Thread not found."))?;
        if !matches!(thread.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval) {
            return Err(anyhow!("This turn has ended. Send your message to start the next turn."));
        }
        let live = self
            .inner
            .sessions
            .lock()
            .await
            .get(&params.thread_id)
            .cloned()
            .ok_or_else(|| anyhow!("The agent is still starting. Try steering again in a moment, or queue this message."))?;
        let turn = live.turn.lock().await;
        if let Some(result) = receipt()? {
            return Ok(result);
        }
        let active = turn
            .as_ref()
            .filter(|turn| !turn.completed)
            .ok_or_else(|| anyhow!("This turn has ended. Send your message to start the next turn."))?;
        live.touch();
        live.session.steer(&params.id.to_string(), &params.message).await?;
        self.emit(params.thread_id, Some(active.id), EventPayload::MessageSteered { message_id: params.id, message: params.message })?;
        if let Err(error) = self.record_user_redirect(params.thread_id, &redirect_summary) {
            tracing::warn!(thread_id = %params.thread_id, %error, "could not notify collaboration coordinator of direct user steering");
        }
        Ok(methods::ThreadsSendResult { turn_id: active.id, message_id: params.id })
    }

    fn record_user_redirect(&self, thread_id: ThreadId, summary: &str) -> Result<()> {
        let Some(assignment) = self.inner.store.collaboration_active_assignment_for_thread(thread_id)? else { return Ok(()) };
        let group =
            self.inner.store.collaboration_group_get(assignment.group_id)?.ok_or_else(|| anyhow!("collaboration group not found"))?;
        if group.coordinator_thread_id == thread_id || matches!(group.status, GroupStatus::Stopped | GroupStatus::Completed) {
            return Ok(());
        }
        self.collaboration_message_send(
            methods::CollaborationMessagesSendParams {
                operation_id: Uuid::now_v7(),
                group_id: group.id,
                assignment_id: Some(assignment.id),
                from_thread_id: None,
                to_thread_id: group.coordinator_thread_id,
                purpose: CollaborationMessagePurpose::Redirect,
                reply_to: None,
                body: format!("The user directly redirected thread {thread_id}: {summary}"),
            },
            None,
        )?;
        Ok(())
    }

    /// One daemon-owned worker consumes accepted follow-ups, independently of clients.
    /// Failed turns retain their queue until the user sends a new successful turn.
    ///
    /// Returns whether a follow-up is still waiting on a thread that is busy
    /// or finishing background work, so the worker knows to check back soon.
    pub async fn drain_queues(&self) -> Result<bool> {
        let mut waiting = false;
        for queued in self.inner.store.queue_list(None)? {
            if let Some(message) = self.inner.store.collaboration_message_for_delivery(queued.id)? {
                let group = self.inner.store.collaboration_group_get(message.group_id)?;
                if group.as_ref().is_some_and(|group| group.status != GroupStatus::Active) {
                    continue;
                }
                let sender_is_member = match message.from_thread_id {
                    Some(sender) => self
                        .inner
                        .store
                        .collaboration_members(message.group_id)?
                        .into_iter()
                        .any(|member| member.active && member.thread_id == sender),
                    None => true,
                };
                let external_authority = if message.purpose == CollaborationMessagePurpose::Reply {
                    message
                        .reply_to
                        .map(|reply_to| self.inner.store.collaboration_message_get(reply_to))
                        .transpose()?
                        .flatten()
                        .filter(|original| original.external_recipient)
                        .and_then(|original| original.from_thread_id.map(|initiator| (initiator, original.to_thread_id)))
                } else if message.external_recipient || !sender_is_member {
                    message.from_thread_id.map(|sender| (sender, message.to_thread_id))
                } else {
                    None
                };
                if let Some((authority_from, authority_to)) = external_authority
                    && let Err(error) = self.validate_external_delivery_authority(authority_from, authority_to)
                {
                    let mut failed = message;
                    failed.state = CollaborationDeliveryState::Failed;
                    failed.updated_at = Utc::now();
                    self.inner.store.collaboration_message_put(&failed, Some(failed.id))?;
                    self.emit(failed.to_thread_id, None, EventPayload::MessageRemoved { message_id: failed.id })?;
                    self.emit_collaboration(failed.group_id, EventPayload::CollaborationMessageUpdated { message: failed })?;
                    tracing::warn!(%error, "external collaboration delivery authority changed before dispatch");
                    continue;
                }
                if message.external_recipient
                    && let Some(recipient_group_id) = self
                        .inner
                        .store
                        .thread_get(message.to_thread_id)?
                        .and_then(|thread| thread.collaboration_group_id)
                        .or(self.inner.store.collaboration_group_for_thread(message.to_thread_id)?)
                    && let Some(recipient_group) = self.inner.store.collaboration_group_get(recipient_group_id)?
                {
                    if recipient_group.status == GroupStatus::Paused {
                        continue;
                    }
                    if matches!(recipient_group.status, GroupStatus::Stopped | GroupStatus::Completed) {
                        let mut cancelled = message;
                        cancelled.state = CollaborationDeliveryState::Cancelled;
                        cancelled.updated_at = Utc::now();
                        self.inner.store.collaboration_message_put(&cancelled, Some(cancelled.id))?;
                        self.emit(cancelled.to_thread_id, None, EventPayload::MessageRemoved { message_id: cancelled.id })?;
                        self.emit_collaboration(cancelled.group_id, EventPayload::CollaborationMessageUpdated { message: cancelled })?;
                        continue;
                    }
                }
            }
            let Some(thread) = self.inner.store.thread_get(queued.thread_id)? else { continue };
            if thread.status == ThreadStatus::Archived {
                if let Some(mut message) = self.inner.store.collaboration_message_for_delivery(queued.id)? {
                    message.state = CollaborationDeliveryState::Cancelled;
                    message.updated_at = Utc::now();
                    self.inner.store.collaboration_message_put(&message, Some(message.id))?;
                    self.emit(message.to_thread_id, None, EventPayload::MessageRemoved { message_id: message.id })?;
                    self.emit_collaboration(message.group_id, EventPayload::CollaborationMessageUpdated { message })?;
                }
                continue;
            }
            if thread.status != ThreadStatus::Idle {
                waiting |= matches!(thread.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval);
                continue;
            }
            if self.inner.store.runtime_tasks_for_thread(thread.id)?.iter().any(|task| task.status.is_active()) {
                waiting = true;
                continue;
            }
            if let Err(error) = self.send_with_id(thread.id, queued.id, queued.message, true, false).await {
                tracing::debug!(%error, "queue changed before dispatch");
            }
        }
        Ok(waiting)
    }

    /// Bring up the session, snapshot the tree and hand the message to the agent.
    /// Failures mark the thread failed and are surfaced as `TurnFailed`.
    async fn start_turn(
        &self,
        thread: Thread,
        turn_id: TurnId,
        message_id: MessageId,
        message: UserMessage,
        startup_started: std::time::Instant,
    ) -> Result<()> {
        let (live, session_reused) = match self.ensure_session(&thread).await {
            Ok(live) => live,
            Err(error) => {
                self.emit(thread.id, Some(turn_id), EventPayload::TurnFailed { error: error.to_string() })?;
                let mut failed = thread;
                failed.status = ThreadStatus::Failed;
                self.update_thread(failed)?;
                return Err(error);
            }
        };
        live.touch();
        if self.inner.store.thread_get(thread.id)?.is_some_and(|current| current.status == ThreadStatus::Archived) {
            live.mark_released();
            live.turn_ready.notify_one();
            let _ = live.session.close().await;
            self.inner.sessions.lock().await.remove(&thread.id);
            return Err(anyhow!("thread was archived during session startup"));
        }
        tracing::info!(
            target: "kybern::turn_startup",
            thread_id = %thread.id,
            turn_id = %turn_id,
            provider = %thread.provider.kind,
            session_reused,
            phase = "session_ready",
            elapsed_ms = startup_started.elapsed().as_millis() as u64,
        );
        {
            let mut turn = live.turn.lock().await;
            live.continuation.lock().await.take();
            *turn = Some(ActiveTurn {
                response_id: Uuid::now_v7(),
                id: turn_id,
                started: std::time::Instant::now(),
                startup_started,
                provider: thread.provider.kind,
                session_reused,
                first_event_observed: false,
                messages: HashMap::new(),
                active_messages: HashMap::new(),
                terminal_message_id: None,
                completed: false,
                pending_completion: None,
            });
        }
        live.turn_ready.notify_one();
        *live.last_turn_id.lock().await = Some(turn_id);
        let checkpoint_started = std::time::Instant::now();
        self.checkpoint(&thread, turn_id, "before").await;
        tracing::info!(
            target: "kybern::turn_startup",
            thread_id = %thread.id,
            turn_id = %turn_id,
            provider = %thread.provider.kind,
            session_reused,
            phase = "checkpoint_ready",
            phase_ms = checkpoint_started.elapsed().as_millis() as u64,
            elapsed_ms = startup_started.elapsed().as_millis() as u64,
        );

        let delivery = if is_compact_message(&message) {
            live.session.compact().await
        } else {
            live.session.send_message(&message_id.to_string(), &message).await
        };
        if let Err(e) = delivery {
            self.emit(thread.id, Some(turn_id), EventPayload::TurnFailed { error: e.to_string() })?;
            let mut t = thread;
            t.status = ThreadStatus::Failed;
            self.update_thread(t)?;
            *live.turn.lock().await = None;
            return Err(e.into());
        }
        self.collaboration_delivery_submitted(thread.id, turn_id, message_id)?;
        tracing::info!(
            target: "kybern::turn_startup",
            thread_id = %thread.id,
            turn_id = %turn_id,
            provider = %thread.provider.kind,
            session_reused,
            phase = "prompt_sent",
            elapsed_ms = startup_started.elapsed().as_millis() as u64,
        );
        Ok(())
    }

    pub async fn interrupt(&self, thread_id: ThreadId) -> Result<()> {
        self.interrupt_with_grace(thread_id, Duration::from_secs(5)).await
    }

    async fn interrupt_with_grace(&self, thread_id: ThreadId, grace: Duration) -> Result<()> {
        let live = self.inner.sessions.lock().await.get(&thread_id).cloned().ok_or_else(|| anyhow!("thread has no live session"))?;
        let response_id = live.turn.lock().await.as_ref().map(|turn| turn.response_id);
        live.touch();
        let this = self.clone();
        // The RPC connection may disappear while stopping. Cleanup still owns
        // the deadline, including a provider that never acknowledges interrupt.
        tokio::spawn(async move {
            let stopped = async {
                live.session.interrupt().await?;
                loop {
                    if live.is_released()
                        || live.turn.lock().await.as_ref().map(|turn| turn.response_id) != response_id
                        || (response_id.is_none() && !live.tasks.lock().await.values().any(|task| task.status.is_active()))
                    {
                        return Ok::<_, kybern_drivers::DriverError>(());
                    }
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
            };
            if !matches!(tokio::time::timeout(grace, stopped).await, Ok(Ok(()))) {
                this.force_interrupt(thread_id, &live, response_id).await?;
            }
            Ok::<_, anyhow::Error>(())
        })
        .await??;
        Ok(())
    }

    async fn force_interrupt(&self, thread_id: ThreadId, live: &Arc<LiveSession>, response_id: Option<Uuid>) -> Result<()> {
        let done = {
            let mut sessions = self.inner.sessions.lock().await;
            let turn = live.turn.lock().await;
            if !sessions.get(&thread_id).is_some_and(|current| Arc::ptr_eq(current, live))
                || live.is_released()
                || turn.as_ref().map(|turn| turn.response_id) != response_id
            {
                return Ok(());
            }
            let (done, waiting) = tokio::sync::watch::channel(());
            self.inner.releasing.lock().await.insert(thread_id, waiting);
            live.mark_released();
            live.stop_cleanup.store(true, Ordering::Relaxed);
            sessions.remove(&thread_id);
            self.revoke_native_session(live);
            done
        };
        let result = async {
            // close() terminates the owned process tree if graceful EOF fails.
            // Keep the resume barrier until both process and turn are settled.
            live.session.close().await?;
            live.continuation.lock().await.take();
            self.restore_active_runtime_tasks(thread_id, live).await?;
            self.interrupt_runtime_tasks(thread_id, live, "Stopped because the provider did not finish interrupting").await;
            self.process_driver_event(
                thread_id,
                live,
                DriverEvent::TurnCompleted {
                    stop_reason: StopReason::Interrupted,
                    usage: Usage::default(),
                    cost_usd: None,
                    duration_ms: 0,
                    anchors: TurnAnchors::default(),
                },
                true,
            )
            .await?;
            self.emit(
                thread_id,
                None,
                EventPayload::ProviderNotice {
                    level: NoticeLevel::Warning,
                    text: "The agent did not finish stopping, so Kybern closed its process. Send a message to resume the conversation."
                        .into(),
                    data: None,
                },
            )?;
            Ok::<_, anyhow::Error>(())
        }
        .await;
        self.inner.releasing.lock().await.remove(&thread_id);
        drop(done);
        result
    }

    pub async fn stop_runtime_task(&self, thread_id: ThreadId, task_id: &str) -> Result<RuntimeTask> {
        let live = self
            .inner
            .sessions
            .lock()
            .await
            .get(&thread_id)
            .cloned()
            .ok_or_else(|| anyhow!("this task no longer has a live provider session"))?;
        let task = live
            .tasks
            .lock()
            .await
            .get(task_id)
            .cloned()
            .ok_or_else(|| anyhow!("this task is not attached to the live provider session"))?;
        if !task.status.is_active() {
            return Err(anyhow!("this task has already finished"));
        }
        if !task.capabilities.stop {
            return Err(anyhow!("{} does not expose a targeted stop control for this task", self.provider_name(thread_id)?));
        }
        live.touch();
        live.session.stop_runtime_task(&task).await?;
        self.apply_runtime_task_update(
            thread_id,
            &live,
            DriverRuntimeTaskUpdate::status(task.id.clone(), RuntimeTaskStatus::Stopping),
            RuntimeTaskUpdateKind::Progress,
        )
        .await?
        .ok_or_else(|| anyhow!("task not found"))
    }

    pub async fn background_runtime_task(&self, thread_id: ThreadId, task_id: &str) -> Result<RuntimeTask> {
        let live = self
            .inner
            .sessions
            .lock()
            .await
            .get(&thread_id)
            .cloned()
            .ok_or_else(|| anyhow!("this task no longer has a live provider session"))?;
        let task = live
            .tasks
            .lock()
            .await
            .get(task_id)
            .cloned()
            .ok_or_else(|| anyhow!("this task is not attached to the live provider session"))?;
        if !task.status.is_active() {
            return Err(anyhow!("this task has already finished"));
        }
        if !task.capabilities.background {
            return Err(anyhow!("{} cannot move this task to the background", self.provider_name(thread_id)?));
        }
        live.touch();
        live.session.background_runtime_task(&task).await?;
        self.apply_runtime_task_update(
            thread_id,
            &live,
            DriverRuntimeTaskUpdate {
                id: task.id.clone(),
                status: None,
                detail: None,
                backgrounded: Some(true),
                last_tool_name: None,
                usage: None,
                stats: None,
                capabilities: Some(RuntimeTaskCapabilities { stop: task.capabilities.stop, background: false }),
            },
            RuntimeTaskUpdateKind::Progress,
        )
        .await?
        .ok_or_else(|| anyhow!("task not found"))
    }

    fn provider_name(&self, thread_id: ThreadId) -> Result<&'static str> {
        Ok(self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("thread not found"))?.provider.kind.display_name())
    }

    /// Async questions are ordinary user input, not provider permission responses.
    /// Serialize submissions so two clients cannot answer the same question twice.
    pub async fn answer_questions(&self, params: methods::ThreadsAnswerParams) -> Result<()> {
        let _answer = self.inner.question_answers.lock().await;
        let events = self.inner.store.events_for_thread(params.thread_id)?;
        if let Some(previous) = events.iter().find_map(|event| match &event.payload {
            EventPayload::AsyncQuestionsAnswered { request_id, answers, .. } if request_id == &params.request_id => Some(answers),
            _ => None,
        }) {
            return if previous == &params.answers {
                Ok(())
            } else {
                Err(anyhow!("This question has already been answered. Send a new message to change your answer."))
            };
        }
        let request = kybern_store::project_pending_questions(&events)
            .into_iter()
            .find(|r| r.id == params.request_id)
            .ok_or_else(|| anyhow!("Question not found. Refresh the conversation and try again."))?;
        if request.questions.len() != params.answers.len() || params.answers.iter().any(|a| a.trim().is_empty()) {
            return Err(anyhow!("Answer each question before submitting."));
        }
        let message = UserMessage::text(
            request
                .questions
                .iter()
                .zip(&params.answers)
                .map(|(question, answer)| format!("{}\nAnswer: {}", question.title, answer.trim()))
                .collect::<Vec<_>>()
                .join("\n\n"),
        );
        let thread = self.inner.store.thread_get(params.thread_id)?.ok_or_else(|| anyhow!("thread not found"))?;
        if thread.status == ThreadStatus::Archived {
            return Err(anyhow!("Unarchive this conversation before answering."));
        }
        let message_id = Uuid::now_v7();
        let turn_id = if matches!(thread.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval) {
            let live = self
                .inner
                .sessions
                .lock()
                .await
                .get(&params.thread_id)
                .cloned()
                .ok_or_else(|| anyhow!("The agent is starting. Submit your answer again in a moment."))?;
            let turn = live.turn.lock().await;
            let active = turn
                .as_ref()
                .filter(|turn| !turn.completed)
                .ok_or_else(|| anyhow!("The turn just ended. Submit your answer again to continue the conversation."))?;
            live.touch();
            live.session.steer(&message_id.to_string(), &message).await?;
            active.id
        } else {
            self.send_with_id(params.thread_id, message_id, message.clone(), false, false).await?.0
        };
        self.emit(
            params.thread_id,
            Some(turn_id),
            EventPayload::AsyncQuestionsAnswered { request_id: params.request_id, answers: params.answers, message_id, message },
        )?;
        Ok(())
    }

    pub async fn respond_approval(&self, approval_id: ApprovalId, decision: ApprovalDecision) -> Result<()> {
        let (approval, resolved) = self.inner.store.approval_get(approval_id)?.ok_or_else(|| anyhow!("approval not found"))?;
        if resolved {
            return Err(anyhow!("approval already resolved"));
        }
        approval.validate_decision(&decision).map_err(|message| anyhow!(message))?;
        let live =
            self.inner.sessions.lock().await.get(&approval.thread_id).cloned().ok_or_else(|| anyhow!("thread has no live session"))?;
        let mut pending = live.pending.lock().await;
        let request_id = pending.get(&approval_id).cloned().ok_or_else(|| anyhow!("approval no longer pending"))?;
        live.touch();
        live.session.respond_permission(&request_id, &decision).await?;
        pending.remove(&approval_id);
        drop(pending);
        self.inner.store.approval_resolve(approval_id, &decision)?;
        self.emit(approval.thread_id, Some(approval.turn_id), EventPayload::ApprovalResolved { approval_id, decision })?;
        if live.pending.lock().await.is_empty()
            && let Some(mut t) = self.inner.store.thread_get(approval.thread_id)?
            && t.status == ThreadStatus::AwaitingApproval
        {
            t.status = ThreadStatus::Running;
            self.update_thread(t)?;
        }
        Ok(())
    }

    async fn resolve_finished_requests(&self, thread_id: ThreadId, turn_id: TurnId, live: &LiveSession) -> Result<()> {
        let mut pending = live.pending.lock().await;
        let ids = pending.keys().copied().collect::<Vec<_>>();
        for id in ids {
            let Some((request, resolved)) = self.inner.store.approval_get(id)? else { continue };
            if request.turn_id != turn_id || resolved {
                continue;
            }
            let decision = ApprovalDecision::Deny { reason: Some("turn ended".into()) };
            if let Some(provider_id) = pending.remove(&id) {
                let _ = live.session.respond_permission(&provider_id, &decision).await;
            }
            self.inner.store.approval_resolve(id, &decision)?;
            self.emit(thread_id, Some(turn_id), EventPayload::ApprovalResolved { approval_id: id, decision })?;
        }
        Ok(())
    }

    /// Snapshot the working tree for a turn. Silently skipped for non-git projects.
    async fn checkpoint(&self, thread: &Thread, turn_id: TurnId, which: &str) {
        let repo = Repo::new(&thread.cwd);
        if !Repo::is_repo(std::path::Path::new(&thread.cwd)).await {
            return;
        }
        let commit = match repo.snapshot(&format!("kybern checkpoint {which} for turn {turn_id}")).await {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(thread_id = %thread.id, %e, "checkpoint failed");
                return;
            }
        };
        let _ = repo.update_ref(&checkpoint_ref(&thread.id.to_string(), &turn_id.to_string(), which), &commit).await;
        let checkpoint = match which {
            "before" => Checkpoint {
                thread_id: thread.id,
                turn_id,
                before: commit,
                after: None,
                provider_turn_id: None,
                provider_turn_end: None,
                created_at: Utc::now(),
            },
            _ => match self.inner.store.checkpoint_get(turn_id) {
                Ok(Some(mut c)) => {
                    c.after = Some(commit);
                    c
                }
                _ => return,
            },
        };
        if let Err(e) = self.inner.store.checkpoint_upsert(&checkpoint) {
            tracing::warn!(%e, "store checkpoint");
            return;
        }
        let _ = self.emit(thread.id, Some(turn_id), EventPayload::CheckpointUpdated { checkpoint });
    }

    /// Kick off a background title generation for threads still carrying the derived title.
    fn maybe_generate_title(&self, thread: &Thread) {
        if !self.inner.settings.get().generate_titles {
            return;
        }
        let Ok(events) = self.inner.store.events_for_thread(thread.id) else { return };
        let first = events.iter().find_map(|e| match &e.payload {
            EventPayload::TurnStarted { message, .. } => Some(message.clone()),
            _ => None,
        });
        let Some(first) = first else { return };
        let turns = events.iter().filter(|e| matches!(e.payload, EventPayload::TurnStarted { .. })).count();
        if turns != 1 || thread.title != title_from_message(&first) {
            return;
        }
        let this = self.clone();
        let thread = thread.clone();
        tokio::spawn(async move {
            match this.generate_title(&thread, &first).await {
                Ok(Some(title)) => {
                    if let Ok(Some(mut t)) = this.inner.store.thread_get(thread.id) {
                        t.title = title;
                        let _ = this.update_thread(t);
                    }
                }
                Ok(None) => {}
                Err(e) => tracing::debug!(thread_id = %thread.id, %e, "title generation skipped"),
            }
        });
    }

    pub async fn generate_title(&self, thread: &Thread, first: &UserMessage) -> Result<Option<String>> {
        let settings = self.inner.settings.get();
        let mut kinds = vec![thread.provider.kind];
        if let Some(k) = settings.title_provider {
            kinds.insert(0, k);
        }
        kinds.push(ProviderKind::ClaudeCode);
        kinds.push(ProviderKind::Codex);
        let prompt = format!(
            "Write a title for a coding session that starts with the request below. Reply with the title only: at most 6 words, sentence case, no quotes, no trailing period.\n\nRequest:\n{}",
            first.plain_text().chars().take(1500).collect::<String>()
        );
        let cwd = PathBuf::from(&thread.cwd);
        let mut seen = std::collections::HashSet::new();
        for kind in kinds {
            if !seen.insert(kind) {
                continue;
            }
            let Some(driver) = self.inner.drivers.get(kind) else { continue };
            let _harness = self.inner.harness_gates[&kind].read().await;
            let binary = self.binary_for(kind);
            match driver.one_shot(&cwd, &prompt, binary.as_ref()).await {
                Ok(text) => {
                    let title = clean_title(&text);
                    if !title.is_empty() {
                        return Ok(Some(title));
                    }
                }
                Err(kybern_drivers::DriverError::Unsupported(_)) => continue,
                Err(e) => tracing::debug!(%kind, %e, "title provider failed"),
            }
        }
        Ok(None)
    }

    /// Ask a model for a short prompt answer using the thread's provider, falling back to others.
    async fn one_shot_any(&self, thread: &Thread, prompt: &str) -> Result<String> {
        let mut kinds = vec![thread.provider.kind, ProviderKind::ClaudeCode, ProviderKind::Codex];
        kinds.dedup();
        let cwd = PathBuf::from(&thread.cwd);
        let mut last: Option<anyhow::Error> = None;
        for kind in kinds {
            let Some(driver) = self.inner.drivers.get(kind) else { continue };
            let _harness = self.inner.harness_gates[&kind].read().await;
            match driver.one_shot(&cwd, prompt, self.binary_for(kind).as_ref()).await {
                Ok(t) if !t.trim().is_empty() => return Ok(t),
                Ok(_) => {}
                Err(kybern_drivers::DriverError::Unsupported(_)) => {}
                Err(e) => last = Some(e.into()),
            }
        }
        Err(last.unwrap_or_else(|| anyhow!("no provider can generate text right now")))
    }

    pub async fn generate_commit_message(&self, thread: &Thread) -> Result<String> {
        let repo = Repo::new(&thread.cwd);
        let snapshot = repo.snapshot("kybern commit message").await?;
        let head = repo.head().await.unwrap_or_default();
        let diff = if head.is_empty() { String::new() } else { repo.diff(&head, &snapshot).await?.patch };
        let prompt = format!(
            "Write a git commit message for the diff below. First line: imperative, under 60 characters. Then a blank line and one to three short sentences explaining why. Reply with the message only.\n\n{}",
            diff.chars().take(20000).collect::<String>()
        );
        let text = self.one_shot_any(thread, &prompt).await?;
        Ok(text.trim().trim_matches('`').trim().to_string())
    }

    pub async fn generate_pr_text(&self, thread: &Thread, base: &str) -> Result<(String, String)> {
        let diff = crate::github::diff_against_base(std::path::Path::new(&thread.cwd), base).await.unwrap_or_default();
        let prompt = format!(
            "Write a pull request title and description for the diff below. Format exactly as:\nTITLE: <under 70 characters>\nBODY:\n<markdown with a short summary and a bullet list of changes>\n\nThread request: {}\n\nDiff:\n{}",
            thread.title,
            diff.chars().take(24000).collect::<String>()
        );
        let text = self.one_shot_any(thread, &prompt).await?;
        let mut title = thread.title.clone();
        let mut body = String::new();
        let mut in_body = false;
        for line in text.lines() {
            if let Some(t) = line.strip_prefix("TITLE:") {
                title = t.trim().to_string();
            } else if line.trim_start().starts_with("BODY:") {
                in_body = true;
            } else if in_body {
                body.push_str(line);
                body.push('\n');
            }
        }
        if body.trim().is_empty() {
            body = text;
        }
        Ok((title, body.trim().to_string()))
    }

    /// Turn uploaded image attachments into inline images so drivers can send them.
    fn resolve_attachments(&self, message: &mut UserMessage) {
        use base64::Engine;
        for part in message.parts.iter_mut() {
            if let ContentPart::Attachment { asset_id, media_type, .. } = part
                && media_type.starts_with("image/")
                && let Ok(bytes) = std::fs::read(self.inner.paths.assets.join(asset_id.to_string()))
            {
                *part =
                    ContentPart::Image { media_type: media_type.clone(), data: base64::engine::general_purpose::STANDARD.encode(bytes) };
            }
        }
    }

    pub async fn diff(&self, thread_id: ThreadId, turn_id: Option<TurnId>, include_patch: bool, path: Option<&str>) -> Result<Diff> {
        let thread = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("thread not found"))?;
        let repo = Repo::new(&thread.cwd);
        if !Repo::is_repo(std::path::Path::new(&thread.cwd)).await {
            return Err(anyhow!("project is not a git repository"));
        }
        let (from, to) = match turn_id {
            Some(turn) => {
                let c = self.inner.store.checkpoint_get(turn)?.ok_or_else(|| anyhow!("no checkpoint for that turn"))?;
                let to = match c.after {
                    Some(a) => a,
                    None => repo.snapshot("kybern diff (in progress)").await?,
                };
                (c.before, to)
            }
            None => {
                let first = self
                    .inner
                    .store
                    .checkpoints_for_thread(thread_id)?
                    .into_iter()
                    .next()
                    .ok_or_else(|| anyhow!("thread has no checkpoints yet"))?;
                (first.before, repo.snapshot("kybern diff (now)").await?)
            }
        };
        repo.diff_with_options(&from, &to, include_patch, path).await
    }

    /// Reset the working tree to the snapshot taken before `turn_id`.
    pub async fn revert(&self, thread_id: ThreadId, turn_id: TurnId) -> Result<(String, bool)> {
        let thread = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("thread not found"))?;
        if matches!(thread.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval) {
            return Err(anyhow!("thread is busy; interrupt it first"));
        }
        if self.inner.store.runtime_tasks_for_thread(thread_id)?.iter().any(|task| task.status.is_active()) {
            return Err(anyhow!("background work is active; stop it before rewinding"));
        }
        let all = self.inner.store.checkpoints_for_thread(thread_id)?;
        let idx = all.iter().position(|c| c.turn_id == turn_id).ok_or_else(|| anyhow!("no checkpoint for that turn"))?;
        let c = all[idx].clone();
        let repo = Repo::new(&thread.cwd);
        repo.restore(&c.before).await?;
        self.emit(thread_id, Some(turn_id), EventPayload::WorkspaceReverted { to_turn_id: turn_id, commit: c.before.clone() })?;

        if let Some(live) = self.inner.sessions.lock().await.remove(&thread_id) {
            live.mark_released();
            self.revoke_native_session(&live);
            let _ = live.session.close().await;
        }

        // Conversation rewind: the next session forks the provider conversation, keeping
        // turns before `turn_id`. If this is the first turn, start over with a fresh session.
        let driver_supports_fork = self.inner.drivers.get(thread.provider.kind).is_some_and(|d| d.supports_fork());
        let anchors = |c: &Checkpoint| TurnAnchors { turn_id: c.provider_turn_id.clone(), previous_end: c.provider_turn_end.clone() };
        let mut t = thread.clone();
        let conversation_rewound = if idx == 0 || thread.provider_session_id.is_none() {
            t.provider_session_id = None;
            true
        } else if driver_supports_fork && (c.provider_turn_id.is_some() || all[idx - 1].provider_turn_end.is_some()) {
            let point = RewindPoint { drop_from: anchors(&c), keep_through: Some(anchors(&all[idx - 1])) };
            self.inner.pending_rewinds.lock().await.insert(thread_id, point);
            true
        } else {
            false
        };
        // Drop the checkpoints and events' effect of turns from `turn_id` on: keep the log
        // (history is append-only) but mark the thread so the transcript shows the cut.
        t.status = ThreadStatus::Idle;
        self.update_thread(t)?;
        Ok((c.before, conversation_rewound))
    }

    async fn ensure_session(&self, thread: &Thread) -> Result<(Arc<LiveSession>, bool)> {
        let waiting = {
            let sessions = self.inner.sessions.lock().await;
            if let Some(live) = sessions.get(&thread.id).cloned() {
                return Ok((live, true));
            }
            self.inner.releasing.lock().await.get(&thread.id).cloned()
        };
        if let Some(mut waiting) = waiting {
            let _ = waiting.changed().await;
        }
        let rewind = self.inner.pending_rewinds.lock().await.remove(&thread.id);
        self.spawn_session(thread, rewind).await.map(|live| (live, false))
    }

    async fn spawn_session(&self, thread: &Thread, rewind: Option<RewindPoint>) -> Result<Arc<LiveSession>> {
        let driver = self
            .inner
            .drivers
            .get(thread.provider.kind)
            .ok_or_else(|| anyhow!("provider {} is not available in this build", thread.provider.kind))?;
        let project = self.inner.store.project_get(thread.project_id)?.ok_or_else(|| anyhow!("Project not found"))?;
        let mut provider_settings =
            crate::settings::provider_settings(&self.inner.settings.get(), thread.provider.kind, Some(&project.path));
        let mut profile_binding = None;
        if thread.provider.kind == ProviderKind::Omp {
            // A resumed chat must keep the profile that owns its native session,
            // even after project defaults change or the daemon releases it at idle.
            let key = format!("omp_profile:{}", thread.id);
            let profile = match self.inner.store.meta_get(&key)? {
                Some(profile) => profile,
                None => kybern_drivers::omp_profile::resolve(&provider_settings.env)?,
            };
            provider_settings.env.insert("OMP_PROFILE".into(), profile.clone());
            profile_binding = Some((key, profile));
        }
        let session_instance_id = Uuid::now_v7();
        let restrictions = self.native_tool_restrictions(thread)?;
        let coordinator_instructions = self.coordinator_instructions(thread)?;
        let native_tool_bridge = self
            .inner
            .native_tools
            .as_ref()
            .map(|gateway| {
                gateway.register_coordinator(
                    thread.id,
                    session_instance_id,
                    crate::app_tools::native_tool_definitions(),
                    restrictions,
                    coordinator_instructions,
                )
            })
            .transpose()?;
        let config = SessionConfig {
            cwd: PathBuf::from(&thread.cwd),
            model: thread.model.clone(),
            effort: thread.effort.clone(),
            permission_mode: thread.permission_mode,
            resume_session_id: thread.provider_session_id.clone(),
            fork: rewind.is_some(),
            rewind,
            binary: provider_settings.binary.map(PathBuf::from),
            env: provider_settings.env.into_iter().collect(),
            native_tool_bridge,
        };
        let SpawnedSession { session, events } = match driver.spawn(config).await {
            Ok(spawned) => spawned,
            Err(error) => {
                if let Some(gateway) = &self.inner.native_tools {
                    gateway.revoke(session_instance_id);
                }
                return Err(error.into());
            }
        };
        // A failed executable launch must not pin a profile before a session exists.
        if let Some((key, profile)) = profile_binding
            && let Err(error) = self.inner.store.meta_set(&key, &profile)
        {
            if let Some(gateway) = &self.inner.native_tools {
                gateway.revoke(session_instance_id);
            }
            let _ = session.close().await;
            return Err(error);
        }
        let live = Arc::new(LiveSession {
            session_instance_id,
            session,
            last_activity: std::sync::Mutex::new(SessionActivityTime::now()),
            released: AtomicBool::new(false),
            stop_cleanup: AtomicBool::new(false),
            turn: Mutex::new(None),
            continuation: Mutex::new(None),
            turn_ready: tokio::sync::Notify::new(),
            last_turn_id: Mutex::new(None),
            tasks: Mutex::new(HashMap::new()),
            deferred_checkpoints: Mutex::new(HashSet::new()),
            pending: Mutex::new(HashMap::new()),
            app_tool_requests: Mutex::new(HashSet::new()),
            app_tool_permits: Arc::new(Semaphore::new(crate::app_tools::MAX_CONCURRENT_REQUESTS)),
        });
        self.inner.sessions.lock().await.insert(thread.id, live.clone());
        let this = self.clone();
        let thread_id = thread.id;
        let pump_live = live.clone();
        tokio::spawn(async move { this.pump(thread_id, pump_live, events).await });
        Ok(live)
    }

    fn native_tool_restrictions(&self, thread: &Thread) -> Result<kybern_drivers::NativeToolRestrictions> {
        let group_id = thread
            .collaboration_group_id
            .or_else(|| {
                thread
                    .coordinator_project_id
                    .and_then(|project_id| self.inner.store.project_coordinator(project_id).ok().flatten().map(|(_, group_id)| group_id))
            })
            .or(self.inner.store.collaboration_group_for_thread(thread.id)?);
        let Some(group_id) = group_id else { return Ok(Default::default()) };
        let group = self.inner.store.collaboration_group_get(group_id)?.ok_or_else(|| anyhow!("collaboration group not found"))?;
        if group.coordinator_mode != CoordinatorMode::Dedicated || group.coordinator_thread_id != thread.id {
            return Ok(Default::default());
        }
        Ok(kybern_drivers::NativeToolRestrictions {
            allowed_tools: vec![
                "kybern_thread_context",
                "kybern_read_file",
                "kybern_list_files",
                "kybern_workspace_diff",
                "kybern_threads_search",
                "kybern_thread_read",
                "kybern_thread_send",
                "kybern_collaboration_spawn",
                "kybern_collaboration_send",
                "kybern_collaboration_read",
                "kybern_collaboration_wait",
                "kybern_collaboration_cancel",
                "kybern_collaboration_context_read",
                "kybern_collaboration_context_put",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
            denied_tools: vec!["kybern_collaboration_report".into()],
            require_enforcement: true,
        })
    }

    fn coordinator_instructions(&self, thread: &Thread) -> Result<Option<String>> {
        let Some(project_id) = thread.coordinator_project_id else { return Ok(None) };
        let Some((coordinator_thread_id, group_id)) = self.inner.store.project_coordinator(project_id)? else { return Ok(None) };
        if coordinator_thread_id != thread.id {
            return Ok(None);
        }
        // Keep the provider's system/developer prefix stable across idle
        // releases and resumes. Live project data belongs in tool responses,
        // after the cached prefix, and is available after a harness switch too.
        let mut instructions = format!(
            "You are Kybern's persistent coordinator for project {project_id}, collaboration group {group_id}.\n\
             Plan work from the user's brief, delegate every editing and integration task through Kybern collaboration assignments, inspect and review worker results, maintain the project plan and durable project knowledge, and return a clear review to the user. Do not edit or integrate code yourself. Use explicit assignment boundaries and provenance. At session start, each new objective, and before delegating, use kybern_collaboration_read for the current objective and assignment state, and kybern_collaboration_context_read for the current plan, project.setup, and user-authored corrections. If conversation context is missing after a harness switch, use kybern_thread_read for this coordinator thread's saved conversation. Fetch additional pages as needed; never treat absent context as permission to start over. When spawning a child, omit permission_mode unless the user specifically requested an override so Kybern inherits the coordinator's existing authority. If a worker is blocked on approval, preserve it and report or resolve that approval; never cancel and recreate a worker to bypass approval. Persist the working plan as kind `plan`, update its status as progress arrives, and update it again with completion or remaining work after reviewing results. Save each reusable verified fact such as architecture notes and test commands as kind `research`, project choices as kind `decision`, and reviewed assignment outcomes as kind `result_reference` with kybern_collaboration_context_put. Record useful findings before reporting completion. Treat user-authored briefs and instructions as authoritative; never replace them with agent-authored claims. Review worker claims and artifacts before presenting them as complete. Some harnesses enforce the non-editing role by restricting tools; for harnesses without enforceable restrictions, this instruction still defines the coordinator role.\n\
             Read changing project knowledge and assignment results through these tools; they are intentionally not embedded in this stable role instruction.\n"
        );

        instructions.push_str("\nCheck whether first-time setup is required before implementation: if project.setup already exists, reuse it and continue without repeating setup. Otherwise, tell the user you are learning the project first. Delegate a research-only assignment to inspect repository instructions, architecture and entry points, development/test commands, and constraints relevant to the user's brief. For an empty project, record what exists and what is missing rather than inventing conventions. Do not edit files or run installation/setup commands during this research. Review the worker's successful result; save a concise verified overview with kybern_collaboration_context_put using key `project.setup`, kind `research`, and source_refs containing the successful research assignment's exact UUID. This records setup completion durably and unlocks editing/integration assignments. If research fails or needs input, explain the blocker and resume setup on the next turn; never claim readiness prematurely. After saving the overview, tell the user setup is complete, persist the task plan, and continue their original request without asking them to repeat it.\n");

        Ok(Some(instructions))
    }

    async fn persist_runtime_task_start(
        &self,
        thread_id: ThreadId,
        live: &Arc<LiveSession>,
        turn_id: Option<TurnId>,
        incoming: DriverRuntimeTask,
    ) -> Result<RuntimeTask> {
        let origin_turn_id = match turn_id.or(*live.last_turn_id.lock().await) {
            Some(turn_id) => turn_id,
            None => self
                .inner
                .store
                .events_for_thread(thread_id)?
                .iter()
                .rev()
                .find_map(|event| matches!(event.payload, EventPayload::TurnStarted { .. }).then_some(event.turn_id).flatten())
                .ok_or_else(|| anyhow!("provider reported a task before the thread had a turn"))?,
        };
        let now = Utc::now();
        let mut tasks = live.tasks.lock().await;
        let (task, started) = match tasks.get(&incoming.id) {
            Some(existing) => {
                let mut task = existing.clone();
                task.kind = incoming.kind;
                // Provider retries and aggregate rosters can replay a start
                // after terminal evidence. Runtime task state is monotonic.
                if task.status.is_active() || !incoming.status.is_active() {
                    task.status = incoming.status;
                }
                task.title = incoming.title;
                task.detail = incoming.detail.or(task.detail);
                task.provider_type = incoming.provider_type.or(task.provider_type);
                task.parent_id = incoming.parent_id.or(task.parent_id);
                task.tool_call_id = incoming.tool_call_id.or(task.tool_call_id);
                task.provider_thread_id = incoming.provider_thread_id.or(task.provider_thread_id);
                task.model = incoming.model.or(task.model);
                task.effort = incoming.effort.or(task.effort);
                task.backgrounded |= incoming.backgrounded;
                task.last_tool_name = incoming.last_tool_name.or(task.last_tool_name);
                task.usage = incoming.usage.or(task.usage);
                merge_task_stats(&mut task.stats, incoming.stats);
                task.capabilities = if task.status.is_active() { incoming.capabilities } else { RuntimeTaskCapabilities::default() };
                task.updated_at = now;
                if !task.status.is_active() {
                    task.completed_at.get_or_insert(now);
                }
                (task, false)
            }
            None => (
                RuntimeTask {
                    id: incoming.id,
                    thread_id,
                    origin_turn_id,
                    started_seq: 0,
                    updated_seq: 0,
                    kind: incoming.kind,
                    status: incoming.status,
                    title: incoming.title,
                    detail: incoming.detail,
                    provider_type: incoming.provider_type,
                    parent_id: incoming.parent_id,
                    tool_call_id: incoming.tool_call_id,
                    provider_thread_id: incoming.provider_thread_id,
                    model: incoming.model,
                    effort: incoming.effort,
                    backgrounded: incoming.backgrounded,
                    last_tool_name: incoming.last_tool_name,
                    usage: incoming.usage,
                    stats: incoming.stats,
                    capabilities: incoming.capabilities,
                    started_at: now,
                    updated_at: now,
                    completed_at: (!incoming.status.is_active()).then_some(now),
                },
                true,
            ),
        };
        tasks.insert(task.id.clone(), task.clone());
        drop(tasks);
        let payload = if started {
            EventPayload::RuntimeTaskStarted { task: task.clone() }
        } else if task.status.is_active() {
            EventPayload::RuntimeTaskUpdated { task: task.clone() }
        } else {
            EventPayload::RuntimeTaskCompleted { task: task.clone() }
        };
        let emitted = self.emit(thread_id, Some(task.origin_turn_id), payload)?;
        let task = match emitted.payload {
            EventPayload::RuntimeTaskStarted { task }
            | EventPayload::RuntimeTaskUpdated { task }
            | EventPayload::RuntimeTaskCompleted { task } => task,
            _ => unreachable!("runtime task emission changed payload kind"),
        };
        live.tasks.lock().await.insert(task.id.clone(), task.clone());
        if !task.status.is_active() {
            self.finish_deferred_checkpoint(thread_id, live, task.origin_turn_id).await?;
        }
        Ok(task)
    }

    async fn apply_runtime_task_update(
        &self,
        thread_id: ThreadId,
        live: &Arc<LiveSession>,
        update: DriverRuntimeTaskUpdate,
        kind: RuntimeTaskUpdateKind,
    ) -> Result<Option<RuntimeTask>> {
        let mut tasks = live.tasks.lock().await;
        let Some(task) = tasks.get_mut(&update.id) else {
            tracing::debug!(thread_id = %thread_id, task_id = %update.id, "provider updated an unknown runtime task");
            return Ok(None);
        };
        let completed = kind == RuntimeTaskUpdateKind::Complete;
        let resumed = kind == RuntimeTaskUpdateKind::Resume;
        let next_status = match (update.status, completed) {
            (Some(status), true) if status.is_active() => RuntimeTaskStatus::Completed,
            (Some(status), _) => status,
            (None, true) => RuntimeTaskStatus::Completed,
            (None, false) => task.status,
        };
        if resumed || task.status.is_active() || !next_status.is_active() {
            task.status = next_status;
        }
        if let Some(detail) = update.detail {
            task.detail = Some(detail);
        }
        if let Some(backgrounded) = update.backgrounded {
            task.backgrounded = backgrounded;
        }
        if let Some(last_tool_name) = update.last_tool_name {
            task.last_tool_name = Some(last_tool_name);
        }
        if let Some(usage) = update.usage {
            task.usage = Some(usage);
        }
        if let Some(stats) = update.stats {
            merge_task_stats(&mut task.stats, stats);
        }
        if let Some(capabilities) = update.capabilities {
            task.capabilities = capabilities;
        }
        task.updated_at = Utc::now();
        if resumed {
            task.completed_at = None;
        } else if completed || !task.status.is_active() {
            task.completed_at = Some(task.updated_at);
            task.capabilities = RuntimeTaskCapabilities::default();
        }
        let task = task.clone();
        drop(tasks);
        let payload = if resumed {
            EventPayload::RuntimeTaskStarted { task: task.clone() }
        } else if completed || !task.status.is_active() {
            EventPayload::RuntimeTaskCompleted { task: task.clone() }
        } else {
            EventPayload::RuntimeTaskUpdated { task: task.clone() }
        };
        let emitted = self.emit(thread_id, Some(task.origin_turn_id), payload)?;
        let task = match emitted.payload {
            EventPayload::RuntimeTaskStarted { task }
            | EventPayload::RuntimeTaskUpdated { task }
            | EventPayload::RuntimeTaskCompleted { task } => task,
            _ => unreachable!("runtime task emission changed payload kind"),
        };
        live.tasks.lock().await.insert(task.id.clone(), task.clone());
        if !resumed && (completed || !task.status.is_active()) {
            self.finish_deferred_checkpoint(thread_id, live, task.origin_turn_id).await?;
        }
        Ok(Some(task))
    }

    async fn finish_deferred_checkpoint(&self, thread_id: ThreadId, live: &Arc<LiveSession>, turn_id: TurnId) -> Result<()> {
        let any_active = live.tasks.lock().await.values().any(|task| task.origin_turn_id == turn_id && task.status.is_active());
        if any_active || !live.deferred_checkpoints.lock().await.remove(&turn_id) {
            return Ok(());
        }
        if let Some(thread) = self.inner.store.thread_get(thread_id)? {
            self.checkpoint(&thread, turn_id, "after").await;
        }
        Ok(())
    }

    async fn interrupt_runtime_tasks(&self, thread_id: ThreadId, live: &Arc<LiveSession>, detail: &str) {
        let ids = live.tasks.lock().await.values().filter(|task| task.status.is_active()).map(|task| task.id.clone()).collect::<Vec<_>>();
        for id in ids {
            let _ = self
                .apply_runtime_task_update(
                    thread_id,
                    live,
                    DriverRuntimeTaskUpdate {
                        id,
                        status: Some(RuntimeTaskStatus::Interrupted),
                        detail: Some(detail.into()),
                        backgrounded: None,
                        last_tool_name: None,
                        usage: None,
                        stats: None,
                        capabilities: None,
                    },
                    RuntimeTaskUpdateKind::Complete,
                )
                .await;
        }
    }

    /// Only call while retiring the current session behind the resume barrier.
    /// A prior broken transport may have left durable work absent from the
    /// current handle's task map. Include it in the same terminal projection.
    async fn restore_active_runtime_tasks(&self, thread_id: ThreadId, live: &Arc<LiveSession>) -> Result<()> {
        let stored = self.inner.store.runtime_tasks_for_thread(thread_id)?;
        let mut tasks = live.tasks.lock().await;
        for task in stored.into_iter().filter(|task| task.status.is_active()) {
            tasks.entry(task.id.clone()).or_insert(task);
        }
        Ok(())
    }

    /// Translate driver events into thread events until the provider exits.
    async fn pump(self, thread_id: ThreadId, live: Arc<LiveSession>, mut events: tokio::sync::mpsc::Receiver<DriverEvent>) {
        while let Some(ev) = events.recv().await {
            // Exited is terminal even when the public driver handle retains a
            // sender. Waiting for channel EOF would keep that handle (and its
            // background tasks) alive forever, notably with Pi/OMP.
            let exited = matches!(ev, DriverEvent::Exited { .. });
            if let Err(e) = self.handle_driver_event(thread_id, &live, ev).await {
                tracing::error!(%thread_id, error = %e, "failed to persist driver event");
            }
            if exited {
                break;
            }
        }
        // An idle session retired for an update must not remove its replacement.
        let cleanup_barrier = {
            let mut sessions = self.inner.sessions.lock().await;
            // Forced interruption owns task and turn settlement. Other exits
            // (including shutdown/archive) still need the cleanup below.
            if live.stop_cleanup.load(Ordering::Relaxed) {
                return;
            }
            if sessions.get(&thread_id).is_some_and(|current| Arc::ptr_eq(current, &live)) {
                let (done, waiting) = tokio::sync::watch::channel(());
                self.inner.releasing.lock().await.insert(thread_id, waiting);
                live.mark_released();
                sessions.remove(&thread_id);
                self.revoke_native_session(&live);
                Some(done)
            } else {
                None
            }
        };
        if cleanup_barrier.is_some()
            && let Err(error) = self.restore_active_runtime_tasks(thread_id, &live).await
        {
            tracing::error!(%thread_id, %error, "failed to recover tasks from the exited provider");
        }
        self.interrupt_runtime_tasks(thread_id, &live, "Provider exited before this work finished").await;
        let turn = live.turn.lock().await.take();
        if let Some(turn) = turn.filter(|t| !t.completed) {
            let _ = self.resolve_finished_requests(thread_id, turn.id, &live).await;
            let _ =
                self.emit(thread_id, Some(turn.id), EventPayload::TurnFailed { error: "provider exited before finishing the turn".into() });
            if let Ok(Some(mut t)) = self.inner.store.thread_get(thread_id) {
                t.status = ThreadStatus::Failed;
                let _ = self.update_thread(t);
            }
        }
        if cleanup_barrier.is_some() {
            self.inner.releasing.lock().await.remove(&thread_id);
        }
        drop(cleanup_barrier);
    }

    async fn owns_app_tool_turn(&self, thread_id: ThreadId, live: &Arc<LiveSession>, expected_turn: Option<TurnId>) -> Option<TurnId> {
        if live.is_released() || live.stop_cleanup.load(Ordering::Relaxed) {
            return None;
        }
        let current = self.inner.sessions.lock().await.get(&thread_id).cloned();
        if !current.as_ref().is_some_and(|current| Arc::ptr_eq(current, live)) {
            return None;
        }
        let turn = live.turn.lock().await;
        turn.as_ref().filter(|turn| !turn.completed && expected_turn.is_none_or(|expected| expected == turn.id)).map(|turn| turn.id)
    }

    async fn queue_app_tool_request(
        &self,
        thread_id: ThreadId,
        live: Arc<LiveSession>,
        request_id: String,
        name: String,
        arguments: serde_json::Value,
    ) {
        if request_id.is_empty() || request_id.len() > 128 {
            if request_id.len() <= 512 {
                reject_app_tool_request(live, request_id, "invalid app tool request id");
            }
            return;
        }
        if name.is_empty() || name.len() > 64 || !name.bytes().all(|byte| byte.is_ascii_lowercase() || byte == b'_') {
            reject_app_tool_request(live, request_id, "invalid app tool name");
            return;
        }
        if serde_json::to_vec(&arguments).map_or(true, |encoded| encoded.len() > crate::app_tools::MAX_ARGUMENT_BYTES) {
            reject_app_tool_request(live, request_id, "app tool arguments exceed the 64 KiB limit");
            return;
        }
        let Some(turn_id) = self.owns_app_tool_turn(thread_id, &live, None).await else {
            reject_app_tool_request(live, request_id, "app tool request has no active owning turn");
            return;
        };
        {
            let mut requests = live.app_tool_requests.lock().await;
            if !requests.insert(request_id.clone()) {
                drop(requests);
                reject_app_tool_request(live, request_id, "duplicate app tool request id");
                return;
            }
        }
        let permit = match live.app_tool_permits.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                live.app_tool_requests.lock().await.remove(&request_id);
                reject_app_tool_request(live, request_id, "too many concurrent app tool requests");
                return;
            }
        };

        let this = self.clone();
        tokio::spawn(async move {
            let mut result = if this.owns_app_tool_turn(thread_id, &live, Some(turn_id)).await.is_none() {
                Err("app tool request is stale".to_string())
            } else {
                let timeout = if name == "kybern_collaboration_wait" { Duration::from_secs(65) } else { crate::app_tools::REQUEST_TIMEOUT };
                match tokio::time::timeout(
                    timeout,
                    this.execute_native_app_tool_call(thread_id, live.session_instance_id, &request_id, &name, arguments),
                )
                .await
                {
                    Ok(Ok(value)) => Ok(value),
                    Ok(Err(error)) => Err(bounded_app_tool_error(error.to_string())),
                    Err(_) => Err("app tool request timed out".to_string()),
                }
            };
            if this.owns_app_tool_turn(thread_id, &live, Some(turn_id)).await.is_none() {
                result = Err("app tool request expired because its owning turn ended".to_string());
            }
            let response = tokio::time::timeout(Duration::from_secs(5), live.session.respond_app_tool(&request_id, result)).await;
            if let Ok(Err(error)) = response {
                tracing::debug!(%thread_id, %request_id, %error, "failed to return app tool result");
            }
            live.app_tool_requests.lock().await.remove(&request_id);
            drop(permit);
        });
    }

    async fn handle_driver_event(&self, thread_id: ThreadId, live: &Arc<LiveSession>, ev: DriverEvent) -> Result<()> {
        match ev {
            DriverEvent::AppToolRequest { request_id, name, arguments } => {
                self.queue_app_tool_request(thread_id, live.clone(), request_id, name, arguments).await;
                Ok(())
            }
            event => self.process_driver_event(thread_id, live, event, false).await,
        }
    }

    async fn process_driver_event(&self, thread_id: ThreadId, live: &Arc<LiveSession>, ev: DriverEvent, retiring: bool) -> Result<()> {
        live.touch();
        let starts_response = match &ev {
            DriverEvent::ResponseStarted => true,
            DriverEvent::TextDelta { origin, .. }
            | DriverEvent::ThinkingDelta { origin, .. }
            | DriverEvent::MessageCompleted { origin, .. }
            | DriverEvent::ImageReceived { origin, .. } => origin.is_root(),
            DriverEvent::ToolStarted(call) => call.parent_id.is_none(),
            _ => false,
        };
        let mut turn_guard = loop {
            let mut guard = live.turn.lock().await;
            if live.stop_cleanup.load(Ordering::Relaxed) && !retiring {
                return Ok(());
            }
            let mut waiting_for_start = false;
            if starts_response && guard.is_none() && !live.is_released() {
                let mut continuation = live.continuation.lock().await;
                // Serialize the decision to resume with send_with_id's decision
                // to accept user input. No await while holding the command lock.
                let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
                if let Some(mut thread) = self.inner.store.thread_get(thread_id)? {
                    waiting_for_start = thread.status == ThreadStatus::Running;
                    if thread.provider.kind == ProviderKind::ClaudeCode
                        && thread.status == ThreadStatus::Idle
                        && let Some(mut turn) = continuation.take()
                    {
                        turn.completed = false;
                        turn.response_id = Uuid::now_v7();
                        turn.messages.clear();
                        turn.active_messages.clear();
                        turn.terminal_message_id = None;
                        self.emit(thread_id, Some(turn.id), EventPayload::TurnResumed)?;
                        thread.status = ThreadStatus::Running;
                        self.update_thread(thread)?;
                        *guard = Some(turn);
                    }
                }
            }
            // A user request is persisted before async startup installs its
            // ActiveTurn. Buffer provider output during that gap, rather than
            // reopening the old turn or emitting unscoped transcript events.
            if waiting_for_start {
                drop(guard);
                live.turn_ready.notified().await;
                continue;
            }
            break guard;
        };
        let turn_id = turn_guard.as_ref().map(|t| t.id);
        let response_event = matches!(
            &ev,
            DriverEvent::ImageReceived { .. }
                | DriverEvent::TextDelta { .. }
                | DriverEvent::ThinkingDelta { .. }
                | DriverEvent::MessageCompleted { .. }
                | DriverEvent::ToolStarted(_)
                | DriverEvent::PermissionRequest { .. }
                | DriverEvent::TurnCompleted { .. }
                | DriverEvent::TurnFailed { .. }
        );
        if response_event
            && let Some(turn) = turn_guard.as_mut()
            && !turn.first_event_observed
        {
            turn.first_event_observed = true;
            tracing::info!(
                target: "kybern::turn_startup",
                thread_id = %thread_id,
                turn_id = %turn.id,
                provider = %turn.provider,
                session_reused = turn.session_reused,
                phase = "first_provider_event",
                elapsed_ms = turn.startup_started.elapsed().as_millis() as u64,
            );
        }
        match ev {
            DriverEvent::ResponseStarted => {}
            DriverEvent::ResponseBoundary => {
                if let Some(turn) = turn_guard.as_mut() {
                    turn.active_messages.remove(&EventOrigin::Root);
                }
            }
            DriverEvent::SessionBound { session_id, model } => {
                let mut t = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("thread vanished"))?;
                let changed = t.provider_session_id.as_deref() != Some(&session_id) || (model.is_some() && t.model != model);
                t.provider_session_id = Some(session_id.clone());
                if let Some(m) = model.clone() {
                    t.model = Some(m);
                }
                if changed {
                    self.update_thread(t)?;
                }
                self.emit(thread_id, turn_id, EventPayload::ProviderSessionBound { session_id, model })?;
            }
            DriverEvent::ImageReceived { id, origin, source } => {
                if source.len() <= 70_000_000 {
                    self.emit(thread_id, turn_id, EventPayload::ImageReceived { id, origin, source })?;
                }
            }
            DriverEvent::TextDelta { message_id, origin, delta } => {
                let id = map_message_delta(&mut turn_guard, &origin, &message_id);
                self.emit(thread_id, turn_id, EventPayload::AssistantTextDelta { message_id: id, origin, delta })?;
            }
            DriverEvent::ThinkingDelta { message_id, origin, delta } => {
                let id = map_message_delta(&mut turn_guard, &origin, &message_id);
                self.emit(thread_id, turn_id, EventPayload::AssistantThinkingDelta { message_id: id, origin, delta })?;
            }
            DriverEvent::AsyncQuestions(request) => {
                let events = self.inner.store.events_for_thread(thread_id)?;
                if !events.iter().any(|event| matches!(&event.payload, EventPayload::AsyncQuestionsRequested { request: previous } if previous.id == request.id)) {
                    self.emit(thread_id, turn_id, EventPayload::AsyncQuestionsRequested { request })?;
                }
            }
            DriverEvent::MessageCompleted { message_id, origin, text, thinking } => {
                let id = map_message_completion(&mut turn_guard, &origin, &message_id);
                if origin.is_root()
                    && !text.trim().is_empty()
                    && let Some(turn) = turn_guard.as_mut()
                {
                    turn.terminal_message_id = Some(id);
                }
                self.emit(thread_id, turn_id, EventPayload::AssistantMessageCompleted { message_id: id, origin, text, thinking })?;
            }
            DriverEvent::ToolStarted(call) => {
                let owner = if let Some(parent_id) = call.parent_id.as_deref() {
                    live.tasks
                        .lock()
                        .await
                        .values()
                        .find(|task| task.id == parent_id || task.tool_call_id.as_deref() == Some(parent_id))
                        .cloned()
                } else {
                    None
                };
                let origin = owner.as_ref().map_or(EventOrigin::Root, |task| EventOrigin::Agent {
                    task_id: task.id.clone(),
                    provider_thread_id: task.provider_thread_id.clone(),
                });
                self.emit(thread_id, turn_id, EventPayload::ToolCallStarted { call: call.clone(), origin })?;
                if let Some(task) = owner {
                    let _ = self
                        .apply_runtime_task_update(
                            thread_id,
                            live,
                            DriverRuntimeTaskUpdate {
                                id: task.id,
                                status: Some(RuntimeTaskStatus::Running),
                                detail: None,
                                backgrounded: None,
                                last_tool_name: Some(call.name.clone()),
                                usage: None,
                                stats: None,
                                capabilities: None,
                            },
                            RuntimeTaskUpdateKind::Progress,
                        )
                        .await?;
                }
                let provider = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("thread vanished"))?.provider.kind;
                if let Some(task) = generic_runtime_task_for_provider(provider, &call) {
                    self.persist_runtime_task_start(thread_id, live, turn_id, task).await?;
                }
            }
            DriverEvent::ToolOutputDelta { tool_call_id, delta } => {
                self.emit(thread_id, turn_id, EventPayload::ToolCallOutputDelta { tool_call_id, delta })?;
            }
            DriverEvent::ToolCompleted { tool_call_id, output, is_error } => {
                self.emit(
                    thread_id,
                    turn_id,
                    EventPayload::ToolCallCompleted {
                        tool_call_id: tool_call_id.clone(),
                        output: output.clone(),
                        output_omitted: false,
                        is_error,
                    },
                )?;
                let provider = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("thread vanished"))?.provider.kind;
                if matches!(provider, ProviderKind::Opencode | ProviderKind::Pi | ProviderKind::Cursor) {
                    let task_id = live
                        .tasks
                        .lock()
                        .await
                        .values()
                        .find(|task| task.tool_call_id.as_deref() == Some(&tool_call_id) && task.provider_thread_id.is_none())
                        .map(|task| task.id.clone());
                    if let Some(task_id) = task_id {
                        let detached = output_indicates_running(&output);
                        let status = if is_error { RuntimeTaskStatus::Failed } else { RuntimeTaskStatus::Completed };
                        let detail = detached.then(|| "Detached; this provider does not expose ongoing lifecycle updates".to_string());
                        let _ = self
                            .apply_runtime_task_update(
                                thread_id,
                                live,
                                DriverRuntimeTaskUpdate {
                                    id: task_id,
                                    status: Some(status),
                                    detail,
                                    backgrounded: detached.then_some(true),
                                    last_tool_name: None,
                                    usage: None,
                                    stats: None,
                                    capabilities: None,
                                },
                                RuntimeTaskUpdateKind::Complete,
                            )
                            .await?;
                    }
                }
            }
            DriverEvent::RuntimeTaskStarted(task) => {
                self.persist_runtime_task_start(thread_id, live, turn_id, task).await?;
            }
            DriverEvent::RuntimeTaskResumed(update) => {
                let _ = self.apply_runtime_task_update(thread_id, live, update, RuntimeTaskUpdateKind::Resume).await?;
            }
            DriverEvent::RuntimeTaskUpdated(update) => {
                let _ = self.apply_runtime_task_update(thread_id, live, update, RuntimeTaskUpdateKind::Progress).await?;
            }
            DriverEvent::RuntimeTaskCompleted(update) => {
                let _ = self.apply_runtime_task_update(thread_id, live, update, RuntimeTaskUpdateKind::Complete).await?;
            }
            DriverEvent::PermissionRequest { request_id, tool_call_id, tool_name, input, summary, suggestions } => {
                let Some(turn_id) = turn_id else {
                    tracing::warn!("permission request outside a turn; denying");
                    drop(turn_guard);
                    let _ = live
                        .session
                        .respond_permission(&request_id, &ApprovalDecision::Deny { reason: Some("no active turn".into()) })
                        .await;
                    return Ok(());
                };
                if let Some(turn) = turn_guard.as_mut() {
                    // A blocking pause is a real assistant-message boundary.
                    // Resumed prose gets a new logical identity even when the
                    // provider reuses its raw item id.
                    turn.active_messages.remove(&EventOrigin::Root);
                }
                let approval = ApprovalRequest {
                    id: Uuid::now_v7(),
                    thread_id,
                    turn_id,
                    tool_call_id,
                    tool_name,
                    input,
                    summary,
                    suggestions,
                    created_at: Utc::now(),
                };
                self.inner.store.approval_insert(&approval)?;
                live.pending.lock().await.insert(approval.id, request_id);
                let event = if approval.is_user_input() {
                    EventPayload::UserInputRequested { approval }
                } else {
                    EventPayload::ApprovalRequested { approval }
                };
                self.emit(thread_id, Some(turn_id), event)?;
                let mut t = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("thread vanished"))?;
                if t.status != ThreadStatus::AwaitingApproval {
                    t.status = ThreadStatus::AwaitingApproval;
                    self.update_thread(t)?;
                }
            }
            DriverEvent::PermissionWithdrawn { request_id } => {
                let mut pending = live.pending.lock().await;
                if let Some((approval_id, _)) = pending.iter().find(|(_, r)| **r == request_id).map(|(a, r)| (*a, r.clone())) {
                    pending.remove(&approval_id);
                    let decision = ApprovalDecision::Deny { reason: Some("withdrawn by provider".into()) };
                    self.inner.store.approval_resolve(approval_id, &decision)?;
                    self.emit(thread_id, turn_id, EventPayload::ApprovalResolved { approval_id, decision })?;
                    if pending.is_empty()
                        && let Some(mut thread) = self.inner.store.thread_get(thread_id)?
                        && thread.status == ThreadStatus::AwaitingApproval
                    {
                        thread.status = ThreadStatus::Running;
                        self.update_thread(thread)?;
                    }
                }
            }
            DriverEvent::AppToolRequest { .. } => {
                unreachable!("app tool requests are dispatched outside the sequential event pump")
            }
            DriverEvent::TurnCompleted { stop_reason, usage, cost_usd, duration_ms, anchors } => {
                let Some(turn) = turn_guard.as_mut() else { return Ok(()) };
                let has_pending_tasks = if turn.provider == ProviderKind::ClaudeCode && stop_reason == StopReason::Completed {
                    live.tasks
                        .lock()
                        .await
                        .values()
                        .any(|task| task.origin_turn_id == turn.id && task.kind != RuntimeTaskKind::Monitor && task.status.is_active())
                } else {
                    false
                };
                if has_pending_tasks {
                    // The foreground result closes the current assistant
                    // ordinal even though it does not yet settle the parent
                    // turn. Claude's task-triggered continuation is a new
                    // logical message and becomes the eventual terminal row.
                    turn.active_messages.remove(&EventOrigin::Root);
                    if let Some(pending) = turn.pending_completion.as_mut() {
                        pending.merge(stop_reason, usage, cost_usd, duration_ms, anchors);
                    } else {
                        turn.pending_completion = Some(PendingTurnCompletion { stop_reason, usage, cost_usd, duration_ms, anchors });
                    }
                    tracing::debug!(
                        thread_id = %thread_id,
                        turn_id = %turn.id,
                        "holding Claude's provisional result while background tasks finish"
                    );
                    return Ok(());
                }

                let had_pending_completion = turn.pending_completion.is_some();
                let mut completion = turn.pending_completion.take().unwrap_or(PendingTurnCompletion {
                    stop_reason,
                    usage: Usage::default(),
                    cost_usd: None,
                    duration_ms: 0,
                    anchors: TurnAnchors::default(),
                });
                completion.merge(stop_reason, usage, cost_usd, duration_ms, anchors);
                if !had_pending_completion {
                    // `completion` began empty above; merge supplied this event.
                    completion.duration_ms =
                        if completion.duration_ms == 0 { turn.started.elapsed().as_millis() as u64 } else { completion.duration_ms };
                } else {
                    // A resumed Claude turn spans the foreground result, the
                    // task wait, and the continuation. Present the wall time.
                    completion.duration_ms = completion.duration_ms.max(turn.started.elapsed().as_millis() as u64);
                }
                // Retain cumulative accounting when this settled turn is
                // reopened by a process/monitor notification later.
                turn.pending_completion = Some(completion.clone());
                let PendingTurnCompletion { stop_reason, usage, cost_usd, duration_ms, anchors } = completion;
                if (anchors.turn_id.is_some() || anchors.previous_end.is_some())
                    && let Ok(Some(mut c)) = self.inner.store.checkpoint_get(turn.id)
                {
                    c.provider_turn_id = anchors.turn_id.clone();
                    c.provider_turn_end = anchors.previous_end.clone();
                    let _ = self.inner.store.checkpoint_upsert(&c);
                }
                turn.completed = true;
                let terminal_message_id = turn.terminal_message_id;
                let turn_id = turn.id;
                turn.messages.clear();
                turn.active_messages.clear();
                let settled = turn_guard.take();
                if settled.as_ref().is_some_and(|turn| turn.provider == ProviderKind::ClaudeCode) && stop_reason == StopReason::Completed {
                    *live.continuation.lock().await = settled;
                }
                drop(turn_guard);
                self.resolve_finished_requests(thread_id, turn_id, live).await?;
                let mut t = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("thread vanished"))?;
                self.inner.store.usage_insert(&TurnUsageRow {
                    turn_id,
                    thread_id,
                    provider: t.provider.kind,
                    model: t.model.clone(),
                    usage: usage.clone(),
                    cost_usd,
                    duration_ms,
                    at: Utc::now(),
                })?;
                let has_active_tasks =
                    live.tasks.lock().await.values().any(|task| task.origin_turn_id == turn_id && task.status.is_active());
                if has_active_tasks {
                    live.deferred_checkpoints.lock().await.insert(turn_id);
                } else {
                    self.checkpoint(&t, turn_id, "after").await;
                }
                self.emit(
                    thread_id,
                    Some(turn_id),
                    EventPayload::TurnCompleted { stop_reason, usage, cost_usd, duration_ms, terminal_message_id },
                )?;
                t.status = ThreadStatus::Idle;
                let t = self.update_thread(t)?;
                self.maybe_generate_title(&t);
            }
            DriverEvent::TurnFailed { error } => {
                let Some(turn) = turn_guard.as_mut() else { return Ok(()) };
                turn.completed = true;
                let turn_id = turn.id;
                *turn_guard = None;
                drop(turn_guard);
                self.resolve_finished_requests(thread_id, turn_id, live).await?;
                let mut t = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("thread vanished"))?;
                let has_active_tasks =
                    live.tasks.lock().await.values().any(|task| task.origin_turn_id == turn_id && task.status.is_active());
                if has_active_tasks {
                    live.deferred_checkpoints.lock().await.insert(turn_id);
                } else {
                    self.checkpoint(&t, turn_id, "after").await;
                }
                self.emit(thread_id, Some(turn_id), EventPayload::TurnFailed { error })?;
                t.status = ThreadStatus::Failed;
                self.update_thread(t)?;
            }
            DriverEvent::CommandsUpdated(commands) => {
                self.emit(thread_id, turn_id, EventPayload::ProviderCommandsUpdated { commands })?;
            }
            DriverEvent::UsageUpdated(usage) => {
                self.emit(thread_id, turn_id, EventPayload::ProviderUsageUpdated { usage })?;
            }
            DriverEvent::Notice { level, text, data } => {
                self.emit(thread_id, turn_id, EventPayload::ProviderNotice { level, text, data })?;
            }
            DriverEvent::Exited { code, error } => {
                if let Some(error) = error.filter(|_| !live.is_released()) {
                    self.emit(
                        thread_id,
                        turn_id,
                        EventPayload::ProviderNotice {
                            level: NoticeLevel::Error,
                            text: format!("provider exited{}: {error}", code.map(|c| format!(" with code {c}")).unwrap_or_default()),
                            data: None,
                        },
                    )?;
                }
            }
        }
        Ok(())
    }
}

fn reject_app_tool_request(live: Arc<LiveSession>, request_id: String, reason: &'static str) {
    tokio::spawn(async move {
        let _ = tokio::time::timeout(Duration::from_secs(2), live.session.respond_app_tool(&request_id, Err(reason.to_string()))).await;
    });
}

fn bounded_app_tool_error(mut error: String) -> String {
    const MAX_ERROR_BYTES: usize = 4096;
    if error.len() > MAX_ERROR_BYTES {
        let mut end = MAX_ERROR_BYTES;
        while !error.is_char_boundary(end) {
            end -= 1;
        }
        error.truncate(end);
    }
    error
}

fn map_message_delta(turn: &mut Option<ActiveTurn>, origin: &EventOrigin, provider_id: &str) -> MessageId {
    let Some(turn) = turn.as_mut() else { return Uuid::now_v7() };
    if let Some(active) = turn.active_messages.get(origin).copied() {
        turn.messages.insert((origin.clone(), provider_id.to_string()), active);
        return active;
    }

    // A new delta after completion opens a fresh logical message, even if the
    // provider reused a raw id from an earlier message.
    let id = Uuid::now_v7();
    turn.messages.insert((origin.clone(), provider_id.to_string()), id);
    turn.active_messages.insert(origin.clone(), id);
    id
}

fn map_message_completion(turn: &mut Option<ActiveTurn>, origin: &EventOrigin, provider_id: &str) -> MessageId {
    let Some(turn) = turn.as_mut() else { return Uuid::now_v7() };
    let key = (origin.clone(), provider_id.to_string());
    let id = turn.active_messages.remove(origin).or_else(|| turn.messages.get(&key).copied()).unwrap_or_else(Uuid::now_v7);
    turn.messages.insert(key, id);
    id
}

fn merge_task_stats(current: &mut RuntimeTaskStats, update: RuntimeTaskStats) {
    if update.token_count.is_some() {
        current.token_count = update.token_count;
    }
    if update.tool_uses.is_some() {
        current.tool_uses = update.tool_uses;
    }
    if update.duration_ms.is_some() {
        current.duration_ms = update.duration_ms;
    }
    if update.cpu_percent.is_some() {
        current.cpu_percent = update.cpu_percent;
    }
    if update.rss_kb.is_some() {
        current.rss_kb = update.rss_kb;
    }
}

fn generic_runtime_task(call: &ToolCall) -> Option<DriverRuntimeTask> {
    let normalized = call.name.chars().filter(|char| char.is_ascii_alphanumeric()).flat_map(char::to_lowercase).collect::<String>();
    let title_hint = json_text(&call.input, &["title"]).unwrap_or_default();
    let normalized_title = title_hint.chars().filter(|char| char.is_ascii_alphanumeric()).flat_map(char::to_lowercase).collect::<String>();
    let explicit_background = json_bool(&call.input, &["background", "run_in_background", "runInBackground", "detach", "detached"])
        || json_false(&call.input, &["blocking"]);
    let agent_tool = matches!(
        normalized.as_str(),
        "task" | "agent" | "spawnagent" | "subagent" | "delegate" | "delegation" | "launchagent" | "callagent" | "runagent"
    ) || normalized.contains("subagent")
        || normalized.ends_with("spawnagent");
    let ambiguous_agent_tool = matches!(normalized.as_str(), "other" | "tool")
        && ["task", "agent", "subagent", "delegate", "spawnagent"].iter().any(|prefix| normalized_title.starts_with(prefix));
    let kind = if agent_tool || ambiguous_agent_tool {
        RuntimeTaskKind::Agent
    } else if matches!(normalized.as_str(), "monitor" | "monitortask" | "monitormcp") {
        RuntimeTaskKind::Monitor
    } else if explicit_background
        && matches!(normalized.as_str(), "bash" | "shell" | "execute" | "exec" | "command" | "runcommand" | "terminal")
    {
        RuntimeTaskKind::Process
    } else {
        return None;
    };
    let title = json_text(&call.input, &["description", "title", "prompt", "command", "task"])
        .map(|text| text.lines().next().unwrap_or(&text).chars().take(120).collect())
        .unwrap_or_else(|| match kind {
            RuntimeTaskKind::Agent => "Subagent".into(),
            RuntimeTaskKind::Process => "Background process".into(),
            RuntimeTaskKind::Monitor => "Monitor".into(),
        });
    Some(DriverRuntimeTask {
        id: format!("tool:{}", call.id),
        kind,
        status: RuntimeTaskStatus::Running,
        title,
        detail: None,
        provider_type: Some(call.name.clone()),
        parent_id: call.parent_id.clone(),
        tool_call_id: Some(call.id.clone()),
        provider_thread_id: None,
        model: None,
        effort: None,
        backgrounded: explicit_background,
        last_tool_name: None,
        usage: None,
        stats: RuntimeTaskStats::default(),
        capabilities: RuntimeTaskCapabilities::default(),
    })
}

fn generic_runtime_task_for_provider(provider: ProviderKind, call: &ToolCall) -> Option<DriverRuntimeTask> {
    let task = generic_runtime_task(call)?;
    match provider {
        // These harnesses expose first-class lifecycle channels. Mixing a
        // guessed tool row with the native identity duplicates batched/nested
        // children and can finish them at the wrong edge.
        ProviderKind::ClaudeCode | ProviderKind::Codex | ProviderKind::Omp => None,
        ProviderKind::Opencode if task.kind == RuntimeTaskKind::Agent => None,
        // pi and Cursor currently expose only tool-scoped observation through
        // the protocols Kybern drives. OpenCode still uses the conservative
        // path for background process/monitor tools.
        ProviderKind::Opencode | ProviderKind::Pi | ProviderKind::Cursor => Some(task),
    }
}

fn json_bool(value: &serde_json::Value, keys: &[&str]) -> bool {
    keys.iter().any(|key| value.get(*key).and_then(serde_json::Value::as_bool) == Some(true))
        || ["raw", "args", "input"].iter().any(|key| value.get(*key).is_some_and(|nested| json_bool(nested, keys)))
}

fn json_false(value: &serde_json::Value, keys: &[&str]) -> bool {
    keys.iter().any(|key| value.get(*key).and_then(serde_json::Value::as_bool) == Some(false))
        || ["raw", "args", "input"].iter().any(|key| value.get(*key).is_some_and(|nested| json_false(nested, keys)))
}

fn json_text(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(serde_json::Value::as_str).map(str::to_string))
        .or_else(|| ["raw", "args", "input"].iter().find_map(|key| value.get(*key).and_then(|nested| json_text(nested, keys))))
}

fn output_indicates_running(output: &serde_json::Value) -> bool {
    if let Some(object) = output.as_object() {
        if json_bool(output, &["background", "backgrounded", "running", "is_running"]) {
            return true;
        }
        if object
            .get("status")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|status| matches!(status, "running" | "in_progress" | "backgrounded" | "pending"))
        {
            return true;
        }
    }
    output
        .as_str()
        .map(str::to_ascii_lowercase)
        .is_some_and(|text| text.contains("running in background") || text.contains("background task") || text.contains("process id"))
}

fn clean_title(text: &str) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let line = line.trim_matches(|c: char| c == '"' || c == '\'' || c == '*' || c == '#' || c == '`').trim_end_matches('.').trim();
    let title: String = line.chars().take(80).collect();
    if title.split_whitespace().count() > 12 { String::new() } else { title }
}

pub fn title_from_message(message: &UserMessage) -> String {
    let text = message.plain_text();
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    if line.is_empty() {
        return DEFAULT_TITLE.to_string();
    }
    let mut title: String = line.chars().take(60).collect();
    if line.chars().count() > 60 {
        title.push('…');
    }
    title
}

fn is_compact_message(message: &UserMessage) -> bool {
    matches!(message.parts.as_slice(), [kybern_protocol::ContentPart::Text { text }] if text.trim() == "/compact")
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::{Duration, Instant, SystemTime};

    use super::{
        ActiveTurn, LiveSession, Orchestrator, SessionActivityTime, generic_runtime_task, generic_runtime_task_for_provider,
        output_indicates_running,
    };
    use crate::config::Paths;
    use crate::settings::SettingsStore;
    use kybern_drivers::registry::DriverRegistry;
    use kybern_drivers::{AgentSession, DriverEvent, DriverRuntimeTask, DriverRuntimeTaskUpdate, TurnAnchors};
    use kybern_protocol::*;
    use kybern_store::Store;
    use serde_json::json;
    use tokio::sync::{Mutex, Semaphore};
    use uuid::Uuid;

    type AppToolResponse = (String, std::result::Result<serde_json::Value, String>);
    type CapturedAppToolResponses = Arc<Mutex<Vec<AppToolResponse>>>;

    #[derive(Default)]
    struct TestSession {
        closes: Arc<AtomicUsize>,
        messages: Arc<Mutex<Vec<UserMessage>>>,
        app_tool_responses: CapturedAppToolResponses,
        hang_interrupt: bool,
        broken_interrupt: bool,
    }

    #[async_trait::async_trait]
    impl AgentSession for TestSession {
        async fn send_message(&self, _message_id: &str, message: &UserMessage) -> kybern_drivers::Result<()> {
            self.messages.lock().await.push(message.clone());
            Ok(())
        }

        async fn steer(&self, _message_id: &str, message: &UserMessage) -> kybern_drivers::Result<()> {
            self.messages.lock().await.push(message.clone());
            Ok(())
        }

        async fn interrupt(&self) -> kybern_drivers::Result<()> {
            if self.broken_interrupt {
                return Err(std::io::Error::from(std::io::ErrorKind::BrokenPipe).into());
            }
            if self.hang_interrupt {
                std::future::pending::<()>().await;
            }
            Ok(())
        }

        async fn set_permission_mode(&self, _mode: PermissionMode) -> kybern_drivers::Result<()> {
            Ok(())
        }

        async fn set_model(&self, _model: &str) -> kybern_drivers::Result<()> {
            Ok(())
        }

        async fn set_effort(&self, _effort: &str) -> kybern_drivers::Result<()> {
            Ok(())
        }

        async fn respond_permission(&self, _request_id: &str, _decision: &ApprovalDecision) -> kybern_drivers::Result<()> {
            Ok(())
        }

        async fn respond_app_tool(
            &self,
            request_id: &str,
            result: std::result::Result<serde_json::Value, String>,
        ) -> kybern_drivers::Result<()> {
            self.app_tool_responses.lock().await.push((request_id.to_string(), result));
            Ok(())
        }

        async fn close(&self) -> kybern_drivers::Result<()> {
            self.closes.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    #[test]
    fn classifies_native_and_acp_style_subagent_tools() {
        let native = generic_runtime_task(&ToolCall {
            id: "one".into(),
            name: "spawn_agent".into(),
            input: json!({ "description": "Audit the protocol" }),
            parent_id: None,
        })
        .unwrap();
        assert_eq!(native.kind, RuntimeTaskKind::Agent);
        assert_eq!(native.title, "Audit the protocol");

        let acp = generic_runtime_task(&ToolCall {
            id: "two".into(),
            name: "other".into(),
            input: json!({ "title": "Task: inspect tests", "raw": {} }),
            parent_id: None,
        })
        .unwrap();
        assert_eq!(acp.kind, RuntimeTaskKind::Agent);
        assert_eq!(acp.title, "Task: inspect tests");
    }

    #[test]
    fn requires_an_explicit_background_signal_for_generic_shells() {
        let foreground = ToolCall { id: "one".into(), name: "shell".into(), input: json!({ "command": "cargo test" }), parent_id: None };
        assert!(generic_runtime_task(&foreground).is_none());

        let background = generic_runtime_task(&ToolCall {
            id: "two".into(),
            name: "execute".into(),
            input: json!({ "title": "Run dev server", "raw": { "blocking": false } }),
            parent_id: None,
        })
        .unwrap();
        assert_eq!(background.kind, RuntimeTaskKind::Process);
        assert!(background.backgrounded);
        assert!(!background.capabilities.stop);
    }

    #[tokio::test]
    async fn add_project_self_heals_is_git_after_a_later_git_init() {
        let root = std::env::temp_dir().join(format!("kybern-isgit-test-{}", Uuid::now_v7()));
        std::fs::create_dir_all(&root).unwrap();
        let paths = Paths::resolve(Some(root.join(".kyb"))).unwrap();
        let settings = SettingsStore::load(&paths.settings).unwrap();
        let store = Store::open_in_memory().unwrap();
        let (events_tx, _) = crate::bounded_broadcast::channel(32, 8 * 1024 * 1024);
        let orchestrator = Orchestrator::new(store.clone(), DriverRegistry::default(), events_tx, paths, settings);

        let workspace = root.join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let path = workspace.to_string_lossy().into_owned();

        // Registered before `git init`: the cached flag is false.
        let first = orchestrator.add_project(path.clone(), None).unwrap();
        assert!(!first.is_git, "fixture folder has no .git yet");

        // The user runs `git init` afterwards.
        std::fs::create_dir_all(workspace.join(".git")).unwrap();

        // Re-adding the same path re-probes, flips the flag, and persists it, so
        // edit/integration spawns are no longer permanently blocked (issue #26).
        let healed = orchestrator.add_project(path.clone(), None).unwrap();
        assert_eq!(healed.id, first.id, "same project record, not a duplicate");
        assert!(healed.is_git, "cached is_git self-heals to true");
        let stored = store.project_get(first.id).unwrap().unwrap();
        assert!(stored.is_git, "corrected flag is persisted to the store");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn recognizes_detached_results_without_claiming_native_lifecycle() {
        assert!(output_indicates_running(&json!({ "status": "in_progress" })));
        assert!(output_indicates_running(&json!("Process ID 42 is running in background")));
        assert!(!output_indicates_running(&json!({ "status": "completed" })));
    }

    #[test]
    fn runtime_fallback_matrix_preserves_native_harness_channels() {
        let agent =
            ToolCall { id: "agent-1".into(), name: "task".into(), input: json!({ "description": "Inspect parity" }), parent_id: None };

        assert!(generic_runtime_task_for_provider(ProviderKind::ClaudeCode, &agent).is_none());
        assert!(generic_runtime_task_for_provider(ProviderKind::Codex, &agent).is_none());
        assert!(generic_runtime_task_for_provider(ProviderKind::Opencode, &agent).is_none());
        assert!(generic_runtime_task_for_provider(ProviderKind::Omp, &agent).is_none());
        assert!(generic_runtime_task_for_provider(ProviderKind::Pi, &agent).is_some());
        assert!(generic_runtime_task_for_provider(ProviderKind::Cursor, &agent).is_some());
    }

    #[tokio::test]
    async fn claude_result_waits_for_background_agents_and_scopes_the_continuation() {
        assert_claude_background_continuation(RuntimeTaskKind::Agent).await;
    }

    #[tokio::test]
    async fn claude_result_waits_for_background_processes_and_scopes_the_continuation() {
        assert_claude_background_continuation(RuntimeTaskKind::Process).await;
    }

    #[tokio::test]
    async fn claude_monitor_resumes_without_holding_the_foreground_open() {
        assert_claude_background_continuation(RuntimeTaskKind::Monitor).await;
    }

    async fn assert_claude_background_continuation(kind: RuntimeTaskKind) {
        let root = std::env::temp_dir().join(format!("kybern-orchestrator-test-{}", Uuid::now_v7()));
        let paths = Paths::resolve(Some(root.clone())).unwrap();
        let settings = SettingsStore::load(&paths.settings).unwrap();
        let store = Store::open_in_memory().unwrap();
        let now = chrono::Utc::now();
        let project = Project {
            id: Uuid::now_v7(),
            name: "fixture".into(),
            path: root.to_string_lossy().into_owned(),
            is_git: false,
            worktrees_default: None,
            created_at: now,
            updated_at: now,
        };
        store.project_insert(&project).unwrap();
        let thread = Thread {
            id: Uuid::now_v7(),
            project_id: project.id,
            title: "Fixture".into(),
            provider: ProviderInstance::default_for(ProviderKind::ClaudeCode),
            model: None,
            effort: None,
            permission_mode: PermissionMode::Supervised,
            status: ThreadStatus::Running,
            worktree: None,
            cwd: project.path.clone(),
            provider_session_id: None,
            pinned: false,
            created_at: now,
            updated_at: now,
            last_seq: 0,
            parent_thread_id: None,
            coordinator_project_id: None,
            collaboration_group_id: None,
        };
        store.thread_upsert(&thread).unwrap();
        let (events_tx, _) = crate::bounded_broadcast::channel(32, 8 * 1024 * 1024);
        let orchestrator = Orchestrator::new(store.clone(), DriverRegistry::default(), events_tx, paths, settings);
        let turn_id = Uuid::now_v7();
        orchestrator
            .emit(thread.id, Some(turn_id), EventPayload::TurnStarted { message_id: Uuid::now_v7(), message: UserMessage::text("test") })
            .unwrap();
        let task = RuntimeTask {
            id: "agent-1".into(),
            thread_id: thread.id,
            origin_turn_id: turn_id,
            started_seq: 2,
            updated_seq: 2,
            kind,
            status: RuntimeTaskStatus::Running,
            title: "Explore".into(),
            detail: None,
            provider_type: Some("local_agent".into()),
            parent_id: None,
            tool_call_id: None,
            provider_thread_id: None,
            model: None,
            effort: None,
            backgrounded: true,
            last_tool_name: None,
            usage: None,
            stats: RuntimeTaskStats::default(),
            capabilities: RuntimeTaskCapabilities::default(),
            started_at: now,
            updated_at: now,
            completed_at: None,
        };
        let live = Arc::new(LiveSession {
            session_instance_id: Uuid::now_v7(),
            session: Box::new(TestSession::default()),
            last_activity: std::sync::Mutex::new(SessionActivityTime::now()),
            released: AtomicBool::new(false),
            stop_cleanup: AtomicBool::new(false),
            turn: Mutex::new(Some(ActiveTurn {
                response_id: Uuid::now_v7(),
                id: turn_id,
                started: std::time::Instant::now(),
                startup_started: std::time::Instant::now(),
                provider: ProviderKind::ClaudeCode,
                session_reused: false,
                first_event_observed: false,
                messages: HashMap::new(),
                active_messages: HashMap::new(),
                terminal_message_id: None,
                completed: false,
                pending_completion: None,
            })),
            continuation: Mutex::new(None),
            turn_ready: tokio::sync::Notify::new(),
            last_turn_id: Mutex::new(Some(turn_id)),
            tasks: Mutex::new(HashMap::from([(task.id.clone(), task)])),
            deferred_checkpoints: Mutex::new(HashSet::new()),
            pending: Mutex::new(HashMap::new()),
            app_tool_requests: Mutex::new(HashSet::new()),
            app_tool_permits: Arc::new(Semaphore::new(crate::app_tools::MAX_CONCURRENT_REQUESTS)),
        });
        orchestrator
            .handle_driver_event(
                thread.id,
                &live,
                DriverEvent::TextDelta { message_id: "provider-holding".into(), origin: EventOrigin::Root, delta: "Holding.".into() },
            )
            .await
            .unwrap();
        orchestrator
            .handle_driver_event(
                thread.id,
                &live,
                DriverEvent::MessageCompleted {
                    message_id: "provider-holding".into(),
                    origin: EventOrigin::Root,
                    text: "Holding.".into(),
                    thinking: None,
                },
            )
            .await
            .unwrap();
        let first_usage = Usage { input_tokens: 1, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0 };
        orchestrator
            .handle_driver_event(
                thread.id,
                &live,
                DriverEvent::TurnCompleted {
                    stop_reason: StopReason::Completed,
                    usage: first_usage,
                    cost_usd: Some(0.1),
                    duration_ms: 5,
                    anchors: TurnAnchors::default(),
                },
            )
            .await
            .unwrap();
        if kind != RuntimeTaskKind::Monitor {
            assert!(live.turn.lock().await.as_ref().is_some_and(|turn| turn.pending_completion.is_some()));
            assert!(
                !store
                    .events_for_thread(thread.id)
                    .unwrap()
                    .iter()
                    .any(|event| matches!(event.payload, EventPayload::TurnCompleted { .. }))
            );
        } else {
            assert!(live.turn.lock().await.is_none(), "monitors may outlive the foreground request");
            assert_eq!(store.thread_get(thread.id).unwrap().unwrap().status, ThreadStatus::Idle);
        }

        orchestrator
            .handle_driver_event(
                thread.id,
                &live,
                DriverEvent::RuntimeTaskCompleted(DriverRuntimeTaskUpdate::status("agent-1", RuntimeTaskStatus::Completed)),
            )
            .await
            .unwrap();
        if kind != RuntimeTaskKind::Monitor {
            // A notification can start another wave of work. Each provisional
            // result must keep the same parent busy without emitting an alert.
            for wave in 2..=3 {
                orchestrator.handle_driver_event(thread.id, &live, DriverEvent::ResponseStarted).await.unwrap();
                let task = DriverRuntimeTask {
                    id: format!("task-{wave}"),
                    kind,
                    status: RuntimeTaskStatus::Running,
                    title: "Follow-up work".into(),
                    detail: None,
                    provider_type: None,
                    parent_id: None,
                    tool_call_id: None,
                    provider_thread_id: None,
                    model: None,
                    effort: None,
                    backgrounded: true,
                    last_tool_name: None,
                    usage: None,
                    stats: RuntimeTaskStats::default(),
                    capabilities: RuntimeTaskCapabilities::default(),
                };
                orchestrator.handle_driver_event(thread.id, &live, DriverEvent::RuntimeTaskStarted(task)).await.unwrap();
                orchestrator
                    .handle_driver_event(
                        thread.id,
                        &live,
                        DriverEvent::TurnCompleted {
                            stop_reason: StopReason::Completed,
                            usage: Usage::default(),
                            cost_usd: None,
                            duration_ms: 1,
                            anchors: TurnAnchors::default(),
                        },
                    )
                    .await
                    .unwrap();
                orchestrator
                    .handle_driver_event(
                        thread.id,
                        &live,
                        DriverEvent::RuntimeTaskCompleted(DriverRuntimeTaskUpdate::status(
                            format!("task-{wave}"),
                            RuntimeTaskStatus::Completed,
                        )),
                    )
                    .await
                    .unwrap();
                assert_eq!(store.thread_get(thread.id).unwrap().unwrap().status, ThreadStatus::Running);
                assert!(
                    !store
                        .events_for_thread(thread.id)
                        .unwrap()
                        .iter()
                        .any(|event| matches!(event.payload, EventPayload::TurnCompleted { .. }))
                );
            }
        }
        orchestrator.handle_driver_event(thread.id, &live, DriverEvent::ResponseStarted).await.unwrap();
        assert_eq!(store.thread_get(thread.id).unwrap().unwrap().status, ThreadStatus::Running);
        assert!(!orchestrator.session_parked(thread.id, &live).await.unwrap());
        let resumed =
            store.events_for_thread(thread.id).unwrap().iter().filter(|event| matches!(event.payload, EventPayload::TurnResumed)).count();
        assert_eq!(resumed, usize::from(kind == RuntimeTaskKind::Monitor));
        assert!(
            orchestrator.send(thread.id, UserMessage::text("continue?")).await.is_err(),
            "manual input must not replace a running continuation"
        );
        let queued =
            methods::QueuedMessage { id: Uuid::now_v7(), thread_id: thread.id, message: UserMessage::text("after the continuation") };
        orchestrator.enqueue(queued.clone()).unwrap();
        assert!(orchestrator.drain_queues().await.unwrap());
        assert_eq!(store.queue_list(None).unwrap().len(), 1);
        orchestrator.remove_queued(thread.id, queued.id).unwrap();
        orchestrator
            .handle_driver_event(
                thread.id,
                &live,
                DriverEvent::TextDelta { message_id: "provider-fragment-1".into(), origin: EventOrigin::Root, delta: "Final ".into() },
            )
            .await
            .unwrap();
        orchestrator
            .handle_driver_event(
                thread.id,
                &live,
                DriverEvent::TextDelta { message_id: "provider-fragment-2".into(), origin: EventOrigin::Root, delta: "answer".into() },
            )
            .await
            .unwrap();
        orchestrator
            .handle_driver_event(
                thread.id,
                &live,
                DriverEvent::MessageCompleted {
                    message_id: "provider-completion".into(),
                    origin: EventOrigin::Root,
                    text: "Final answer".into(),
                    thinking: None,
                },
            )
            .await
            .unwrap();
        orchestrator
            .handle_driver_event(
                thread.id,
                &live,
                DriverEvent::TurnCompleted {
                    stop_reason: StopReason::Completed,
                    usage: Usage { input_tokens: 3, output_tokens: 4, cache_read_tokens: 0, cache_write_tokens: 0 },
                    cost_usd: Some(0.2),
                    duration_ms: 7,
                    anchors: TurnAnchors::default(),
                },
            )
            .await
            .unwrap();

        let events = store.events_for_thread(thread.id).unwrap();
        let response_events = events
            .iter()
            .filter(|event| {
                matches!(event.payload, EventPayload::AssistantTextDelta { .. } | EventPayload::AssistantMessageCompleted { .. })
            })
            .collect::<Vec<_>>();
        assert_eq!(response_events.len(), 5);
        assert!(response_events.iter().all(|event| event.turn_id == Some(turn_id)));
        let message_ids = response_events
            .iter()
            .filter_map(|event| match event.payload {
                EventPayload::AssistantTextDelta { message_id, .. } | EventPayload::AssistantMessageCompleted { message_id, .. } => {
                    Some(message_id)
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(message_ids[0], message_ids[1]);
        assert!(message_ids[2..].windows(2).all(|pair| pair[0] == pair[1]));
        assert_ne!(message_ids[1], message_ids[2]);
        let completed = events
            .iter()
            .filter_map(|event| match &event.payload {
                EventPayload::TurnCompleted { usage, cost_usd, terminal_message_id, .. } => Some((usage, cost_usd, terminal_message_id)),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(completed.len(), if kind != RuntimeTaskKind::Monitor { 1 } else { 2 });
        let completed = &completed[completed.len() - 1..];
        assert_eq!(completed[0].0.input_tokens, 4);
        assert_eq!(completed[0].0.output_tokens, 6);
        assert!((completed[0].1.unwrap_or_default() - 0.3).abs() < f64::EPSILON);
        assert_eq!(*completed[0].2, Some(message_ids[2]));
        assert!(live.turn.lock().await.is_none());
        let projected = kybern_store::project_transcript(&events);
        assert_eq!(projected.iter().filter(|entry| matches!(entry, TranscriptEntry::TurnSummary { .. })).count(), 1);
        assert_eq!(projected.iter().filter(|entry| matches!(entry, TranscriptEntry::User { .. })).count(), 1);
        assert_eq!(store.thread_get(thread.id).unwrap().unwrap().status, ThreadStatus::Idle);

        orchestrator.inner.sessions.lock().await.insert(thread.id, live.clone());
        let follow_up = methods::QueuedMessage { id: Uuid::now_v7(), thread_id: thread.id, message: UserMessage::text("next") };
        orchestrator.enqueue(follow_up.clone()).unwrap();
        orchestrator.drain_queues().await.unwrap();
        assert!(store.queue_list(None).unwrap().is_empty());
        assert!(
            store
                .events_for_thread(thread.id)
                .unwrap()
                .iter()
                .any(|event| matches!(event.payload, EventPayload::TurnStarted { message_id, .. } if message_id == follow_up.id))
        );
        let pending = methods::QueuedMessage { id: Uuid::now_v7(), ..follow_up };
        orchestrator.enqueue(pending).unwrap();
        let mut late_completion = store.thread_get(thread.id).unwrap().unwrap();
        orchestrator.archive_thread(thread.id).await.unwrap();
        late_completion.status = ThreadStatus::Idle;
        orchestrator.update_thread(late_completion).unwrap();
        orchestrator.drain_queues().await.unwrap();
        assert_eq!(store.thread_get(thread.id).unwrap().unwrap().status, ThreadStatus::Archived);
        assert!(store.queue_list(None).unwrap().is_empty());
        orchestrator.shutdown().await;

        std::fs::remove_dir_all(root).unwrap();
    }

    struct Fixture {
        root: std::path::PathBuf,
        store: Store,
        orchestrator: Orchestrator,
        project: Project,
    }

    impl Fixture {
        fn new() -> Self {
            Self::with_drivers(DriverRegistry::default())
        }

        fn with_drivers(drivers: DriverRegistry) -> Self {
            let root = std::env::temp_dir().join(format!("kybern-orchestrator-test-{}", Uuid::now_v7()));
            let paths = Paths::resolve(Some(root.clone())).unwrap();
            let settings = SettingsStore::load(&paths.settings).unwrap();
            let store = Store::open_in_memory().unwrap();
            let now = chrono::Utc::now();
            let project = Project {
                id: Uuid::now_v7(),
                name: "fixture".into(),
                path: root.to_string_lossy().into_owned(),
                is_git: false,
                worktrees_default: None,
                created_at: now,
                updated_at: now,
            };
            store.project_insert(&project).unwrap();
            let (events_tx, _) = crate::bounded_broadcast::channel(64, 8 * 1024 * 1024);
            let orchestrator = Orchestrator::new(store.clone(), drivers, events_tx, paths, settings);
            Self { root, store, orchestrator, project }
        }

        fn thread(&self, status: ThreadStatus) -> Thread {
            self.thread_with_provider(status, ProviderKind::ClaudeCode)
        }

        fn thread_with_provider(&self, status: ThreadStatus, provider: ProviderKind) -> Thread {
            let now = chrono::Utc::now();
            let thread = Thread {
                id: Uuid::now_v7(),
                project_id: self.project.id,
                title: "Fixture".into(),
                provider: ProviderInstance::default_for(provider),
                model: None,
                effort: None,
                permission_mode: PermissionMode::Supervised,
                status,
                worktree: None,
                cwd: self.project.path.clone(),
                provider_session_id: Some("provider-session".into()),
                pinned: false,
                created_at: now,
                updated_at: now,
                last_seq: 0,
                parent_thread_id: None,
                coordinator_project_id: None,
                collaboration_group_id: None,
            };
            self.store.thread_upsert(&thread).unwrap();
            thread
        }

        /// Attach a parked session whose last activity was `last_activity`.
        async fn park(&self, thread: &Thread, last_activity: Instant) -> (Arc<LiveSession>, Arc<AtomicUsize>) {
            let (live, closes, _) = self.park_recording(thread, last_activity).await;
            (live, closes)
        }

        async fn park_recording(
            &self,
            thread: &Thread,
            last_activity: Instant,
        ) -> (Arc<LiveSession>, Arc<AtomicUsize>, Arc<Mutex<Vec<UserMessage>>>) {
            let closes = Arc::new(AtomicUsize::new(0));
            let messages = Arc::new(Mutex::new(Vec::new()));
            let live = Arc::new(LiveSession {
                session_instance_id: Uuid::now_v7(),
                session: Box::new(TestSession { closes: closes.clone(), messages: messages.clone(), ..Default::default() }),
                last_activity: std::sync::Mutex::new(SessionActivityTime { monotonic: last_activity, wall: SystemTime::now() }),
                released: AtomicBool::new(false),
                stop_cleanup: AtomicBool::new(false),
                turn: Mutex::new(None),
                continuation: Mutex::new(None),
                turn_ready: tokio::sync::Notify::new(),
                last_turn_id: Mutex::new(None),
                tasks: Mutex::new(HashMap::new()),
                deferred_checkpoints: Mutex::new(HashSet::new()),
                pending: Mutex::new(HashMap::new()),
                app_tool_requests: Mutex::new(HashSet::new()),
                app_tool_permits: Arc::new(Semaphore::new(crate::app_tools::MAX_CONCURRENT_REQUESTS)),
            });
            self.orchestrator.inner.sessions.lock().await.insert(thread.id, live.clone());
            (live, closes, messages)
        }

        async fn active_app_tool_session(&self, thread: &Thread) -> (Arc<LiveSession>, CapturedAppToolResponses) {
            let responses = Arc::new(Mutex::new(Vec::new()));
            let live = Arc::new(LiveSession {
                session_instance_id: Uuid::now_v7(),
                session: Box::new(TestSession { app_tool_responses: responses.clone(), ..Default::default() }),
                last_activity: std::sync::Mutex::new(SessionActivityTime::now()),
                released: AtomicBool::new(false),
                stop_cleanup: AtomicBool::new(false),
                turn: Mutex::new(None),
                continuation: Mutex::new(None),
                turn_ready: tokio::sync::Notify::new(),
                last_turn_id: Mutex::new(None),
                tasks: Mutex::new(HashMap::new()),
                deferred_checkpoints: Mutex::new(HashSet::new()),
                pending: Mutex::new(HashMap::new()),
                app_tool_requests: Mutex::new(HashSet::new()),
                app_tool_permits: Arc::new(Semaphore::new(crate::app_tools::MAX_CONCURRENT_REQUESTS)),
            });
            self.orchestrator.inner.sessions.lock().await.insert(thread.id, live.clone());
            self.orchestrator.send(thread.id, UserMessage::text("inspect workspace")).await.unwrap();
            live.turn_ready.notified().await;
            (live, responses)
        }

        async fn has_session(&self, thread: &Thread) -> bool {
            self.orchestrator.inner.sessions.lock().await.contains_key(&thread.id)
        }

        fn release_events(&self, thread: &Thread) -> Vec<SessionReleaseReason> {
            self.store
                .events_for_thread(thread.id)
                .unwrap()
                .iter()
                .filter_map(|event| match event.payload {
                    EventPayload::ProviderSessionReleased { reason } => Some(reason),
                    _ => None,
                })
                .collect()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn completed_response(stop_reason: StopReason) -> DriverEvent {
        DriverEvent::TurnCompleted {
            stop_reason,
            usage: Usage::default(),
            cost_usd: Some(0.0),
            duration_ms: 1,
            anchors: TurnAnchors::default(),
        }
    }

    #[tokio::test]
    async fn dedicated_coordinator_cannot_bypass_catalog_restrictions_with_a_raw_tool_call() {
        let fixture = Fixture::new();
        let thread = fixture.thread(ThreadStatus::Idle);
        fixture
            .orchestrator
            .collaboration_group_create(methods::CollaborationGroupsCreateParams {
                operation_id: Uuid::now_v7(),
                project_id: thread.project_id,
                coordinator_thread_id: thread.id,
                objective: "Delegate research".into(),
                success_criteria: vec![],
                coordinator_mode: Some(CoordinatorMode::Dedicated),
                policy: None,
            })
            .unwrap();
        let (live, _) = fixture.active_app_tool_session(&thread).await;
        let error = fixture
            .orchestrator
            .execute_native_app_tool_call(
                thread.id,
                live.session_instance_id,
                "denied-read",
                "kybern_read_terminal",
                json!({"terminal_id":Uuid::now_v7()}),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("Delegate the task to a worker"));
        std::fs::write(fixture.root.join("review.txt"), "worker evidence").unwrap();
        fixture
            .orchestrator
            .execute_native_app_tool_call(
                thread.id,
                live.session_instance_id,
                "allowed-source-read",
                "kybern_read_file",
                json!({"path":"review.txt"}),
            )
            .await
            .unwrap();
        fixture
            .orchestrator
            .execute_native_app_tool_call(thread.id, live.session_instance_id, "allowed-context", "kybern_thread_context", json!({}))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn collaboration_read_consumes_only_returned_inbox_for_every_harness() {
        for provider in [
            ProviderKind::Codex,
            ProviderKind::ClaudeCode,
            ProviderKind::Opencode,
            ProviderKind::Pi,
            ProviderKind::Omp,
            ProviderKind::Cursor,
        ] {
            for coordinator in [false, true] {
                let fixture = Fixture::new();
                let mut thread = fixture.thread_with_provider(ThreadStatus::Idle, provider);
                let group = fixture
                    .orchestrator
                    .collaboration_group_create(methods::CollaborationGroupsCreateParams {
                        operation_id: Uuid::now_v7(),
                        project_id: thread.project_id,
                        coordinator_thread_id: thread.id,
                        objective: "Read helper results".into(),
                        success_criteria: vec![],
                        coordinator_mode: Some(if coordinator && !matches!(provider, ProviderKind::Codex | ProviderKind::Cursor) {
                            CoordinatorMode::Dedicated
                        } else {
                            CoordinatorMode::Ordinary
                        }),
                        policy: None,
                    })
                    .unwrap();
                if coordinator {
                    thread.coordinator_project_id = Some(thread.project_id);
                    thread.collaboration_group_id = Some(group.id);
                    fixture.store.thread_upsert(&thread).unwrap();
                }
                let peer = fixture.thread_with_provider(ThreadStatus::Idle, provider);
                // Fill the bounded read snapshot and leave a later message outside it.
                let mut messages = Vec::new();
                for i in 0..102 {
                    let now = chrono::Utc::now();
                    let message = CollaborationMessage {
                        id: Uuid::now_v7(),
                        operation_id: Uuid::now_v7(),
                        group_id: group.id,
                        assignment_id: None,
                        from_thread_id: Some(peer.id),
                        to_thread_id: if i == 0 { peer.id } else { thread.id },
                        external_recipient: false,
                        purpose: CollaborationMessagePurpose::Result,
                        reply_to: None,
                        body: format!("Result {i}"),
                        state: CollaborationDeliveryState::Queued,
                        delivery_turn_id: None,
                        wakeup_count: 1,
                        created_at: now,
                        updated_at: now,
                    };
                    fixture.store.collaboration_message_put(&message, Some(message.id)).unwrap();
                    fixture.store.collaboration_message_queue(&message).unwrap();
                    messages.push(message);
                }
                // Desktop/mobile inspection must never consume agent delivery.
                fixture.orchestrator.collaboration_group_detail(group.id).unwrap();
                assert!(fixture.store.queue_is_pending(messages[1].id).unwrap());
                let (live, _) = fixture.active_app_tool_session(&thread).await;
                let invalid = fixture
                    .orchestrator
                    .execute_native_app_tool_call(
                        thread.id,
                        live.session_instance_id,
                        "invalid-participant",
                        "kybern_collaboration_read",
                        json!({"thread_id":Uuid::now_v7()}),
                    )
                    .await;
                assert!(invalid.is_err());
                assert!(fixture.store.queue_is_pending(messages[1].id).unwrap(), "failed reads cannot consume delivery");
                let result = fixture
                    .orchestrator
                    .execute_native_app_tool_call(thread.id, live.session_instance_id, "read-inbox", "kybern_collaboration_read", json!({}))
                    .await
                    .unwrap();
                assert_eq!(result["pending_messages"].as_array().unwrap().len(), 100);
                assert!(fixture.store.queue_is_pending(messages[0].id).unwrap(), "other recipient");
                for message in &messages[1..=100] {
                    assert!(!fixture.store.queue_is_pending(message.id).unwrap(), "{provider:?}, coordinator={coordinator}");
                    let stored = fixture.store.collaboration_message_get(message.id).unwrap().unwrap();
                    assert_eq!(stored.state, CollaborationDeliveryState::Submitted);
                    assert!(stored.delivery_turn_id.is_some());
                }
                assert!(fixture.store.queue_is_pending(messages[101].id).unwrap(), "outside snapshot");
            }
        }
    }

    #[tokio::test]
    async fn collaboration_read_consumes_result_notification_omitted_by_message_pagination() {
        let fixture = Fixture::new();
        let thread = fixture.thread(ThreadStatus::Idle);
        let group = fixture
            .orchestrator
            .collaboration_group_create(methods::CollaborationGroupsCreateParams {
                operation_id: Uuid::now_v7(),
                project_id: thread.project_id,
                coordinator_thread_id: thread.id,
                objective: "Read a structured assignment result".into(),
                success_criteria: vec![],
                coordinator_mode: Some(CoordinatorMode::Ordinary),
                policy: None,
            })
            .unwrap();
        let worker = fixture.thread(ThreadStatus::Idle);
        fixture
            .store
            .collaboration_member_put(&GroupMember {
                group_id: group.id,
                thread_id: worker.id,
                role: GroupMemberRole::Worker,
                active: true,
                joined_at: chrono::Utc::now(),
            })
            .unwrap();
        let now = chrono::Utc::now();
        let assignment = CollaborationAssignment {
            id: Uuid::now_v7(),
            group_id: group.id,
            parent_assignment_id: None,
            owner_thread_id: Some(worker.id),
            requested_child: None,
            created_by_thread_id: Some(thread.id),
            title: "Finished work".into(),
            instructions: "Return one durable result".into(),
            kind: AssignmentKind::Research,
            status: AssignmentStatus::Completed,
            dispatch_message_id: None,
            base_revision: None,
            depth: 0,
            result: Some(AssignmentResult {
                outcome: AssignmentOutcome::Success,
                summary: "The structured result surfaced".into(),
                changes: Vec::new(),
                checks: Vec::new(),
                artifacts: Vec::new(),
                unresolved: Vec::new(),
                completed_at: now,
            }),
            uncertainty: None,
            revision: 2,
            created_at: now,
            updated_at: now,
        };
        fixture.store.collaboration_assignment_put(&assignment).unwrap();

        let mut unrelated = Vec::new();
        for index in 0..101 {
            let message = CollaborationMessage {
                id: Uuid::now_v7(),
                operation_id: Uuid::now_v7(),
                group_id: group.id,
                assignment_id: None,
                from_thread_id: Some(worker.id),
                to_thread_id: thread.id,
                external_recipient: false,
                purpose: CollaborationMessagePurpose::Question,
                reply_to: None,
                body: format!("unrelated question {index}"),
                state: CollaborationDeliveryState::Queued,
                delivery_turn_id: None,
                wakeup_count: 1,
                created_at: now,
                updated_at: now,
            };
            fixture.store.collaboration_message_put(&message, Some(message.id)).unwrap();
            fixture.store.collaboration_message_queue(&message).unwrap();
            unrelated.push(message);
        }
        let result_notification = CollaborationMessage {
            id: Uuid::now_v7(),
            operation_id: Uuid::now_v7(),
            group_id: group.id,
            assignment_id: Some(assignment.id),
            from_thread_id: Some(worker.id),
            to_thread_id: thread.id,
            external_recipient: false,
            purpose: CollaborationMessagePurpose::Result,
            reply_to: None,
            body: format!("Assignment {} finished with Success: The structured result surfaced", assignment.id),
            state: CollaborationDeliveryState::Queued,
            delivery_turn_id: None,
            wakeup_count: 1,
            created_at: now,
            updated_at: now,
        };
        fixture.store.collaboration_message_put(&result_notification, Some(result_notification.id)).unwrap();
        fixture.store.collaboration_message_queue(&result_notification).unwrap();
        let actionable = CollaborationMessage {
            id: Uuid::now_v7(),
            operation_id: Uuid::now_v7(),
            group_id: group.id,
            assignment_id: Some(assignment.id),
            from_thread_id: Some(worker.id),
            to_thread_id: thread.id,
            external_recipient: false,
            purpose: CollaborationMessagePurpose::ChangeRequest,
            reply_to: None,
            body: "Do not consume this actionable follow-up".into(),
            state: CollaborationDeliveryState::Queued,
            delivery_turn_id: None,
            wakeup_count: 1,
            created_at: now,
            updated_at: now,
        };
        fixture.store.collaboration_message_put(&actionable, Some(actionable.id)).unwrap();
        fixture.store.collaboration_message_queue(&actionable).unwrap();

        let fresh_result = CollaborationMessage {
            id: Uuid::now_v7(),
            operation_id: Uuid::now_v7(),
            purpose: CollaborationMessagePurpose::Result,
            body: "A new follow-up commit that is not in the old structured report".into(),
            ..actionable.clone()
        };
        fixture.store.collaboration_message_put(&fresh_result, Some(fresh_result.id)).unwrap();
        fixture.store.collaboration_message_queue(&fresh_result).unwrap();
        let (live, _) = fixture.active_app_tool_session(&thread).await;
        let value = fixture
            .orchestrator
            .execute_native_app_tool_call(
                thread.id,
                live.session_instance_id,
                "read-structured-result",
                "kybern_collaboration_read",
                json!({}),
            )
            .await
            .unwrap();
        assert_eq!(value["pending_messages"].as_array().unwrap().len(), 100);
        assert_eq!(value["assignments"][0]["result"]["summary"], "The structured result surfaced");
        assert!(!fixture.store.queue_is_pending(result_notification.id).unwrap(), "surfaced structured result consumes its wakeup");
        assert!(fixture.store.queue_is_pending(unrelated[100].id).unwrap(), "unrelated message outside the page stays queued");
        assert!(fixture.store.queue_is_pending(actionable.id).unwrap(), "actionable same-assignment follow-up stays queued");
        assert!(
            fixture.store.queue_is_pending(fresh_result.id).unwrap(),
            "an unseen follow-up result is not represented by an older report"
        );
    }

    #[tokio::test]
    async fn collaboration_read_scopes_recipient_before_bounding_and_consumes_own_result() {
        let fixture = Fixture::new();
        let thread = fixture.thread(ThreadStatus::Idle);
        let group = fixture
            .orchestrator
            .collaboration_group_create(methods::CollaborationGroupsCreateParams {
                operation_id: Uuid::now_v7(),
                project_id: thread.project_id,
                coordinator_thread_id: thread.id,
                objective: "Read a structured assignment result".into(),
                success_criteria: vec![],
                coordinator_mode: Some(CoordinatorMode::Ordinary),
                policy: None,
            })
            .unwrap();
        let worker = fixture.thread(ThreadStatus::Idle);
        fixture
            .store
            .collaboration_member_put(&GroupMember {
                group_id: group.id,
                thread_id: worker.id,
                role: GroupMemberRole::Worker,
                active: true,
                joined_at: chrono::Utc::now(),
            })
            .unwrap();
        let now = chrono::Utc::now();
        let assignment = CollaborationAssignment {
            id: Uuid::now_v7(),
            group_id: group.id,
            parent_assignment_id: None,
            owner_thread_id: Some(worker.id),
            requested_child: None,
            created_by_thread_id: Some(thread.id),
            title: "Finished work".into(),
            instructions: "Return one durable result".into(),
            kind: AssignmentKind::Research,
            status: AssignmentStatus::Completed,
            dispatch_message_id: None,
            base_revision: None,
            depth: 0,
            result: Some(AssignmentResult {
                outcome: AssignmentOutcome::Success,
                summary: "The structured result surfaced".into(),
                changes: Vec::new(),
                checks: Vec::new(),
                artifacts: Vec::new(),
                unresolved: Vec::new(),
                completed_at: now,
            }),
            uncertainty: None,
            revision: 2,
            created_at: now,
            updated_at: now,
        };
        fixture.store.collaboration_assignment_put(&assignment).unwrap();

        let mut peer_progress = Vec::new();
        for index in 0..101 {
            let message = CollaborationMessage {
                id: Uuid::now_v7(),
                operation_id: Uuid::now_v7(),
                group_id: group.id,
                assignment_id: None,
                from_thread_id: Some(worker.id),
                to_thread_id: worker.id,
                external_recipient: false,
                purpose: CollaborationMessagePurpose::Progress,
                reply_to: None,
                body: format!("old peer progress {index}"),
                state: CollaborationDeliveryState::Persisted,
                delivery_turn_id: None,
                wakeup_count: 0,
                created_at: now,
                updated_at: now,
            };
            fixture.store.collaboration_message_put(&message, None).unwrap();
            peer_progress.push(message);
        }
        let result_notification = CollaborationMessage {
            id: Uuid::now_v7(),
            operation_id: Uuid::now_v7(),
            group_id: group.id,
            assignment_id: Some(assignment.id),
            from_thread_id: Some(worker.id),
            to_thread_id: thread.id,
            external_recipient: false,
            purpose: CollaborationMessagePurpose::Result,
            reply_to: None,
            body: "Assignment finished".into(),
            state: CollaborationDeliveryState::Queued,
            delivery_turn_id: None,
            wakeup_count: 1,
            created_at: now,
            updated_at: now,
        };
        fixture.store.collaboration_message_put(&result_notification, Some(result_notification.id)).unwrap();
        fixture.store.collaboration_message_queue(&result_notification).unwrap();

        let (live, _) = fixture.active_app_tool_session(&thread).await;
        let value = fixture
            .orchestrator
            .execute_native_app_tool_call(
                thread.id,
                live.session_instance_id,
                "read-structured-result",
                "kybern_collaboration_read",
                json!({}),
            )
            .await
            .unwrap();
        let inbox = value["pending_messages"].as_array().unwrap();
        assert_eq!(inbox.len(), 1);
        assert_eq!(inbox[0]["id"], result_notification.id.to_string());
        assert_eq!(inbox[0]["state"], "submitted");
        assert_eq!(value["assignments"][0]["result"]["summary"], "The structured result surfaced");
        assert!(!fixture.store.queue_is_pending(result_notification.id).unwrap(), "surfaced structured result consumes its wakeup");
        for message in peer_progress {
            assert_eq!(
                fixture.store.collaboration_message_get(message.id).unwrap().unwrap().state,
                CollaborationDeliveryState::Persisted,
                "another recipient's inbox remains untouched"
            );
        }
    }

    #[test]
    fn assignment_prompt_keeps_project_objective_as_background() {
        let fixture = Fixture::new();
        let thread = fixture.thread(ThreadStatus::Idle);
        let group = fixture
            .orchestrator
            .collaboration_group_create(methods::CollaborationGroupsCreateParams {
                operation_id: Uuid::now_v7(),
                project_id: thread.project_id,
                coordinator_thread_id: thread.id,
                objective: "Have a worker inspect the README".into(),
                success_criteria: vec![],
                coordinator_mode: Some(CoordinatorMode::Ordinary),
                policy: None,
            })
            .unwrap();
        let now = chrono::Utc::now();
        let assignment = CollaborationAssignment {
            id: Uuid::now_v7(),
            group_id: group.id,
            parent_assignment_id: None,
            owner_thread_id: Some(thread.id),
            requested_child: None,
            created_by_thread_id: Some(thread.id),
            title: "Inspect the README".into(),
            instructions: "Return the exact test command".into(),
            kind: AssignmentKind::Research,
            status: AssignmentStatus::Pending,
            dispatch_message_id: None,
            base_revision: None,
            depth: 0,
            result: None,
            uncertainty: None,
            revision: 1,
            created_at: now,
            updated_at: now,
        };
        let prompt = fixture.orchestrator.assignment_prompt(&group, &assignment).unwrap().plain_text();
        assert!(prompt.contains("Project background (context only; do not execute it as an assignment)"));
        assert!(prompt.contains("Your assignment: Inspect the README"));
        assert!(prompt.contains("do not repeat that request or broaden your deliverable"));
        assert!(prompt.contains("You may delegate a bounded subtask"));
        assert!(prompt.contains("honor every user-authored instruction or correction"));
        assert!(prompt.contains("omit permission_mode unless the user specifically requested an override"));
        assert!(prompt.contains("never cancel and recreate it to bypass approval"));
    }

    #[test]
    fn native_collaboration_wait_is_capped_below_client_deadline() {
        let mut arguments = json!({"timeout_ms":60_000}).as_object().unwrap().clone();
        super::cap_native_collaboration_wait(&mut arguments);
        assert_eq!(arguments["timeout_ms"], 30_000);

        let mut shorter = json!({"timeout_ms":5_000}).as_object().unwrap().clone();
        super::cap_native_collaboration_wait(&mut shorter);
        assert_eq!(shorter["timeout_ms"], 5_000);
    }

    #[tokio::test]
    async fn native_context_write_retries_without_uuid_preserve_one_revision() {
        let fixture = Fixture::new();
        let thread = fixture.thread(ThreadStatus::Idle);
        let (live, _) = fixture.active_app_tool_session(&thread).await;
        let arguments =
            json!({"request_key":"remember-test-command", "key":"test-command", "kind":"research", "body":"Run cargo test -p sample."});
        let first = fixture
            .orchestrator
            .execute_native_app_tool_call(
                thread.id,
                live.session_instance_id,
                "first-call",
                "kybern_collaboration_context_put",
                arguments.clone(),
            )
            .await
            .unwrap();
        let retry = fixture
            .orchestrator
            .execute_native_app_tool_call(
                thread.id,
                live.session_instance_id,
                "new-call-after-lost-response",
                "kybern_collaboration_context_put",
                arguments.clone(),
            )
            .await
            .unwrap();
        assert_eq!(first, retry);
        assert!(first["operation_id"].as_str().is_some_and(|id| Uuid::parse_str(id).is_ok()));
        let group = fixture.store.collaboration_group_for_thread(thread.id).unwrap().unwrap();
        let entries = fixture.store.collaboration_context_latest(group).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].revision, 1);
        let mut changed = arguments;
        changed["body"] = json!("a different request");
        let error = fixture
            .orchestrator
            .execute_native_app_tool_call(thread.id, live.session_instance_id, "third-call", "kybern_collaboration_context_put", changed)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("operation id already belongs"));
        assert_eq!(fixture.store.collaboration_context_latest(group).unwrap()[0].body, "Run cargo test -p sample.");
    }

    #[tokio::test]
    async fn thread_context_starts_catalog_refresh_without_waiting_for_probes() {
        let fixture = Fixture::new();
        let thread = fixture.thread(ThreadStatus::Idle);
        let (live, _) = fixture.active_app_tool_session(&thread).await;
        let first = fixture
            .orchestrator
            .execute_native_app_tool_call(thread.id, live.session_instance_id, "context-before-catalog", "kybern_thread_context", json!({}))
            .await
            .unwrap();
        assert_eq!(first["provider_catalog_state"], "loading");
        assert_eq!(first["providers"].as_array().unwrap().len(), ProviderKind::ALL.len());

        let cached = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let value = fixture
                    .orchestrator
                    .execute_native_app_tool_call(
                        thread.id,
                        live.session_instance_id,
                        "context-after-catalog",
                        "kybern_thread_context",
                        json!({}),
                    )
                    .await
                    .unwrap();
                if value["provider_catalog_state"] == "cached" {
                    break value;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(cached["providers"].as_array().unwrap().len(), ProviderKind::ALL.len());
        assert!(cached["providers"].as_array().unwrap().iter().all(|provider| provider["models"].is_array()));
    }

    #[test]
    fn assignment_context_prioritizes_constraints_and_defers_archived_reports() {
        let entry = |key: &str, kind, body: String, user_authored| ContextEntry {
            id: Uuid::now_v7(),
            group_id: Uuid::now_v7(),
            key: key.into(),
            kind,
            body,
            author_thread_id: None,
            user_authored,
            revision: 1,
            source_refs: vec![],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        };
        let mut context: Vec<_> = (0..40)
            .map(|index| {
                entry(
                    &format!("assignment.result.{index}"),
                    ContextEntryKind::ResultReference,
                    "old detailed worker report ".repeat(400),
                    false,
                )
            })
            .collect();
        context.push(entry("z.user", ContextEntryKind::ResultReference, "Preserve the user's correction".into(), true));
        context.push(entry("plan", ContextEntryKind::Plan, "Current work only".into(), false));
        context.push(entry("project.setup", ContextEntryKind::Research, "Build commands and architecture".into(), false));
        let shared = super::assignment_shared_context(context);
        assert!(shared.contains("Preserve the user's correction"));
        assert!(shared.contains("Current work only"));
        assert!(shared.contains("Build commands and architecture"));
        assert!(shared.contains("40 archived result reports"));
        assert!(!shared.contains("old detailed worker report"));
        assert!(shared.find("z.user").unwrap() < shared.find("plan").unwrap());
        assert!(shared.len() < 1024, "archived reports should not inflate every new worker prompt");
    }

    #[tokio::test]
    async fn ordinary_thread_reads_project_knowledge_without_creating_a_group() {
        let fixture = Fixture::new();
        let thread = fixture.thread(ThreadStatus::Idle);
        let coordinator = fixture
            .orchestrator
            .project_coordinator_get_or_create(methods::CollaborationCoordinatorGetOrCreateParams {
                operation_id: Uuid::now_v7(),
                project_id: thread.project_id,
                provider: ProviderInstance::default_for(ProviderKind::Codex),
                model: None,
                effort: None,
                permission_mode: Some(PermissionMode::Supervised),
                coordinator_mode: Some(CoordinatorMode::Ordinary),
                initial_goal: Some("Keep reusable project facts".into()),
            })
            .await
            .unwrap();
        let role_before = fixture.orchestrator.coordinator_instructions(&coordinator.thread).unwrap().unwrap();
        assert!(role_before.contains("kybern_collaboration_read"));
        assert!(role_before.contains("kybern_collaboration_context_read"));
        assert!(role_before.contains("kybern_thread_read"));
        fixture
            .orchestrator
            .collaboration_context_put(
                methods::CollaborationContextPutParams {
                    operation_id: Uuid::now_v7(),
                    group_id: coordinator.group.id,
                    entry_id: None,
                    key: "shared.fact".into(),
                    kind: ContextEntryKind::Decision,
                    body: "The project uses a scratch daemon for tests.".into(),
                    author_thread_id: None,
                    user_authored: true,
                    expected_revision: None,
                    source_refs: vec!["user:test".into()],
                },
                None,
            )
            .unwrap();
        let (live, _) = fixture.active_app_tool_session(&thread).await;
        let result = fixture
            .orchestrator
            .execute_native_app_tool_call(
                thread.id,
                live.session_instance_id,
                "read-project-knowledge",
                "kybern_collaboration_context_read",
                json!({"keys":["shared.fact"], "limit":10}),
            )
            .await
            .unwrap();
        assert_eq!(result["entries"][0]["key"], "shared.fact");
        assert_eq!(fixture.store.collaboration_group_for_thread(thread.id).unwrap(), None);
        let role_after = fixture.orchestrator.coordinator_instructions(&coordinator.thread).unwrap().unwrap();
        assert_eq!(role_before, role_after, "changing project knowledge must not replace the cached system prefix");
        assert!(!role_after.contains("The project uses a scratch daemon"), "live knowledge belongs in tool responses");
        let mut resumed = coordinator.thread.clone();
        resumed.provider_session_id = Some("saved-provider-session".into());
        assert_eq!(fixture.orchestrator.coordinator_instructions(&resumed).unwrap().as_deref(), Some(role_before.as_str()));
    }

    #[tokio::test]
    async fn app_tool_request_roundtrips_through_the_event_pump() {
        let fixture = Fixture::new();
        std::fs::write(fixture.root.join("bridge.txt"), "through the daemon").unwrap();
        let thread = fixture.thread_with_provider(ThreadStatus::Idle, ProviderKind::Pi);
        let (live, responses) = fixture.active_app_tool_session(&thread).await;
        let (tx, rx) = tokio::sync::mpsc::channel(4);
        let pump = tokio::spawn(fixture.orchestrator.clone().pump(thread.id, live, rx));

        tx.send(DriverEvent::AppToolRequest {
            request_id: "request-1".into(),
            name: "kybern_read_file".into(),
            arguments: json!({ "path": "bridge.txt" }),
        })
        .await
        .unwrap();

        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if !responses.lock().await.is_empty() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let response = responses.lock().await.pop().unwrap();
        assert_eq!(response.0, "request-1");
        assert_eq!(response.1.unwrap()["content"], "through the daemon");
        drop(tx);
        pump.abort();
    }

    #[tokio::test]
    async fn app_tool_request_from_a_replaced_session_is_rejected() {
        let fixture = Fixture::new();
        let thread = fixture.thread_with_provider(ThreadStatus::Idle, ProviderKind::Pi);
        let (stale, responses) = fixture.active_app_tool_session(&thread).await;
        let (replacement, _) = fixture.park(&thread, Instant::now()).await;
        assert!(!Arc::ptr_eq(&stale, &replacement));

        fixture
            .orchestrator
            .queue_app_tool_request(thread.id, stale, "stale-request".into(), "kybern_thread_context".into(), json!({}))
            .await;
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if !responses.lock().await.is_empty() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let (_, response) = responses.lock().await.pop().unwrap();
        assert!(response.unwrap_err().contains("no active owning turn"));
    }

    #[tokio::test]
    async fn app_tool_requests_have_a_per_session_concurrency_cap() {
        let fixture = Fixture::new();
        let thread = fixture.thread_with_provider(ThreadStatus::Idle, ProviderKind::Pi);
        let (live, responses) = fixture.active_app_tool_session(&thread).await;
        let mut permits = Vec::new();
        for _ in 0..crate::app_tools::MAX_CONCURRENT_REQUESTS {
            permits.push(live.app_tool_permits.clone().acquire_owned().await.unwrap());
        }

        fixture.orchestrator.queue_app_tool_request(thread.id, live, "over-cap".into(), "kybern_thread_context".into(), json!({})).await;
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if !responses.lock().await.is_empty() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let (_, response) = responses.lock().await.pop().unwrap();
        let error = response.unwrap_err();
        assert!(error.contains("too many concurrent"), "unexpected rejection: {error}");
        drop(permits);
    }

    #[tokio::test]
    async fn provider_exit_reaps_idle_background_work_without_waiting_for_sender_drop() {
        for code in [0, 1] {
            let fixture = Fixture::new();
            let thread = fixture.thread_with_provider(ThreadStatus::Idle, ProviderKind::Omp);
            let (live, _) = fixture.park(&thread, Instant::now()).await;
            fixture.orchestrator.send(thread.id, UserMessage::text("start background work")).await.unwrap();
            live.turn_ready.notified().await;
            let task = generic_runtime_task(&ToolCall {
                id: "bg_5".into(),
                name: "Bash".into(),
                input: json!({"command":"sleep 30", "run_in_background":true}),
                parent_id: None,
            })
            .unwrap();
            fixture.orchestrator.handle_driver_event(thread.id, &live, DriverEvent::RuntimeTaskStarted(task)).await.unwrap();
            // OMP's terminal result can leave provider-owned work alive.
            fixture.orchestrator.handle_driver_event(thread.id, &live, completed_response(StopReason::Completed)).await.unwrap();
            assert!(live.turn.lock().await.is_none());
            assert!(fixture.store.runtime_tasks_for_thread(thread.id).unwrap().iter().any(|task| task.status.is_active()));
            if code != 0 {
                live.tasks.lock().await.clear();
            }

            // Pi/OMP retain the sender in the public session handle even after
            // the reader emits Exited. EOF on this channel will never arrive.
            let (tx, rx) = tokio::sync::mpsc::channel(8);
            tx.send(DriverEvent::Exited { code: Some(code), error: (code != 0).then(|| "process died".into()) }).await.unwrap();
            tokio::time::timeout(Duration::from_secs(1), fixture.orchestrator.clone().pump(thread.id, live, rx))
                .await
                .expect("Exited must retire the session even while its sender is retained");
            assert!(!fixture.has_session(&thread).await);
            let tasks = fixture.store.runtime_tasks_for_thread(thread.id).unwrap();
            assert!(tasks.iter().all(|task| task.status == RuntimeTaskStatus::Interrupted && task.completed_at.is_some()));
            assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().status, ThreadStatus::Idle);
            drop(tx);
        }
    }

    #[tokio::test]
    async fn idle_interrupt_reconciles_unattached_tasks_on_broken_or_stalled_transport() {
        for hangs in [false, true] {
            let fixture = Fixture::new();
            let thread = fixture.thread_with_provider(ThreadStatus::Idle, ProviderKind::Omp);
            let (mut live, closes) = fixture.park(&thread, Instant::now()).await;
            fixture.orchestrator.inner.sessions.lock().await.remove(&thread.id);
            Arc::get_mut(&mut live).unwrap().session =
                Box::new(TestSession { closes: closes.clone(), hang_interrupt: hangs, broken_interrupt: !hangs, ..Default::default() });
            fixture.orchestrator.inner.sessions.lock().await.insert(thread.id, live.clone());
            fixture.orchestrator.send(thread.id, UserMessage::text("background process")).await.unwrap();
            live.turn_ready.notified().await;
            fixture.orchestrator.handle_driver_event(thread.id, &live, completed_response(StopReason::Completed)).await.unwrap();
            let task = generic_runtime_task(&ToolCall {
                id: "bg_5".into(),
                name: "Bash".into(),
                input: json!({"command":"sleep 30", "run_in_background":true}),
                parent_id: None,
            })
            .unwrap();
            fixture.orchestrator.handle_driver_event(thread.id, &live, DriverEvent::RuntimeTaskStarted(task)).await.unwrap();
            live.tasks.lock().await.clear();
            fixture.orchestrator.interrupt_with_grace(thread.id, Duration::from_millis(20)).await.unwrap();
            assert_eq!(closes.load(Ordering::SeqCst), 1);
            assert!(!fixture.has_session(&thread).await);
            assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().status, ThreadStatus::Idle);
            let tasks = fixture.store.runtime_tasks_for_thread(thread.id).unwrap();
            assert_eq!(tasks.len(), 1);
            assert_eq!(tasks[0].status, RuntimeTaskStatus::Interrupted);
            assert!(tasks[0].completed_at.is_some());
            assert!(fixture.orchestrator.inner.releasing.lock().await.is_empty());
        }
    }

    #[tokio::test]
    async fn interrupt_ack_without_a_result_must_settle_the_turn() {
        let fixture = Fixture::new();
        let thread = fixture.thread(ThreadStatus::Idle);
        let (live, closes) = fixture.park(&thread, Instant::now()).await;
        fixture.orchestrator.send(thread.id, UserMessage::text("wait for task output")).await.unwrap();
        live.turn_ready.notified().await;
        // The provider acknowledges interrupt but never emits a terminal event.
        fixture.orchestrator.interrupt_with_grace(thread.id, Duration::from_millis(50)).await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while fixture.store.thread_get(thread.id).unwrap().unwrap().status != ThreadStatus::Idle {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("an acknowledged stop must not leave the thread stuck running");
        assert_eq!(closes.load(Ordering::SeqCst), 1);
        assert!(live.turn.lock().await.is_none());
        assert!(!fixture.has_session(&thread).await);
        assert!(
            fixture
                .store
                .events_for_thread(thread.id)
                .unwrap()
                .iter()
                .any(|event| { matches!(event.payload, EventPayload::TurnCompleted { stop_reason: StopReason::Interrupted, .. }) })
        );
    }

    #[tokio::test]
    async fn interrupt_without_ack_survives_rpc_cancellation() {
        let fixture = Fixture::new();
        let thread = fixture.thread(ThreadStatus::Idle);
        let (mut live, closes) = fixture.park(&thread, Instant::now()).await;
        fixture.orchestrator.inner.sessions.lock().await.remove(&thread.id);
        Arc::get_mut(&mut live).unwrap().session =
            Box::new(TestSession { closes: closes.clone(), hang_interrupt: true, ..Default::default() });
        fixture.orchestrator.inner.sessions.lock().await.insert(thread.id, live.clone());
        fixture.orchestrator.send(thread.id, UserMessage::text("stuck provider")).await.unwrap();
        live.turn_ready.notified().await;
        let orchestrator = fixture.orchestrator.clone();
        let request = tokio::spawn(async move { orchestrator.interrupt_with_grace(thread.id, Duration::from_millis(50)).await });
        tokio::time::sleep(Duration::from_millis(10)).await;
        request.abort();
        tokio::time::timeout(Duration::from_secs(2), async {
            while fixture.store.thread_get(thread.id).unwrap().unwrap().status != ThreadStatus::Idle {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(closes.load(Ordering::SeqCst), 1);
        assert!(!fixture.has_session(&thread).await);
    }

    #[tokio::test]
    async fn interrupt_deadline_does_not_close_a_new_continuation() {
        let fixture = Fixture::new();
        let thread = fixture.thread(ThreadStatus::Idle);
        let (live, closes) = fixture.park(&thread, Instant::now()).await;
        fixture.orchestrator.send(thread.id, UserMessage::text("monitor")).await.unwrap();
        live.turn_ready.notified().await;
        let old_response = live.turn.lock().await.as_ref().unwrap().response_id;
        let orchestrator = fixture.orchestrator.clone();
        let request = tokio::spawn(async move { orchestrator.interrupt_with_grace(thread.id, Duration::from_millis(50)).await });
        tokio::time::sleep(Duration::from_millis(10)).await;
        fixture.orchestrator.handle_driver_event(thread.id, &live, completed_response(StopReason::Completed)).await.unwrap();
        fixture.orchestrator.handle_driver_event(thread.id, &live, DriverEvent::ResponseStarted).await.unwrap();
        assert_ne!(live.turn.lock().await.as_ref().unwrap().response_id, old_response);
        request.await.unwrap().unwrap();
        // Also exercise a watchdog already entering its final claim.
        fixture.orchestrator.force_interrupt(thread.id, &live, Some(old_response)).await.unwrap();
        assert_eq!(closes.load(Ordering::SeqCst), 0);
        assert!(fixture.has_session(&thread).await);
        fixture.orchestrator.handle_driver_event(thread.id, &live, completed_response(StopReason::Interrupted)).await.unwrap();
        fixture.orchestrator.shutdown().await;
    }

    #[tokio::test]
    async fn interrupt_settles_a_provisional_result_after_tasks_stop() {
        let fixture = Fixture::new();
        let thread = fixture.thread(ThreadStatus::Idle);
        let (live, closes) = fixture.park(&thread, Instant::now()).await;
        fixture.orchestrator.send(thread.id, UserMessage::text("wait for background work")).await.unwrap();
        live.turn_ready.notified().await;
        let task = generic_runtime_task(&ToolCall {
            id: "task-1".into(),
            name: "task".into(),
            input: json!({"description":"Explore"}),
            parent_id: None,
        })
        .unwrap();
        fixture.orchestrator.handle_driver_event(thread.id, &live, DriverEvent::RuntimeTaskStarted(task)).await.unwrap();
        fixture
            .orchestrator
            .handle_driver_event(
                thread.id,
                &live,
                DriverEvent::TurnCompleted {
                    stop_reason: StopReason::Completed,
                    usage: Usage { input_tokens: 42, ..Usage::default() },
                    cost_usd: Some(0.2),
                    duration_ms: 20,
                    anchors: TurnAnchors::default(),
                },
            )
            .await
            .unwrap();
        assert!(live.turn.lock().await.as_ref().unwrap().pending_completion.is_some());
        fixture
            .orchestrator
            .handle_driver_event(
                thread.id,
                &live,
                DriverEvent::RuntimeTaskCompleted(DriverRuntimeTaskUpdate::status("tool:task-1", RuntimeTaskStatus::Stopped)),
            )
            .await
            .unwrap();
        assert!(live.tasks.lock().await.values().all(|task| task.status == RuntimeTaskStatus::Stopped));
        assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().status, ThreadStatus::Running);
        fixture.orchestrator.interrupt_with_grace(thread.id, Duration::from_millis(50)).await.unwrap();
        assert_eq!(closes.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().status, ThreadStatus::Idle);
        let events = fixture.store.events_for_thread(thread.id).unwrap();
        assert!(events.iter().any(|event| matches!(&event.payload,
            EventPayload::TurnCompleted { stop_reason: StopReason::Interrupted, usage, cost_usd: Some(cost), .. }
            if usage.input_tokens == 42 && (*cost - 0.2).abs() < 1e-10
        )));
        let count = events.len();
        fixture.orchestrator.handle_driver_event(thread.id, &live, DriverEvent::ResponseStarted).await.unwrap();
        fixture.orchestrator.handle_driver_event(thread.id, &live, completed_response(StopReason::Completed)).await.unwrap();
        assert_eq!(fixture.store.events_for_thread(thread.id).unwrap().len(), count, "retired output cannot reopen the turn");
    }

    #[tokio::test]
    async fn explicit_runtime_task_resume_reactivates_a_completed_agent() {
        let fixture = Fixture::new();
        let thread = fixture.thread(ThreadStatus::Idle);
        let (live, _) = fixture.park(&thread, Instant::now()).await;
        fixture.orchestrator.send(thread.id, UserMessage::text("delegate")).await.unwrap();
        live.turn_ready.notified().await;
        let task = DriverRuntimeTask {
            id: "agent-1".into(),
            kind: RuntimeTaskKind::Agent,
            status: RuntimeTaskStatus::Running,
            title: "Subagent".into(),
            detail: None,
            provider_type: Some("sub_agent".into()),
            parent_id: None,
            tool_call_id: None,
            provider_thread_id: Some("agent-1".into()),
            model: None,
            effort: None,
            backgrounded: true,
            last_tool_name: None,
            usage: None,
            stats: RuntimeTaskStats::default(),
            capabilities: RuntimeTaskCapabilities { stop: true, background: false },
        };
        fixture.orchestrator.handle_driver_event(thread.id, &live, DriverEvent::RuntimeTaskStarted(task)).await.unwrap();
        fixture
            .orchestrator
            .handle_driver_event(
                thread.id,
                &live,
                DriverEvent::RuntimeTaskCompleted(DriverRuntimeTaskUpdate::status("agent-1", RuntimeTaskStatus::Completed)),
            )
            .await
            .unwrap();
        assert_eq!(fixture.store.runtime_tasks_for_thread(thread.id).unwrap()[0].status, RuntimeTaskStatus::Completed);

        fixture
            .orchestrator
            .handle_driver_event(
                thread.id,
                &live,
                DriverEvent::RuntimeTaskResumed(DriverRuntimeTaskUpdate {
                    id: "agent-1".into(),
                    status: Some(RuntimeTaskStatus::Running),
                    detail: None,
                    backgrounded: None,
                    last_tool_name: None,
                    usage: None,
                    stats: None,
                    capabilities: Some(RuntimeTaskCapabilities { stop: true, background: false }),
                }),
            )
            .await
            .unwrap();
        let resumed = fixture.store.runtime_tasks_for_thread(thread.id).unwrap();
        assert_eq!(resumed[0].status, RuntimeTaskStatus::Running);
        assert!(resumed[0].completed_at.is_none());
        assert!(matches!(
            fixture.store.events_for_thread(thread.id).unwrap().last().unwrap().payload,
            EventPayload::RuntimeTaskStarted { .. }
        ));
    }

    #[tokio::test]
    async fn interrupt_fallback_resolves_approvals_and_active_tasks() {
        let fixture = Fixture::new();
        let thread = fixture.thread(ThreadStatus::Idle);
        let (live, _) = fixture.park(&thread, Instant::now()).await;
        fixture.orchestrator.send(thread.id, UserMessage::text("background work awaiting permission")).await.unwrap();
        live.turn_ready.notified().await;
        let task = generic_runtime_task(&ToolCall {
            id: "task-1".into(),
            name: "task".into(),
            input: json!({"description":"Explore"}),
            parent_id: None,
        })
        .unwrap();
        fixture.orchestrator.handle_driver_event(thread.id, &live, DriverEvent::RuntimeTaskStarted(task)).await.unwrap();
        fixture
            .orchestrator
            .handle_driver_event(
                thread.id,
                &live,
                DriverEvent::PermissionRequest {
                    request_id: "permission-1".into(),
                    tool_call_id: Some("tool-1".into()),
                    tool_name: "Bash".into(),
                    input: json!({"command":"sleep 30"}),
                    summary: "Allow this command".into(),
                    suggestions: vec![],
                },
            )
            .await
            .unwrap();
        assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().status, ThreadStatus::AwaitingApproval);
        let approval = *live.pending.lock().await.keys().next().unwrap();
        fixture.orchestrator.interrupt_with_grace(thread.id, Duration::from_millis(50)).await.unwrap();
        assert!(live.pending.lock().await.is_empty());
        assert!(fixture.store.approval_get(approval).unwrap().unwrap().1);
        assert!(live.tasks.lock().await.values().all(|task| task.status == RuntimeTaskStatus::Interrupted));
        assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().status, ThreadStatus::Idle);
        // The old pump must not report this deliberately closed turn as failed.
        let (tx, rx) = tokio::sync::mpsc::channel(1);
        drop(tx);
        fixture.orchestrator.clone().pump(thread.id, live, rx).await;
        assert!(
            !fixture
                .store
                .events_for_thread(thread.id)
                .unwrap()
                .iter()
                .any(|event| matches!(event.payload, EventPayload::TurnFailed { .. }))
        );
    }

    #[tokio::test]
    async fn steering_retries_preserve_the_running_turn_and_deliver_once() {
        let fixture = Fixture::new();
        let thread = fixture.thread(ThreadStatus::Idle);
        let (live, _, messages) = fixture.park_recording(&thread, Instant::now()).await;
        let (turn_id, _) = fixture.orchestrator.send(thread.id, UserMessage::text("initial request")).await.unwrap();
        live.turn_ready.notified().await;
        tokio::time::timeout(Duration::from_secs(2), async {
            while messages.lock().await.is_empty() {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        let prompt = methods::QueuedMessage { id: Uuid::now_v7(), thread_id: thread.id, message: UserMessage::text("Steer this turn") };
        let (first, retry) = tokio::join!(fixture.orchestrator.steer(prompt.clone()), fixture.orchestrator.steer(prompt.clone()));
        assert_eq!(first.unwrap().turn_id, turn_id);
        assert_eq!(retry.unwrap().message_id, prompt.id);
        assert_eq!(messages.lock().await.len(), 2);
        let events = fixture.store.events_for_thread(thread.id).unwrap();
        assert_eq!(events.iter().filter(|ev| matches!(ev.payload, EventPayload::TurnStarted { .. })).count(), 1);
        assert_eq!(events.iter().filter(|ev| matches!(ev.payload, EventPayload::MessageSteered { .. })).count(), 1);
        let transcript = kybern_store::project_transcript(&events);
        assert_eq!(transcript.iter().filter(|entry| matches!(entry, TranscriptEntry::User { .. })).count(), 2);
        fixture.orchestrator.handle_driver_event(thread.id, &live, completed_response(StopReason::Completed)).await.unwrap();
        assert_eq!(fixture.orchestrator.steer(prompt.clone()).await.unwrap().turn_id, turn_id, "retry after completion is acknowledged");
        assert!(fixture.orchestrator.steer(methods::QueuedMessage { message: UserMessage::text("different"), ..prompt }).await.is_err());
        assert!(
            fixture
                .orchestrator
                .steer(methods::QueuedMessage { id: Uuid::now_v7(), thread_id: thread.id, message: UserMessage::text("late") })
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn queued_edits_keep_order_and_dispatch_the_latest_saved_prompt() {
        let fixture = Fixture::new();
        let thread = fixture.thread(ThreadStatus::Idle);
        let (live, _, messages) = fixture.park_recording(&thread, Instant::now()).await;
        let first = methods::QueuedMessage { id: Uuid::now_v7(), thread_id: thread.id, message: UserMessage::text("old prompt") };
        let second = methods::QueuedMessage { id: Uuid::now_v7(), message: UserMessage::text("second"), ..first.clone() };
        fixture.orchestrator.enqueue(first.clone()).unwrap();
        fixture.orchestrator.enqueue(second.clone()).unwrap();
        let edited = methods::QueuedMessage { message: UserMessage::text("edited prompt"), ..first.clone() };
        fixture.orchestrator.update_queued(edited.clone()).unwrap();
        let queue = fixture.store.queue_list(Some(thread.id)).unwrap();
        assert_eq!(queue.iter().map(|item| item.id).collect::<Vec<_>>(), vec![first.id, second.id]);
        // Model a worker that selected the item immediately before it was edited.
        fixture.orchestrator.send_with_id(thread.id, first.id, first.message, true, false).await.unwrap();
        live.turn_ready.notified().await;
        tokio::time::timeout(Duration::from_secs(2), async {
            while messages.lock().await.is_empty() {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(messages.lock().await[0].plain_text(), "edited prompt");
        assert!(fixture.store.events_for_thread(thread.id).unwrap().iter().any(|event| {
            matches!(&event.payload, EventPayload::TurnStarted { message, .. } if message.plain_text() == "edited prompt")
        }));
        assert!(fixture.orchestrator.update_queued(edited).is_err());
        assert_eq!(fixture.store.queue_list(Some(thread.id)).unwrap()[0].id, second.id);
    }

    #[tokio::test]
    async fn notes_are_per_thread_and_conflicting_saves_preserve_the_saved_text() {
        let fixture = Fixture::new();
        let a = fixture.thread(ThreadStatus::Running);
        let b = fixture.thread(ThreadStatus::Idle);
        let params =
            methods::ThreadNotesSetParams { thread_id: a.id, text: "Remember to test mobile\n☑ Notes".into(), expected_revision: 0 };
        let saved = fixture.orchestrator.set_notes(params.clone()).unwrap();
        assert_eq!(saved.revision, 1);
        assert_eq!(fixture.orchestrator.set_notes(params.clone()).unwrap(), saved, "retry is idempotent");
        assert!(fixture.orchestrator.set_notes(methods::ThreadNotesSetParams { text: "stale edit".into(), ..params }).is_err());
        assert_eq!(fixture.store.thread_notes(a.id).unwrap(), saved);
        assert_eq!(fixture.store.thread_notes(b.id).unwrap(), methods::ThreadNotes::default());
        let events = fixture.store.events_for_thread(a.id).unwrap();
        assert_eq!(events.len(), 1);
        assert!(kybern_store::project_transcript(&events).is_empty(), "notes are not prompts");
        let cleared = fixture
            .orchestrator
            .set_notes(methods::ThreadNotesSetParams { thread_id: a.id, text: String::new(), expected_revision: 1 })
            .unwrap();
        assert_eq!(cleared.text, "");
        assert_eq!(cleared.revision, 2);
        assert!(
            fixture
                .orchestrator
                .set_notes(methods::ThreadNotesSetParams { thread_id: a.id, text: "x".repeat(128 * 1024 + 1), expected_revision: 2 })
                .is_err()
        );
    }

    #[tokio::test]
    async fn user_startup_wins_over_a_late_continuation_without_orphaning_output() {
        let fixture = Fixture::new();
        let thread = fixture.thread(ThreadStatus::Idle);
        let (live, _) = fixture.park(&thread, Instant::now()).await;
        let (first, _) = fixture.orchestrator.send(thread.id, UserMessage::text("first")).await.unwrap();
        live.turn_ready.notified().await;
        fixture.orchestrator.handle_driver_event(thread.id, &live, completed_response(StopReason::Completed)).await.unwrap();
        assert_eq!(live.continuation.lock().await.as_ref().unwrap().id, first);

        // Hold only session lookup: accepting user input is synchronous, but
        // start_turn cannot yet install the newly reserved turn.
        let sessions = fixture.orchestrator.inner.sessions.lock().await;
        let (second, _) = fixture.orchestrator.send(thread.id, UserMessage::text("second")).await.unwrap();
        let orchestrator = fixture.orchestrator.clone();
        let response_live = live.clone();
        let response = tokio::spawn(async move {
            orchestrator
                .handle_driver_event(
                    thread.id,
                    &response_live,
                    DriverEvent::TextDelta {
                        message_id: "late-response".into(),
                        origin: EventOrigin::Root,
                        delta: "Reading results".into(),
                    },
                )
                .await
        });
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(!response.is_finished());
        drop(sessions);
        tokio::time::timeout(Duration::from_secs(2), response).await.unwrap().unwrap().unwrap();
        let events = fixture.store.events_for_thread(thread.id).unwrap();
        assert!(!events.iter().any(|event| matches!(event.payload, EventPayload::TurnResumed)));
        assert!(
            events.iter().any(|event| event.turn_id == Some(second) && matches!(event.payload, EventPayload::AssistantTextDelta { .. }))
        );
        assert_eq!(live.turn.lock().await.as_ref().unwrap().id, second);

        // A native automatic result before the queued user is consumed only
        // closes the root message boundary; it does not finish the user turn.
        fixture.orchestrator.handle_driver_event(thread.id, &live, DriverEvent::ResponseBoundary).await.unwrap();
        assert_eq!(live.turn.lock().await.as_ref().unwrap().id, second);
        assert!(live.turn.lock().await.as_ref().unwrap().active_messages.is_empty());
        fixture.orchestrator.handle_driver_event(thread.id, &live, completed_response(StopReason::Completed)).await.unwrap();
        assert_eq!(live.continuation.lock().await.as_ref().unwrap().id, second);
        fixture.orchestrator.shutdown().await;
    }

    #[tokio::test]
    async fn repeated_continuations_settle_and_interrupt_without_phantom_restarts() {
        let fixture = Fixture::new();
        let thread = fixture.thread(ThreadStatus::Idle);
        let (live, _) = fixture.park(&thread, Instant::now()).await;
        let (turn_id, _) = fixture.orchestrator.send(thread.id, UserMessage::text("monitor")).await.unwrap();
        live.turn_ready.notified().await;
        fixture.orchestrator.handle_driver_event(thread.id, &live, completed_response(StopReason::Completed)).await.unwrap();
        for _ in 0..2 {
            fixture.orchestrator.handle_driver_event(thread.id, &live, DriverEvent::ResponseStarted).await.unwrap();
            assert_eq!(live.turn.lock().await.as_ref().unwrap().id, turn_id);
            fixture.orchestrator.handle_driver_event(thread.id, &live, completed_response(StopReason::Completed)).await.unwrap();
        }
        fixture.orchestrator.handle_driver_event(thread.id, &live, DriverEvent::ResponseStarted).await.unwrap();
        fixture.orchestrator.handle_driver_event(thread.id, &live, completed_response(StopReason::Interrupted)).await.unwrap();
        assert!(live.turn.lock().await.is_none());
        assert!(live.continuation.lock().await.is_none());
        fixture.orchestrator.handle_driver_event(thread.id, &live, DriverEvent::ResponseStarted).await.unwrap();
        assert!(live.turn.lock().await.is_none());
        let entries = kybern_store::project_transcript(&fixture.store.events_for_thread(thread.id).unwrap());
        assert_eq!(entries.iter().filter(|entry| matches!(entry, TranscriptEntry::TurnSummary { .. })).count(), 1);
        assert!(entries.iter().any(|entry| matches!(entry, TranscriptEntry::TurnSummary { stop_reason: StopReason::Interrupted, .. })));
        fixture.orchestrator.shutdown().await;
    }

    fn policy(session_idle_minutes: u32, max_idle_sessions: u32) -> BackgroundSettings {
        BackgroundSettings { session_idle_minutes, max_idle_sessions, ..BackgroundSettings::default() }
    }

    const MINUTE: Duration = Duration::from_secs(60);

    #[tokio::test]
    async fn every_provider_turn_receives_only_the_original_user_message() {
        let fixture = Fixture::new();
        let thread = fixture.thread(ThreadStatus::Idle);
        let (live, _, captured) = fixture.park_recording(&thread, Instant::now()).await;
        let messages = [
            UserMessage::text("hi"),
            UserMessage::text("hi 3"),
            UserMessage {
                parts: vec![
                    ContentPart::Text { text: "Review this screenshot".into() },
                    ContentPart::Image { media_type: "image/png".into(), data: "test".into() },
                ],
            },
        ];
        for (index, message) in messages.iter().enumerate() {
            fixture.orchestrator.send(thread.id, message.clone()).await.unwrap();
            let delivered = tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    if let Some(message) = captured.lock().await.get(index).cloned() {
                        break message;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap();
            assert_eq!(serde_json::to_value(delivered).unwrap(), serde_json::to_value(message).unwrap());
            fixture.orchestrator.handle_driver_event(thread.id, &live, completed_response(StopReason::Completed)).await.unwrap();
        }
        let events = fixture.store.events_for_thread(thread.id).unwrap();
        let stored: Vec<_> = events
            .iter()
            .filter_map(|event| match &event.payload {
                EventPayload::TurnStarted { message, .. } => Some(message),
                _ => None,
            })
            .collect();
        assert_eq!(serde_json::to_value(stored).unwrap(), serde_json::to_value(messages).unwrap());
        fixture.orchestrator.shutdown().await;
    }

    #[tokio::test]
    async fn async_answers_are_explicit_durable_and_do_not_replace_the_active_turn() {
        let fixture = Fixture::new();
        let thread = fixture.thread(ThreadStatus::Running);
        let (live, _) = fixture.park(&thread, Instant::now()).await;
        let turn_id = Uuid::now_v7();
        *live.turn.lock().await = Some(ActiveTurn {
            response_id: Uuid::now_v7(),
            id: turn_id,
            started: Instant::now(),
            startup_started: Instant::now(),
            provider: ProviderKind::Codex,
            session_reused: false,
            first_event_observed: false,
            messages: HashMap::new(),
            active_messages: HashMap::new(),
            terminal_message_id: None,
            completed: false,
            pending_completion: None,
        });
        fixture
            .orchestrator
            .emit(
                thread.id,
                Some(turn_id),
                EventPayload::TurnStarted { message_id: Uuid::now_v7(), message: UserMessage::text("original prompt") },
            )
            .unwrap();
        let request = AsyncQuestionRequest {
            id: "question".into(),
            questions: vec![AsyncQuestion { title: "Window?".into(), options: vec!["Yes".into(), "No".into()] }],
        };
        fixture.orchestrator.handle_driver_event(thread.id, &live, DriverEvent::AsyncQuestions(request.clone())).await.unwrap();
        fixture.orchestrator.handle_driver_event(thread.id, &live, DriverEvent::AsyncQuestions(request)).await.unwrap();
        assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().status, ThreadStatus::Running);
        assert!(fixture.store.approvals_pending(Some(thread.id)).unwrap().is_empty());
        let mut params = methods::ThreadsAnswerParams { thread_id: thread.id, request_id: "question".into(), answers: vec![] };
        assert!(fixture.orchestrator.answer_questions(params.clone()).await.unwrap_err().to_string().contains("each question"));
        assert_eq!(kybern_store::project_pending_questions(&fixture.store.events_for_thread(thread.id).unwrap()).len(), 1);
        params.answers = vec!["No, keep this window".into()];
        fixture.orchestrator.answer_questions(params.clone()).await.unwrap();
        fixture.orchestrator.answer_questions(params.clone()).await.unwrap();
        params.answers = vec!["Yes".into()];
        assert!(fixture.orchestrator.answer_questions(params).await.unwrap_err().to_string().contains("already been answered"));
        let events = fixture.store.events_for_thread(thread.id).unwrap();
        assert_eq!(events.iter().filter(|e| matches!(e.payload, EventPayload::AsyncQuestionsAnswered { .. })).count(), 1);
        assert_eq!(events.iter().filter(|e| matches!(e.payload, EventPayload::TurnStarted { .. })).count(), 1);
        assert!(kybern_store::project_pending_questions(&events).is_empty());
        assert_eq!(live.turn.lock().await.as_ref().unwrap().id, turn_id);
        assert_eq!(
            kybern_store::project_transcript(&events).iter().filter(|entry| matches!(entry, TranscriptEntry::User { .. })).count(),
            2
        );
    }

    #[tokio::test]
    async fn async_answer_during_startup_stays_pending_and_does_not_start_another_turn() {
        let fixture = Fixture::new();
        let thread = fixture.thread(ThreadStatus::Running);
        let (live, _) = fixture.park(&thread, Instant::now()).await;
        fixture
            .orchestrator
            .handle_driver_event(
                thread.id,
                &live,
                DriverEvent::AsyncQuestions(AsyncQuestionRequest {
                    id: "question".into(),
                    questions: vec![AsyncQuestion { title: "Continue?".into(), options: vec![] }],
                }),
            )
            .await
            .unwrap();
        let result = fixture
            .orchestrator
            .answer_questions(methods::ThreadsAnswerParams {
                thread_id: thread.id,
                request_id: "question".into(),
                answers: vec!["Yes".into()],
            })
            .await;
        assert!(result.unwrap_err().to_string().contains("Submit your answer again"));
        let events = fixture.store.events_for_thread(thread.id).unwrap();
        assert_eq!(kybern_store::project_pending_questions(&events).len(), 1);
        assert!(
            !events
                .iter()
                .any(|event| matches!(event.payload, EventPayload::AsyncQuestionsAnswered { .. } | EventPayload::TurnStarted { .. }))
        );
    }

    #[tokio::test]
    async fn async_question_survives_completion_and_idle_answer_starts_one_turn() {
        let fixture = Fixture::new();
        let thread = fixture.thread(ThreadStatus::Idle);
        let (live, _) = fixture.park(&thread, Instant::now()).await;
        let request = AsyncQuestionRequest {
            id: "question".into(),
            questions: vec![AsyncQuestion { title: "Constraints?".into(), options: vec![] }],
        };
        fixture.orchestrator.handle_driver_event(thread.id, &live, DriverEvent::AsyncQuestions(request)).await.unwrap();
        let params =
            methods::ThreadsAnswerParams { thread_id: thread.id, request_id: "question".into(), answers: vec!["Use scratch data".into()] };
        fixture.orchestrator.answer_questions(params.clone()).await.unwrap();
        fixture.orchestrator.answer_questions(params).await.unwrap();
        let events = fixture.store.events_for_thread(thread.id).unwrap();
        assert!(kybern_store::project_pending_questions(&events).is_empty());
        assert_eq!(events.iter().filter(|e| matches!(e.payload, EventPayload::TurnStarted { .. })).count(), 1);
        assert_eq!(
            kybern_store::project_transcript(&events).iter().filter(|entry| matches!(entry, TranscriptEntry::User { .. })).count(),
            1
        );
    }

    #[tokio::test]
    async fn compaction_rejects_busy_unsupported_and_empty_conversations_without_writing_a_turn() {
        let fixture = Fixture::new();
        let mut thread = fixture.thread(ThreadStatus::Running);
        assert!(fixture.orchestrator.send(thread.id, UserMessage::text("/compact")).await.unwrap_err().to_string().contains("busy"));
        thread.status = ThreadStatus::Idle;
        fixture.store.thread_upsert(&thread).unwrap();
        assert!(
            fixture.orchestrator.send(thread.id, UserMessage::text("/compact")).await.unwrap_err().to_string().contains("does not expose")
        );
        thread.id = Uuid::now_v7();
        thread.provider = ProviderInstance::default_for(ProviderKind::Codex);
        thread.provider_session_id = None;
        fixture.store.thread_upsert(&thread).unwrap();
        assert!(
            fixture.orchestrator.send(thread.id, UserMessage::text("/compact")).await.unwrap_err().to_string().contains("Send a message")
        );
        assert!(fixture.store.events_for_thread(thread.id).unwrap().is_empty());
    }

    #[tokio::test]
    async fn manual_release_preserves_history_and_refuses_active_sessions() {
        let fixture = Fixture::new();
        let mut thread = fixture.thread(ThreadStatus::Running);
        let (_, closes) = fixture.park(&thread, Instant::now()).await;
        assert!(fixture.orchestrator.release_session(thread.id).await.is_err());
        assert_eq!(closes.load(Ordering::SeqCst), 0);
        thread.status = ThreadStatus::Idle;
        fixture.store.thread_upsert(&thread).unwrap();
        fixture.orchestrator.release_session(thread.id).await.unwrap();
        assert_eq!(closes.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().provider_session_id, thread.provider_session_id);
        assert!(!fixture.has_session(&thread).await);
        assert!(fixture.orchestrator.release_session(thread.id).await.unwrap_err().to_string().contains("no live agent"));
    }

    #[tokio::test]
    async fn resume_waits_for_the_previous_writer_to_close() {
        let fixture = Fixture::new();
        let thread = fixture.thread(ThreadStatus::Idle);
        let (done, waiting) = tokio::sync::watch::channel(());
        fixture.orchestrator.inner.releasing.lock().await.insert(thread.id, waiting);
        let orchestrator = fixture.orchestrator.clone();
        let resume = tokio::spawn(async move { orchestrator.ensure_session(&thread).await });
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(!resume.is_finished(), "must not attempt a second writer during release");
        drop(done);
        let result = tokio::time::timeout(Duration::from_secs(1), resume).await.unwrap().unwrap();
        // This fixture has no drivers: getting this error proves spawn only ran
        // after the old writer's close barrier completed.
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn idle_sessions_are_released_after_the_policy_window() {
        let fixture = Fixture::new();
        let thread = fixture.thread(ThreadStatus::Idle);
        let started = Instant::now();
        let (_, closes) = fixture.park(&thread, started).await;

        let early =
            fixture.orchestrator.release_idle_sessions_at(&policy(10, 0), false, started + 9 * MINUTE, SystemTime::now()).await.unwrap();
        assert!(early.is_empty());
        assert!(fixture.has_session(&thread).await);

        let released =
            fixture.orchestrator.release_idle_sessions_at(&policy(10, 0), false, started + 10 * MINUTE, SystemTime::now()).await.unwrap();
        assert_eq!(released, vec![super::SessionRelease { thread_id: thread.id, reason: SessionReleaseReason::Idle }]);
        assert_eq!(closes.load(Ordering::SeqCst), 1);
        assert!(!fixture.has_session(&thread).await);
        assert_eq!(fixture.release_events(&thread), vec![SessionReleaseReason::Idle]);
        // The thread itself is untouched: it resumes from the provider session on the next send.
        let stored = fixture.store.thread_get(thread.id).unwrap().unwrap();
        assert_eq!(stored.status, ThreadStatus::Idle);
        assert_eq!(stored.provider_session_id.as_deref(), Some("provider-session"));
    }

    #[tokio::test]
    async fn on_battery_every_parked_session_goes_after_a_short_grace() {
        let fixture = Fixture::new();
        let fresh = fixture.thread(ThreadStatus::Idle);
        let older = fixture.thread(ThreadStatus::Idle);
        let started = Instant::now();
        fixture.park(&fresh, started).await;
        let (_, closes) = fixture.park(&older, started - BackgroundSettings::BATTERY_SESSION_IDLE).await;

        // The generous policy would keep both; on battery the older one goes now.
        let released = fixture.orchestrator.release_idle_sessions_at(&policy(30, 4), true, started, SystemTime::now()).await.unwrap();
        assert_eq!(released, vec![super::SessionRelease { thread_id: older.id, reason: SessionReleaseReason::Power }]);
        assert_eq!(closes.load(Ordering::SeqCst), 1);
        assert!(fixture.has_session(&fresh).await, "a session inside the grace period is kept");
        assert_eq!(fixture.release_events(&older), vec![SessionReleaseReason::Power]);

        let released = fixture
            .orchestrator
            .release_idle_sessions_at(&policy(30, 4), true, started + BackgroundSettings::BATTERY_SESSION_IDLE, SystemTime::now())
            .await
            .unwrap();
        assert_eq!(released.len(), 1);
        assert!(!fixture.has_session(&fresh).await);
    }

    #[tokio::test]
    async fn sleeping_past_the_idle_deadline_releases_sessions_below_the_warm_cap() {
        let fixture = Fixture::new();
        let first = fixture.thread(ThreadStatus::Idle);
        let second = fixture.thread(ThreadStatus::Idle);
        let started = Instant::now();
        let (_, first_closes) = fixture.park(&first, started).await;
        let (_, second_closes) = fixture.park(&second, started).await;

        let before_deadline = SystemTime::now() + 9 * MINUTE;
        assert!(fixture.orchestrator.release_idle_sessions_at(&policy(10, 4), false, started, before_deadline).await.unwrap().is_empty());

        // macOS can suspend the monotonic clock while wall time advances.
        // Neither agent has accumulated ten minutes of awake time.
        let after_sleep = SystemTime::now() + 60 * MINUTE;
        let released = fixture.orchestrator.release_idle_sessions_at(&policy(10, 4), false, started + MINUTE, after_sleep).await.unwrap();
        assert_eq!(released.len(), 2, "the first sweep after an hour asleep must close both idle processes");
        assert_eq!(first_closes.load(Ordering::SeqCst), 1);
        assert_eq!(second_closes.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.release_events(&first), vec![SessionReleaseReason::Idle]);
        assert_eq!(fixture.release_events(&second), vec![SessionReleaseReason::Idle]);
    }

    #[tokio::test]
    async fn reopening_and_subscribing_do_not_extend_an_idle_session() {
        use axum::{Router, routing::get};
        use kybern_client::{Client, Endpoint};
        use kybern_protocol::methods::*;

        let fixture = Fixture::new();
        let thread = fixture.thread(ThreadStatus::Idle);
        let started = Instant::now() - 11 * MINUTE;
        let (live, closes) = fixture.park(&thread, started).await;
        let last_activity = live.last_activity();
        let paths = Paths::resolve(Some(fixture.root.clone())).unwrap();
        let mut state = crate::state::AppState::initialize(&paths).unwrap();
        let inner = Arc::get_mut(&mut state.inner).unwrap();
        inner.store = fixture.store.clone();
        inner.orchestrator = fixture.orchestrator.clone();
        // Authentication uses the same in-memory store as the fixture.
        inner.bootstrap_token = crate::auth::ensure_bootstrap(&inner.store, &paths.token_file).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = Endpoint { url: format!("ws://{}/ws", listener.local_addr().unwrap()), token: state.bootstrap_token.clone() };
        let app = Router::new().route("/ws", get(crate::ws::upgrade)).with_state(state);
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = Client::connect(&endpoint).await.unwrap();
        client.call::<ThreadsGet>(ThreadsGetParams { thread_id: thread.id, ..Default::default() }).await.unwrap();
        client
            .call::<EventsSubscribe>(EventsSubscribeParams { thread_id: Some(thread.id), after_seq: None, include_tool_output: None })
            .await
            .unwrap();
        client.call::<DaemonActivityMethod>(Empty {}).await.unwrap();
        server.abort();

        assert_eq!(live.last_activity(), last_activity, "reading or reconnecting must not refresh the process lifetime");
        let released = fixture.orchestrator.release_idle_sessions(&policy(10, 4), false).await.unwrap();
        assert_eq!(released.len(), 1);
        assert_eq!(closes.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn battery_idle_grace_counts_sleep_time() {
        let fixture = Fixture::new();
        let thread = fixture.thread(ThreadStatus::Idle);
        let started = Instant::now();
        let (live, closes) = fixture.park(&thread, started).await;
        let wall = live.last_activity().wall;
        let before = fixture
            .orchestrator
            .release_idle_sessions_at(&policy(30, 4), true, started, wall + MINUTE - Duration::from_secs(1))
            .await
            .unwrap();
        assert!(before.is_empty());
        let released = fixture.orchestrator.release_idle_sessions_at(&policy(30, 4), true, started, wall + MINUTE).await.unwrap();
        assert_eq!(released, vec![super::SessionRelease { thread_id: thread.id, reason: SessionReleaseReason::Power }]);
        assert_eq!(closes.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn backward_wall_clock_changes_do_not_extend_the_awake_idle_limit() {
        let fixture = Fixture::new();
        let thread = fixture.thread(ThreadStatus::Idle);
        let started = Instant::now();
        let (live, closes) = fixture.park(&thread, started).await;
        let wall = live.last_activity().wall - 60 * MINUTE;
        let early = fixture.orchestrator.release_idle_sessions_at(&policy(10, 4), false, started + 9 * MINUTE, wall).await.unwrap();
        assert!(early.is_empty());
        let released = fixture.orchestrator.release_idle_sessions_at(&policy(10, 4), false, started + 10 * MINUTE, wall).await.unwrap();
        assert_eq!(released.len(), 1);
        assert_eq!(closes.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn activity_during_idle_candidate_selection_keeps_the_session() {
        let fixture = Fixture::new();
        let thread = fixture.thread(ThreadStatus::Idle);
        let started = Instant::now() - 11 * MINUTE;
        let (live, closes) = fixture.park(&thread, started).await;
        let policy = policy(10, 4);
        let turn = live.turn.lock().await;
        let mut sweep = std::pin::pin!(fixture.orchestrator.release_idle_sessions(&policy, false));
        // Stop after snapshotting the map, before checking whether it is parked.
        assert!(futures::poll!(&mut sweep).is_pending());
        let sessions = fixture.orchestrator.inner.sessions.lock().await;
        drop(turn);
        // Finish candidate selection, but block the claim of that candidate.
        assert!(futures::poll!(&mut sweep).is_pending());
        live.touch();
        drop(sessions);
        assert!(sweep.await.unwrap().is_empty());
        assert_eq!(closes.load(Ordering::SeqCst), 0);
        assert!(fixture.has_session(&thread).await);
    }

    #[tokio::test]
    async fn failed_threads_release_like_idle_ones() {
        let fixture = Fixture::new();
        let thread = fixture.thread(ThreadStatus::Failed);
        let started = Instant::now();
        let (_, closes) = fixture.park(&thread, started).await;
        let released =
            fixture.orchestrator.release_idle_sessions_at(&policy(1, 0), false, started + MINUTE, SystemTime::now()).await.unwrap();
        assert_eq!(released.len(), 1);
        assert_eq!(closes.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn sessions_with_work_in_flight_are_never_released() {
        let fixture = Fixture::new();
        let started = Instant::now();
        let later = started + 60 * MINUTE;

        let running = fixture.thread(ThreadStatus::Running);
        let (_, running_closes) = fixture.park(&running, started).await;

        let approving = fixture.thread(ThreadStatus::AwaitingApproval);
        let (_, approving_closes) = fixture.park(&approving, started).await;

        let with_turn = fixture.thread(ThreadStatus::Idle);
        let (turn_live, turn_closes) = fixture.park(&with_turn, started).await;
        *turn_live.turn.lock().await = Some(ActiveTurn {
            response_id: Uuid::now_v7(),
            id: Uuid::now_v7(),
            started,
            startup_started: started,
            provider: ProviderKind::ClaudeCode,
            session_reused: false,
            first_event_observed: false,
            messages: HashMap::new(),
            active_messages: HashMap::new(),
            terminal_message_id: None,
            completed: false,
            pending_completion: None,
        });

        let with_task = fixture.thread(ThreadStatus::Idle);
        let (task_live, task_closes) = fixture.park(&with_task, started).await;
        let now = chrono::Utc::now();
        task_live.tasks.lock().await.insert(
            "agent-1".into(),
            RuntimeTask {
                id: "agent-1".into(),
                thread_id: with_task.id,
                origin_turn_id: Uuid::now_v7(),
                started_seq: 1,
                updated_seq: 1,
                kind: RuntimeTaskKind::Agent,
                status: RuntimeTaskStatus::Running,
                title: "Explore".into(),
                detail: None,
                provider_type: None,
                parent_id: None,
                tool_call_id: None,
                provider_thread_id: None,
                model: None,
                effort: None,
                backgrounded: true,
                last_tool_name: None,
                usage: None,
                stats: RuntimeTaskStats::default(),
                capabilities: RuntimeTaskCapabilities::default(),
                started_at: now,
                updated_at: now,
                completed_at: None,
            },
        );

        let with_approval = fixture.thread(ThreadStatus::Idle);
        let (approval_live, approval_closes) = fixture.park(&with_approval, started).await;
        approval_live.pending.lock().await.insert(Uuid::now_v7(), "req-1".into());

        for (monotonic, wall) in [(later, SystemTime::now()), (started, SystemTime::now() + 60 * MINUTE)] {
            let released = fixture.orchestrator.release_idle_sessions_at(&policy(1, 1), false, monotonic, wall).await.unwrap();
            assert!(released.is_empty(), "neither awake time nor sleep can expire active work");
        }
        for closes in [running_closes, approving_closes, turn_closes, task_closes, approval_closes] {
            assert_eq!(closes.load(Ordering::SeqCst), 0);
        }
        assert_eq!(fixture.orchestrator.inner.sessions.lock().await.len(), 5);
        let activity = fixture.orchestrator.session_activity().await.unwrap();
        assert_eq!(activity, super::SessionActivity { live: 5, idle: 0 });
    }

    #[tokio::test]
    async fn warm_cap_releases_the_least_recently_used_sessions_first() {
        let fixture = Fixture::new();
        let started = Instant::now();
        let oldest = fixture.thread(ThreadStatus::Idle);
        let middle = fixture.thread(ThreadStatus::Idle);
        let newest = fixture.thread(ThreadStatus::Idle);
        let (_, oldest_closes) = fixture.park(&oldest, started).await;
        let (_, middle_closes) = fixture.park(&middle, started + MINUTE).await;
        let (_, newest_closes) = fixture.park(&newest, started + 2 * MINUTE).await;

        let released =
            fixture.orchestrator.release_idle_sessions_at(&policy(30, 2), false, started + 3 * MINUTE, SystemTime::now()).await.unwrap();
        assert_eq!(released, vec![super::SessionRelease { thread_id: oldest.id, reason: SessionReleaseReason::Capacity }]);
        assert_eq!(oldest_closes.load(Ordering::SeqCst), 1);
        assert_eq!(middle_closes.load(Ordering::SeqCst), 0);
        assert_eq!(newest_closes.load(Ordering::SeqCst), 0);
        assert_eq!(fixture.release_events(&oldest), vec![SessionReleaseReason::Capacity]);

        // Expired sessions do not count against the cap; both rules apply in one pass.
        let released =
            fixture.orchestrator.release_idle_sessions_at(&policy(2, 1), false, started + 4 * MINUTE, SystemTime::now()).await.unwrap();
        let mut reasons: Vec<_> = released.iter().map(|r| (r.thread_id, r.reason)).collect();
        reasons.sort_by_key(|(thread_id, _)| *thread_id);
        let mut expected = vec![(middle.id, SessionReleaseReason::Idle), (newest.id, SessionReleaseReason::Idle)];
        expected.sort_by_key(|(thread_id, _)| *thread_id);
        assert_eq!(reasons, expected);
        assert!(fixture.orchestrator.inner.sessions.lock().await.is_empty());
    }

    #[tokio::test]
    async fn activity_resets_the_idle_window_and_zero_disables_the_limits() {
        let fixture = Fixture::new();
        let thread = fixture.thread(ThreadStatus::Idle);
        let started = Instant::now();
        let (live, closes) = fixture.park(&thread, started).await;

        live.last_activity.lock().unwrap().wall -= 60 * MINUTE;
        live.touch();
        let released =
            fixture.orchestrator.release_idle_sessions_at(&policy(10, 0), false, started + 10 * MINUTE, SystemTime::now()).await.unwrap();
        assert!(released.is_empty(), "a touch just now keeps the session warm");

        let far = started + 24 * 60 * MINUTE;
        let released =
            fixture.orchestrator.release_idle_sessions_at(&policy(0, 0), false, far, SystemTime::now() + 24 * 60 * MINUTE).await.unwrap();
        assert!(released.is_empty(), "zero disables both limits");
        assert_eq!(closes.load(Ordering::SeqCst), 0);
        assert!(fixture.has_session(&thread).await);
    }

    #[tokio::test]
    async fn released_processes_do_not_report_their_exit_as_a_failure() {
        let fixture = Fixture::new();
        let thread = fixture.thread(ThreadStatus::Idle);
        let (live, _) = fixture.park(&thread, Instant::now()).await;
        live.mark_released();
        fixture
            .orchestrator
            .handle_driver_event(thread.id, &live, DriverEvent::Exited { code: Some(1), error: Some("exit code 1".into()) })
            .await
            .unwrap();
        let notices = fixture
            .store
            .events_for_thread(thread.id)
            .unwrap()
            .iter()
            .filter(|event| matches!(event.payload, EventPayload::ProviderNotice { .. }))
            .count();
        assert_eq!(notices, 0);
    }

    #[tokio::test]
    async fn queue_worker_is_woken_and_told_when_to_check_back() {
        let fixture = Fixture::new();
        let running = fixture.thread(ThreadStatus::Running);
        let failed = fixture.thread(ThreadStatus::Failed);

        let orchestrator = fixture.orchestrator.clone();
        let woken = tokio::spawn(async move { orchestrator.queue_changed().await });
        fixture
            .orchestrator
            .enqueue(methods::QueuedMessage { id: Uuid::now_v7(), thread_id: failed.id, message: UserMessage::text("later") })
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), woken).await.expect("enqueue wakes the queue worker").unwrap();

        assert!(!fixture.orchestrator.drain_queues().await.unwrap(), "a failed thread keeps its queue without polling");

        fixture
            .orchestrator
            .enqueue(methods::QueuedMessage { id: Uuid::now_v7(), thread_id: running.id, message: UserMessage::text("next") })
            .unwrap();
        assert!(fixture.orchestrator.drain_queues().await.unwrap(), "a busy thread's follow-up dispatches soon");
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn omp_processes_inherit_project_profiles_and_resume_with_the_original_profile() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::with_drivers(DriverRegistry::with_defaults());
        let binary = fixture.root.join("fake-omp");
        let capture = fixture.root.join("launches.jsonl");
        std::fs::write(
            &binary,
            r#"#!/usr/bin/env python3
import json, os, sys
with open(os.environ['PROFILE_CAPTURE'], 'a') as f:
    f.write(json.dumps({'profile': os.environ.get('OMP_PROFILE'), 'cwd': os.getcwd(), 'args': sys.argv[1:]}) + '\n')
print(json.dumps({'type': 'ready'}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    data = {'sessionId': 'provider-session', 'isStreaming': False} if request['type'] == 'get_state' else {}
    print(json.dumps({'id': request.get('id'), 'type': 'response', 'command': request['type'], 'success': True, 'data': data}), flush=True)
"#,
        )
        .unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let settings_store = &fixture.orchestrator.inner.settings;
        let mut settings = settings_store.get();
        let provider = settings.providers.entry(ProviderKind::Omp).or_default();
        provider.binary = Some(binary.display().to_string());
        provider.env.insert("PROFILE_CAPTURE".into(), capture.display().to_string());
        provider.env.insert("OMP_PROFILE".into(), "global".into());
        provider.project_profiles.insert(fixture.project.path.clone(), "work".into());
        settings_store.set(settings).unwrap();
        let mut thread = fixture.thread_with_provider(ThreadStatus::Idle, ProviderKind::Omp);
        let worktree = fixture.root.join("worktree");
        std::fs::create_dir(&worktree).unwrap();
        thread.cwd = worktree.display().to_string();
        thread.provider_session_id = None;
        let mut expected = vec!["work", "work", "new-profile"];
        for index in 0..3 {
            if index == 1 {
                thread.provider_session_id = Some("provider-session".into());
                let mut settings = settings_store.get();
                settings
                    .providers
                    .get_mut(&ProviderKind::Omp)
                    .unwrap()
                    .project_profiles
                    .insert(fixture.project.path.clone(), "new-profile".into());
                settings_store.set(settings).unwrap();
            }
            if index == 2 {
                thread = fixture.thread_with_provider(ThreadStatus::Idle, ProviderKind::Omp);
                thread.provider_session_id = None;
            }
            let live = fixture.orchestrator.spawn_session(&thread, None).await.unwrap();
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if std::fs::read_to_string(&capture).unwrap_or_default().lines().count() > index {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            live.session.close().await.unwrap();
            let value: serde_json::Value =
                serde_json::from_str(std::fs::read_to_string(&capture).unwrap().lines().last().unwrap()).unwrap();
            assert_eq!(value["profile"], expected.remove(0));
            assert_eq!(std::fs::canonicalize(value["cwd"].as_str().unwrap()).unwrap(), std::fs::canonicalize(&thread.cwd).unwrap());
            assert_eq!(value["args"].as_array().unwrap().iter().any(|arg| arg == "--resume"), index == 1);
        }
    }
}
