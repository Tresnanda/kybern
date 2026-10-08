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

mod accounts;
mod agent_items;
mod delegation;
mod messaging;
mod notes;
mod omp_recovery;
mod subagent_messaging;
mod subagents;
mod tasks;
mod worktrees;

#[derive(Clone)]
pub struct Orchestrator {
    inner: Arc<Inner>,
}

/// A rejected send, before any turn was accepted. Assignment dispatch may retry
/// this condition; provider/startup failures must still surface for inspection.
#[derive(Debug)]
struct ThreadBusy;

impl std::fmt::Display for ThreadBusy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("thread is busy")
    }
}

impl std::error::Error for ThreadBusy {}

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
                    let provider_settings = crate::settings::provider_settings(&settings, kind, cwd.to_str());
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
        let settings = self.inner.settings.get();
        let provider_settings = settings.providers.get(&provider.kind).cloned().unwrap_or_default();
        crate::provider_accounts::environment(&provider_settings, provider.kind, &provider.instance)?;
        let project = self.inner.store.project_get(project_id)?.ok_or_else(|| anyhow!("Project not found."))?;
        if provider.instance != crate::provider_accounts::resolve(&provider_settings, Some(&project.path), None) {
            // The legacy aggregate cache describes the project-default account.
            // It cannot reject a model/effort advertised by a different account.
            return Ok(());
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
        if messaging::permission_rule(&actor, &recipient).is_err() {
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
                        project_id: Some(project.id),
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
        self.subagents_archive_below(thread.id)?;
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
        let permission_mode =
            params.permission_mode.unwrap_or_else(|| default_provider_permission(params.provider.kind, settings.default_permission_mode));
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
            if child.provider.instance != "default"
                && !self
                    .inner
                    .settings
                    .get()
                    .providers
                    .get(&child.provider.kind)
                    .is_some_and(|provider| provider.accounts.contains_key(&child.provider.instance))
            {
                return Err(anyhow!(
                    "Unknown {} provider instance '{}'. Choose a configured account. Put the model selector in child.model, not child.provider.instance.",
                    child.provider.kind,
                    child.provider.instance
                ));
            }
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
                    self.publish_projects();
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
                child.permission_mode = Some(delegation::resolve_child_permission(
                    parent.permission_mode,
                    parent.provider.kind,
                    child.provider.kind,
                    child.permission_mode,
                )?);
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

    async fn start_collaboration_assignment(&self, group: &CollaborationGroup, assignment: &mut CollaborationAssignment) -> Result<bool> {
        let owner = if let Some(owner) = assignment.owner_thread_id {
            owner
        } else {
            let child = assignment.requested_child.clone().ok_or_else(|| anyhow!("pending assignment has no owner request"))?;
            let project = self.inner.store.project_get(group.project_id)?.ok_or_else(|| anyhow!("project not found"))?;
            let thread = self
                .create_thread(methods::ThreadsCreateParams {
                    project_id: Some(group.project_id),
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
            self.set_thread_relationships(
                thread.id,
                Some(assignment.created_by_thread_id.unwrap_or(group.coordinator_thread_id)),
                None,
                Some(group.id),
            )?;
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
        if let Err(error) = self.send_with_id(owner, message_id, self.assignment_prompt(group, assignment)?, false, false).await {
            if error.is::<ThreadBusy>() {
                // A direct send can win after the scheduler's availability check.
                // No turn was accepted, so retain the owner and retry the pending
                // assignment rather than stranding it or creating another child.
                assignment.status = AssignmentStatus::Pending;
                assignment.dispatch_message_id = None;
                assignment.uncertainty = None;
                assignment.revision += 1;
                assignment.updated_at = Utc::now();
                self.inner.store.collaboration_assignment_put(assignment)?;
                return Ok(false);
            }
            return Err(error);
        }
        Ok(true)
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
            if matches!(name, "kybern_html_preview" | "kybern_html_publish") {
                anyhow::ensure!(serde_json::to_vec(&arguments)?.len() <= 768 * 1024, "HTML tool arguments exceed 768 KiB.");
                if name == "kybern_html_preview" {
                    let mut object = arguments.as_object().cloned().ok_or_else(|| anyhow!("HTML arguments must be an object"))?;
                    anyhow::ensure!(!object.contains_key("thread_id"), "HTML tools are bound to the current thread.");
                    object.insert("thread_id".into(), serde_json::json!(thread_id));
                    let params = crate::app_tools::parse(serde_json::Value::Object(object))?;
                    let result = crate::visuals::preview(&self.inner.paths, params).await?;
                    let metadata = serde_json::json!({"width": result.width, "contentHeight":result.content_height,"capturedHeight":result.captured_height,"consoleMessages":result.console_messages,"missingImages":result.missing_images});
                    return Ok(
                        serde_json::json!({"_kybern_content":[{"type":"text","text":metadata.to_string()},{"type":"image","mimeType":"image/png","data":result.screenshot}]}),
                    );
                }
                let mut object = arguments.as_object().cloned().ok_or_else(|| anyhow!("HTML arguments must be an object"))?;
                anyhow::ensure!(!object.contains_key("thread_id"), "HTML tools are bound to the current thread.");
                object.insert("thread_id".into(), serde_json::json!(thread_id));
                let params: methods::HtmlPublishParams = crate::app_tools::parse(serde_json::Value::Object(object))?;
                let event = crate::visuals::publish(
                    &self.inner.store,
                    &self.inner.paths,
                    thread_id,
                    turn_id,
                    &params.html,
                    &params.title,
                    params.height,
                )
                .await?;
                let EventPayload::HtmlPublished { visual } = &event.payload else { unreachable!() };
                let result = serde_json::json!({"visual":visual,"message":"The visual is published inline. Add only what the page does not already explain."});
                let _ = self.inner.events.send(event);
                return Ok(result);
            }
            if name == crate::previews::agent::TOOL {
                let roots = crate::previews::thread_roots(&self.inner.store, &thread);
                let policy = crate::previews::GrantPolicy::new(&self.inner.paths.root);
                let settings = self.inner.settings.get();
                let clients = self.inner.preview_requests.receiver_count();
                let outcome = crate::previews::agent::open(thread_id, &roots, &settings, &policy, arguments, clients)?;
                if let Some(notification) = outcome.notify {
                    let _ = self.inner.preview_requests.send(notification);
                }
                return Ok(outcome.result);
            }
            if crate::computer::ComputerUse::is_tool(name) {
                let consent = ComputerConsent { orchestrator: self, thread_id, turn_id, live: live.clone() };
                let ctx = crate::computer::CallContext {
                    thread_id,
                    permission_mode: thread.permission_mode,
                    session_instance_id,
                    turn_id,
                    consent: &consent,
                };
                return self.inner.computer.execute(ctx, name, arguments).await;
            }
            if agent_items::is_tool(name) {
                return self.execute_notes_tasks_tool(&thread, turn_id, &live, name, arguments).await;
            }
            if delegation::is_tool(name) {
                return self.execute_agent_tool(&thread, turn_id, &live, name, arguments).await;
            }
            if messaging::is_tool(name) {
                return self.execute_messaging_tool(&thread, turn_id, &live, name, arguments).await;
            }
            if name.starts_with("kybern_collaboration_") && !self.collaboration_tools_enabled(&thread)? {
                return Err(anyhow!(
                    "The kybern_collaboration_* tools are only for project coordinators and their workers. To hand work to another agent use kybern_agent_delegate; to message another thread use kybern_thread_send."
                ));
            }
            if name.starts_with("kybern_collaboration_") {
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
                let group_id = if name == "kybern_collaboration_send" {
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
                    "kybern_collaboration_send" => {
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
                if let Some(owner) = assignment.owner_thread_id
                    && let Some(thread) = self.inner.store.thread_get(owner)?
                    && (matches!(thread.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval)
                        || (thread.status != ThreadStatus::Archived
                            && self.inner.store.runtime_tasks_for_thread(owner)?.iter().any(|task| task.status.is_active())))
                {
                    // Reporting an assignment can finish before the native turn
                    // or its background tasks settle. Do not consume a worker
                    // slot or publish repeated state changes while it is busy.
                    waiting = true;
                    continue;
                }
                if slots == 0 {
                    waiting = true;
                    break;
                }
                let dispatched = match self.start_collaboration_assignment(&group, assignment).await {
                    Ok(dispatched) => dispatched,
                    Err(error) => {
                        assignment.status = AssignmentStatus::AttentionNeeded;
                        assignment.uncertainty = Some(format!("could not start assignment: {error}"));
                        assignment.revision += 1;
                        assignment.updated_at = Utc::now();
                        self.inner.store.collaboration_assignment_put(assignment)?;
                        false
                    }
                };
                self.emit_collaboration(group.id, EventPayload::CollaborationAssignmentUpdated { assignment: assignment.clone() })?;
                if dispatched {
                    slots -= 1;
                } else if assignment.status == AssignmentStatus::Pending {
                    waiting = true;
                }
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

type RetainedSessions = HashMap<(ThreadId, String), (ProviderInstance, Arc<LiveSession>)>;

struct Inner {
    commands: std::sync::Mutex<()>,
    session_admission: Mutex<HashMap<ThreadId, Arc<Mutex<()>>>>,
    workspace_ops: Mutex<()>,
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
    computer: crate::computer::ComputerUse,
    sessions: Mutex<HashMap<ThreadId, Arc<LiveSession>>>,
    retained_sessions: Mutex<RetainedSessions>,
    releasing: Mutex<HashMap<ThreadId, tokio::sync::watch::Receiver<()>>>,
    harness_gates: HashMap<ProviderKind, Arc<tokio::sync::RwLock<()>>>,
    /// Threads whose next session must fork the provider conversation at this point.
    pending_rewinds: Mutex<HashMap<ThreadId, RewindPoint>>,
    /// Woken whenever a queued follow-up may have become dispatchable, so the
    /// queue worker sleeps instead of polling the store.
    queue_wakeup: Notify,
    collaboration_wakeup: Notify,
    /// Note changes, forwarded to clients as `notes.changed`.
    notes_changed: tokio::sync::broadcast::Sender<methods::NotesChangedNotification>,
    /// Task changes, forwarded to clients as `tasks.items.changed`.
    tasks_changed: tokio::sync::broadcast::Sender<methods::TaskItemsChangedNotification>,
    /// The project list after each change, forwarded as `projects.changed`.
    projects_changed: tokio::sync::broadcast::Sender<methods::ProjectsChangedNotification>,
    /// Agent requests to show a page, forwarded as `previews.open_requested`.
    preview_requests: tokio::sync::broadcast::Sender<methods::PreviewOpenRequestedNotification>,
    /// Preview tickets, revoked when a thread is archived.
    previews: Arc<crate::previews::tickets::PreviewTickets>,
    /// Account plan limits per provider, forwarded as `usage.limits.changed`.
    usage: crate::usage::UsageMonitor,
    /// Serializes task writes, including the run tracker that `emit` calls.
    /// Always taken after `commands` when both are needed.
    task_writes: std::sync::Mutex<()>,
    /// Threads that are a task's run, so `emit` skips the store for every other thread.
    task_threads: std::sync::Mutex<HashSet<ThreadId>>,
    /// When a run's task was last published, to space out activity-only updates.
    task_published: std::sync::Mutex<HashMap<ThreadId, Instant>>,
    /// Agent notes-and-tasks grants and per-turn task counts.
    agent_items: std::sync::Mutex<agent_items::AgentItemState>,
    /// Serializes agent notes-and-tasks writes with their operation receipts.
    agent_item_ops: Mutex<()>,
    /// Routing state for the read-only child threads of provider subagents.
    subagents: std::sync::Mutex<subagents::SubagentRouter>,
    /// Orchestrator V2 delegation engine state (batches, waiters).
    delegation: delegation::DelegationState,
    /// Orchestrator V2 messaging engine state (blocked askers, owed answers, edit guards).
    messaging: messaging::MessagingState,
}

struct LiveSession {
    /// Daemon-local identity for one spawned process. Native tool credentials bind to it.
    session_instance_id: Uuid,
    session: Box<dyn AgentSession>,
    /// Whether this process was spawned with the computer-use tools.
    computer_tools: bool,
    /// Last moment the user or the provider touched this session. Idle
    /// release is measured from here.
    last_activity: std::sync::Mutex<SessionActivityTime>,
    /// Set once the daemon decided to close this process on purpose, so the
    /// provider's exit is not reported as a failure.
    released: AtomicBool,
    /// Owns outgoing background services; root responses cannot re-enter the thread.
    retained: AtomicBool,
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
    /// Raw harness ids may repeat across accounts/processes. Only colliding ids
    /// acquire a public namespace; native controls translate back to their owner.
    task_aliases: Mutex<HashMap<String, String>>,
    /// Parent turns whose after-checkpoint waits for launched work to settle.
    deferred_checkpoints: Mutex<HashSet<TurnId>>,
    /// Approval id -> provider request id, for pending permission requests.
    pending: Mutex<HashMap<ApprovalId, String>>,
    /// Approvals the daemon asks for itself (computer use). They resolve here
    /// instead of in the provider, and keep their answer until the turn ends
    /// so a tool call retried after a slow answer sees it.
    daemon_approvals: Mutex<HashMap<ApprovalId, DaemonApproval>>,
    /// In-flight internal tool request ids. A bounded semaphore prevents one
    /// provider session from monopolizing daemon read work.
    app_tool_requests: Mutex<HashSet<String>>,
    app_tool_permits: Arc<Semaphore>,
}

struct DaemonApproval {
    turn_id: TurnId,
    key: String,
    decision: tokio::sync::watch::Sender<Option<ApprovalDecision>>,
    /// The operation that used this card's one-time answer. Only a retry of that
    /// operation may reuse the card; any other call with the same key opens a new one.
    consumed_by: Option<Uuid>,
}

/// How a daemon-owned approval card was answered.
enum DaemonAnswer {
    Decided(ApprovalDecision),
    /// The turn ended (and denied the card) before the user answered.
    TurnEnded,
    /// No answer within the wait; the card stays open for a retry.
    Pending,
}

impl Orchestrator {
    /// The copy of a user message a provider receives. Kybern-only mentions become
    /// text: `@Computer` an instruction, a `kybern://note/<id>` mention the note, a
    /// `kybern://task/<id>` mention the task.
    /// Everything else passes through unchanged; the stored message keeps the chips.
    fn provider_message<'a>(&self, message: &'a UserMessage, live: &LiveSession) -> std::borrow::Cow<'a, UserMessage> {
        let computer = crate::computer::ComputerUse::expand_mention(message, live.computer_tools);
        match self.expand_item_mentions(computer.as_ref().unwrap_or(message)) {
            Some(expanded) => std::borrow::Cow::Owned(expanded),
            None => match computer {
                Some(expanded) => std::borrow::Cow::Owned(expanded),
                None => std::borrow::Cow::Borrowed(message),
            },
        }
    }
}

/// Computer-use consent for one tool call, bound to its owning turn.
struct ComputerConsent<'a> {
    orchestrator: &'a Orchestrator,
    thread_id: ThreadId,
    turn_id: TurnId,
    live: Arc<LiveSession>,
}

impl crate::computer::ConsentGate for ComputerConsent<'_> {
    fn ask(&self, request: crate::computer::ConsentRequest) -> futures::future::BoxFuture<'_, Result<crate::computer::ConsentAnswer>> {
        Box::pin(self.orchestrator.ask_computer_consent(self.thread_id, self.turn_id, &self.live, request))
    }

    fn cancelled(&self) -> futures::future::BoxFuture<'_, bool> {
        Box::pin(async move {
            self.live.is_released() || self.live.turn.lock().await.as_ref().is_none_or(|turn| turn.id != self.turn_id || turn.completed)
        })
    }
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
        let computer = crate::computer::ComputerUse::new(settings.clone());
        let usage = crate::usage::UsageMonitor::new(store.clone(), settings.clone());
        let task_threads = store.task_run_thread_ids().map(|ids| ids.into_iter().collect::<HashSet<_>>()).unwrap_or_else(|error| {
            tracing::warn!(%error, "could not load the threads that run tasks");
            HashSet::new()
        });
        Self {
            inner: Arc::new(Inner {
                commands: std::sync::Mutex::new(()),
                session_admission: Mutex::new(HashMap::new()),
                workspace_ops: Mutex::new(()),
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
                computer,
                sessions: Mutex::new(HashMap::new()),
                retained_sessions: Mutex::new(HashMap::new()),
                releasing: Mutex::new(HashMap::new()),
                harness_gates: ProviderKind::ALL.into_iter().map(|kind| (kind, Arc::new(tokio::sync::RwLock::new(())))).collect(),
                pending_rewinds: Mutex::new(HashMap::new()),
                queue_wakeup: Notify::new(),
                collaboration_wakeup: Notify::new(),
                notes_changed: tokio::sync::broadcast::channel(1024).0,
                tasks_changed: tokio::sync::broadcast::channel(1024).0,
                projects_changed: tokio::sync::broadcast::channel(64).0,
                preview_requests: tokio::sync::broadcast::channel(64).0,
                previews: Arc::default(),
                usage,
                task_writes: std::sync::Mutex::new(()),
                task_threads: std::sync::Mutex::new(task_threads),
                task_published: std::sync::Mutex::new(HashMap::new()),
                agent_items: std::sync::Mutex::new(Default::default()),
                agent_item_ops: Mutex::new(()),
                subagents: std::sync::Mutex::new(Default::default()),
                delegation: Default::default(),
                messaging: Default::default(),
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

    pub fn with_previews(mut self, previews: Arc<crate::previews::tickets::PreviewTickets>) -> Self {
        Arc::get_mut(&mut self.inner).expect("preview tickets must be installed before cloning the orchestrator").previews = previews;
        self
    }

    /// Agent requests to show a page, for forwarding to connected clients.
    pub fn subscribe_preview_requests(&self) -> tokio::sync::broadcast::Receiver<methods::PreviewOpenRequestedNotification> {
        self.inner.preview_requests.subscribe()
    }

    pub fn with_native_tools(mut self, native_tools: crate::native_tools_mcp::NativeToolsGateway) -> Self {
        Arc::get_mut(&mut self.inner).expect("native tools must be installed before cloning the orchestrator").native_tools =
            Some(native_tools);
        self
    }

    pub(crate) fn computer(&self) -> &crate::computer::ComputerUse {
        &self.inner.computer
    }

    pub(crate) fn usage(&self) -> &crate::usage::UsageMonitor {
        &self.inner.usage
    }

    fn revoke_native_session(&self, live: &LiveSession) {
        if let Err(error) = self.fail_session_subagent_messages(live.session_instance_id) {
            tracing::warn!(%error, "Unable to settle the closed native child inbox");
        }
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
        self.fail_all_subagent_messages("Not delivered — native session ended before delivery could be confirmed.")?;
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
                self.emit(t.id, Some(task.origin_turn_id), EventPayload::RuntimeTaskCompleted { task: task.clone() })?;
                if t.subagent.is_none()
                    && let Err(error) = self.subagent_sync(t.id, &task, None)
                {
                    tracing::warn!(thread_id = %t.id, task_id = %task.id, %error, "could not settle the subagent thread");
                }
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
            // A restart is not the agent's failure: end the turn as interrupted and
            // leave the thread idle so its queue keeps draining.
            self.emit(
                t.id,
                last_turn,
                EventPayload::TurnCompleted {
                    stop_reason: StopReason::Interrupted,
                    usage: Usage::default(),
                    cost_usd: None,
                    duration_ms: 0,
                    terminal_message_id: None,
                },
            )?;
            self.emit(
                t.id,
                last_turn,
                EventPayload::ProviderNotice {
                    level: NoticeLevel::Warning,
                    text: "Kybern restarted while this turn was running. Send a message to continue.".into(),
                    data: None,
                },
            )?;
            t.status = ThreadStatus::Idle;
            self.update_thread(t)?;
        }
        self.delegation_recover_after_restart()?;
        self.messaging_recover_after_restart().await?;
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
        let mut sessions: Vec<_> = self.inner.sessions.lock().await.drain().collect();
        sessions.extend(self.inner.retained_sessions.lock().await.drain().map(|((thread_id, _), (_, live))| (thread_id, live)));
        for (_, live) in &sessions {
            live.mark_released();
            self.revoke_native_session(live);
        }
        let _ = futures::future::join_all(sessions.iter().map(|(_, live)| live.session.close())).await;
        self.inner.computer.shutdown().await;
    }

    // ---- persistence helpers ----

    pub(crate) fn emit(&self, thread_id: ThreadId, turn_id: Option<TurnId>, payload: EventPayload) -> Result<ThreadEvent> {
        let collaboration_failure = match &payload {
            EventPayload::TurnFailed { error } => Some(error.clone()),
            _ => None,
        };
        // For a task run's thread the task lock spans the append and the task update,
        // so its events reach the task in the order they were stored.
        let task_order = self.task_event_guard(thread_id, &payload);
        let ev = self.inner.store.event_append(thread_id, turn_id, payload)?;
        if matches!(
            ev.payload,
            EventPayload::MessageQueued { .. } | EventPayload::ThreadUpdated { .. } | EventPayload::RuntimeTaskCompleted { .. }
        ) {
            self.inner.queue_wakeup.notify_one();
        }
        let _ = self.inner.events.send(ev.clone());
        if task_order.is_some() {
            self.track_task_run(&ev);
        }
        drop(task_order);
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

    fn update_thread(&self, thread: Thread) -> Result<Thread> {
        let _updates = self.inner.thread_updates.lock().map_err(|_| anyhow!("thread update lock poisoned"))?;
        self.write_thread_update(thread, true)
    }

    /// Persist and publish a thread. The caller holds `thread_updates`. With
    /// `keep_stored_delegation` a stale copy cannot roll a delegation back:
    /// only [`Orchestrator::delegation_update`] changes it.
    fn write_thread_update(&self, mut thread: Thread, keep_stored_delegation: bool) -> Result<Thread> {
        if let Some(current) = self.inner.store.thread_get(thread.id)? {
            // A late provider completion must not unarchive a thread and allow the
            // daemon queue worker to resume it while its session is being closed.
            if current.status == ThreadStatus::Archived {
                thread.status = ThreadStatus::Archived;
            }
            if keep_stored_delegation {
                thread.delegation = current.delegation;
            }
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
                self.publish_projects();
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
            task_prefix: None,
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
        self.publish_projects();
        // The store assigns the task prefix on insert; return the project as stored.
        Ok(self.inner.store.project_get(project.id)?.unwrap_or(project))
    }

    /// Changes to the project list, for forwarding to connected clients.
    pub fn subscribe_projects(&self) -> tokio::sync::broadcast::Receiver<methods::ProjectsChangedNotification> {
        self.inner.projects_changed.subscribe()
    }

    /// Tell clients the project list changed. Each notification carries the whole
    /// list, so a client that misses one catches up with the next.
    pub fn publish_projects(&self) {
        match self.inner.store.projects_list() {
            // No receivers just means no client is connected.
            Ok(projects) => {
                let _ = self.inner.projects_changed.send(methods::ProjectsChangedNotification { projects });
            }
            Err(error) => tracing::warn!(%error, "could not read projects to announce a change"),
        }
    }

    // ---- threads ----

    pub async fn resume_external_session(&self, params: methods::SessionsResumeParams) -> Result<Thread> {
        let settings = self.inner.settings.get();
        let source_project =
            params.project_id.map(|id| self.inner.store.project_get(id)?.ok_or_else(|| anyhow!("Project not found"))).transpose()?;
        let raw_provider = settings.providers.get(&params.provider).cloned().unwrap_or_default();
        let instance = crate::provider_accounts::resolve(&raw_provider, source_project.as_ref().map(|project| project.path.as_str()), None);
        let existing = self.inner.store.threads_list(None, true)?.into_iter().find(|thread| {
            thread.provider.kind == params.provider
                && thread.provider.instance == instance
                && thread.provider_session_id.as_deref() == Some(params.session_id.as_str())
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
            provider: ProviderInstance { kind: session.provider, instance: instance.clone() },
            permission_mode: if session.id.starts_with("cursor-sdk:") {
                default_provider_permission(session.provider, settings.default_permission_mode)
            } else {
                settings.default_permission_mode
            },
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
            subagent: None,
            delegation: None,
        };
        let store = self.inner.store.clone();
        let (mut thread, events) = tokio::task::spawn_blocking(move || store.thread_import(thread, history.events)).await??;
        // Imported native ids belong to the discovery account, even if global
        // defaults change later or the session cwd uses a different project.
        self.inner.store.meta_set(&format!("account_override:{}", thread.id), &instance)?;
        self.save_account_binding(&thread)?;
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
        let free_chat = params.project_id.is_none();
        let mut project = match params.project_id {
            Some(project_id) => self.inner.store.project_get(project_id)?.ok_or_else(|| anyhow!("project not found"))?,
            None => self.ensure_free_chat_project()?,
        };
        let settings = self.inner.settings.get();
        let configured_model = settings.providers.get(&params.provider.kind).and_then(|provider| provider.model.clone());
        let selected_model = params.model.as_deref().or(configured_model.as_deref());
        self.validate_provider_selection(project.id, &params.provider, selected_model, params.effort.as_deref()).await?;
        if free_chat && (params.use_worktree == Some(true) || params.base_branch.is_some()) {
            return Err(anyhow!("free chats cannot use a worktree or branch"));
        }
        let use_worktree =
            if free_chat { false } else { params.use_worktree.or(project.worktrees_default).unwrap_or(settings.worktrees_default) };
        if use_worktree && !project.is_git {
            // Re-probe a stale cached flag before refusing (see `project_path_is_git`);
            // a folder `git init`-ed after registration must still support worktrees.
            if project_path_is_git(&project.path) {
                project.is_git = true;
                project.updated_at = Utc::now();
                self.inner.store.project_update(&project)?;
                self.publish_projects();
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
            permission_mode: params
                .permission_mode
                .unwrap_or_else(|| default_provider_permission(params.provider.kind, settings.default_permission_mode)),
            provider: params.provider,
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
            subagent: None,
            delegation: None,
        };
        self.inner.store.thread_upsert(&thread)?;
        if thread.provider.instance != "default" {
            self.inner.store.meta_set(&format!("account_override:{}", thread.id), &thread.provider.instance)?;
        }

        let ev = self.emit(thread.id, None, EventPayload::ThreadCreated { thread: thread.clone() })?;
        let mut thread = Thread { last_seq: ev.seq, ..thread };
        self.inner.store.thread_upsert(&thread)?;
        if let Some(message) = params.message {
            self.send(thread.id, message).await?;
            thread = self.inner.store.thread_get(thread.id)?.unwrap_or(thread);
        }
        Ok(thread)
    }

    fn ensure_free_chat_project(&self) -> Result<Project> {
        if let Some(project) = self.inner.store.project_get(FREE_CHAT_PROJECT_ID)? {
            return Ok(project);
        }
        let path = self.inner.paths.root.join("free-chat");
        std::fs::create_dir_all(&path)?;
        let now = Utc::now();
        let project = Project {
            id: FREE_CHAT_PROJECT_ID,
            name: "Free chats".into(),
            path: path.to_string_lossy().into_owned(),
            is_git: false,
            worktrees_default: Some(false),
            task_prefix: None,
            created_at: now,
            updated_at: now,
        };
        match self.inner.store.project_insert(&project) {
            Ok(()) => {
                self.publish_projects();
                Ok(project)
            }
            Err(error) => self.inner.store.project_get(FREE_CHAT_PROJECT_ID)?.ok_or(error),
        }
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
        if t.subagent.is_some() {
            return Err(anyhow!(subagents::READ_ONLY_ERROR));
        }
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

    /// Archive a thread and, with it, every agent it delegated work to. Running
    /// children are stopped first; delegated worktrees are removed when safe.
    pub async fn archive_thread(&self, thread_id: ThreadId) -> Result<()> {
        let thread = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("thread not found"))?;
        if thread.coordinator_project_id.is_some() {
            return Err(anyhow!("Use Delete coordinator to remove a project coordinator, or pause its agents temporarily."));
        }
        // The parent goes first (flagged, then archived with its session closed) so
        // it cannot delegate more; then the cascade, rescanned until nothing runs.
        let _stopping = self.delegation_flag_stopping(thread_id);
        self.delegation_creation_barrier(thread_id).await;
        self.delegation_mark_cancelled(thread_id, true)?;
        self.archive_single(thread_id).await?;
        self.delegation_stop_descendants(thread_id).await;
        let descendants = self.delegation_descendants(thread_id)?;
        for descendant in &descendants {
            if descendant.status != ThreadStatus::Archived
                && let Err(error) = self.archive_single(descendant.id).await
            {
                tracing::warn!(thread_id = %descendant.id, %error, "could not archive a delegated agent");
            }
        }
        for id in descendants.iter().map(|descendant| descendant.id).chain([thread_id]) {
            self.delegation_cleanup_on_archive(id).await;
        }
        self.cleanup_eligible_worktrees().await;
        Ok(())
    }

    async fn archive_single(&self, thread_id: ThreadId) -> Result<()> {
        {
            let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
            let mut t = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("thread not found"))?;
            if t.coordinator_project_id.is_some() {
                return Err(anyhow!("Use Delete coordinator to remove a project coordinator, or pause its agents temporarily."));
            }
            t.status = ThreadStatus::Archived;
            self.update_thread(t)?;
            self.inner.previews.revoke_thread(thread_id);
            self.emit(thread_id, None, EventPayload::ThreadArchived)?;
            self.subagents_archive_below(thread_id)?;
        }
        self.close_retained_sessions(thread_id).await?;
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
        let _workspace = self.inner.workspace_ops.lock().await;
        let admission_gate = self.session_admission(thread_id).await;
        let _admission = admission_gate.lock().await;
        let current = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("Thread not found."))?;
        let target = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("thread not found"))?;
        self.restore_worktree_if_cleaned(&target).await?;
        if target.subagent.is_some() {
            return Err(anyhow!(subagents::READ_ONLY_ERROR));
        }
        let selected_target = if queued {
            self.inner
                .store
                .meta_get(&format!("queue_target:{message_id}"))?
                .map(|s| serde_json::from_str(&s))
                .transpose()?
                .unwrap_or(self.thread_target(thread_id)?.target)
        } else {
            self.inner
                .store
                .meta_get(&format!("quota_target:{message_id}"))?
                .or(self.inner.store.meta_get(&format!("steer_target:{message_id}"))?)
                .map(|saved| serde_json::from_str(&saved))
                .transpose()?
                .unwrap_or(self.thread_target(thread_id)?.target)
        };
        let selected_mode = if queued {
            self.inner.store.meta_get(&format!("queue_permission:{message_id}"))?.map(|saved| serde_json::from_str(&saved)).transpose()?
        } else {
            self.inner
                .store
                .meta_get(&format!("steer_permission:{message_id}"))?
                .map(|saved| serde_json::from_str(&saved))
                .transpose()?
                .or(self.pending_permission_for(&current, &selected_target.provider)?)
        };
        if selected_target.provider == current.provider
            && !matches!(current.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval)
            && let Some(mode) = selected_mode
            && mode != current.permission_mode
        {
            self.apply_permission_admitted(thread_id, mode).await?;
        }
        let kind = selected_target.provider.kind;
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
            return Err(ThreadBusy.into());
        }
        if thread.status == ThreadStatus::Archived {
            return Err(anyhow!("thread is archived"));
        }
        if thread.delegation.as_ref().is_some_and(|info| info.worktree_state == Some(WorktreeState::Removed)) {
            return Err(delegation::worktree_removed_error());
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
        if let Some(mode) = selected_mode {
            thread.permission_mode = mode;
        }
        self.admit_target(&mut thread, selected_target)?;
        let turn_id = Uuid::now_v7();
        self.inner.store.meta_set(&format!("turn_target:{turn_id}"), &serde_json::to_string(&thread.provider)?)?;
        if thread.title == DEFAULT_TITLE {
            thread.title = title_from_message(&message);
        }
        thread.status = ThreadStatus::Running;
        let thread = self.update_thread(thread)?;
        let startup_started = std::time::Instant::now();
        self.emit(thread.id, Some(turn_id), EventPayload::TurnStarted { message_id, message: message.clone() })?;
        if selected_mode.is_some() && self.pending_permission_for(&thread, &thread.provider)? == selected_mode {
            self.inner.store.meta_set_many(&[
                (&format!("pending_permission:{thread_id}"), ""),
                (&format!("pending_permission_target:{thread_id}"), ""),
            ])?;
        }
        self.messaging_turn_started(thread.id, turn_id, message_id);

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
        if thread.subagent.is_some() {
            return Err(anyhow!(subagents::READ_ONLY_ERROR));
        }
        if thread.status == ThreadStatus::Archived {
            return Err(anyhow!("thread is archived"));
        }
        if let Some(receipt) = self.inner.store.queue_receipt(message.id)? {
            if serde_json::to_value(receipt)? != serde_json::to_value(&message)? {
                return Err(anyhow!("message id already belongs to another request"));
            }
            return Ok(());
        }
        let target = self.thread_target(message.thread_id)?.target;
        let mut receiving = self.inner.store.thread_get(message.thread_id)?.ok_or_else(|| anyhow!("Thread not found."))?;
        let mode = self.pending_permission_for(&receiving, &target.provider)?.unwrap_or(receiving.permission_mode);
        receiving.provider_session_id = self.compatible_native_session(&receiving, &target.provider)?;
        receiving.provider = target.provider.clone();
        accounts::validate_permission(&receiving, mode)?;
        self.inner.store.meta_set_many(&[
            (&format!("queue_target:{}", message.id), &serde_json::to_string(&target)?),
            (&format!("queue_permission:{}", message.id), &serde_json::to_string(&mode)?),
        ])?;
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
        self.messaging_queue_removed(thread_id, id);
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

    /// Deliver new user input within the current native turn. The turn gate also
    /// serializes retries, so a lost RPC reply does not send the prompt twice.
    pub async fn steer(&self, mut params: methods::QueuedMessage) -> Result<methods::ThreadsSendResult> {
        self.ensure_not_subagent(params.thread_id)?;
        let redirect_summary = title_from_message(&params.message);
        self.resolve_attachments(&mut params.message);
        let receipt = || -> Result<Option<methods::ThreadsSendResult>> {
            let Some((thread, turn_id, message)) =
                self.inner.store.steering_receipt(params.id)?.or(self.inner.store.turn_started_receipt(params.id)?)
            else {
                return Ok(None);
            };
            if thread != params.thread_id || serde_json::to_value(message)? != serde_json::to_value(&params.message)? {
                return Err(anyhow!("Message id already belongs to another request."));
            }
            Ok(Some(methods::ThreadsSendResult { turn_id, message_id: params.id }))
        };
        if let Some(result) = receipt()? {
            return Ok(result);
        }
        let thread = self.inner.store.thread_get(params.thread_id)?.ok_or_else(|| anyhow!("Thread not found."))?;
        let target = {
            let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
            let saved = self.inner.store.meta_get(&format!("steer_request:{}", params.id))?;
            if let Some(saved) = saved {
                let original: methods::QueuedMessage = serde_json::from_str(&saved)?;
                anyhow::ensure!(
                    serde_json::to_value(&original)? == serde_json::to_value(&params)?,
                    "Message id already belongs to another steering request."
                );
                serde_json::from_str(
                    &self
                        .inner
                        .store
                        .meta_get(&format!("steer_target:{}", params.id))?
                        .ok_or_else(|| anyhow!("The admitted steering target is missing. Send a new message."))?,
                )?
            } else {
                let target = self.thread_target(thread.id)?.target;
                if target.provider != thread.provider || target.model != thread.model || target.effort != thread.effort {
                    let mode = self.pending_permission_for(&thread, &target.provider)?.unwrap_or(thread.permission_mode);
                    let mut receiving = thread.clone();
                    receiving.provider_session_id = self.compatible_native_session(&thread, &target.provider)?;
                    receiving.provider = target.provider.clone();
                    accounts::validate_permission(&receiving, mode)?;
                    self.inner.store.meta_set_many(&[
                        (&format!("steer_request:{}", params.id), &serde_json::to_string(&params)?),
                        (&format!("steer_target:{}", params.id), &serde_json::to_string(&target)?),
                        (&format!("steer_permission:{}", params.id), &serde_json::to_string(&mode)?),
                    ])?;
                }
                target
            }
        };
        if target.provider != thread.provider || target.model != thread.model || target.effort != thread.effort {
            if matches!(thread.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval) {
                self.interrupt(thread.id).await?;
            }
            for _ in 0..100 {
                if self
                    .inner
                    .store
                    .thread_get(thread.id)?
                    .is_some_and(|t| !matches!(t.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval))
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            return self
                .send_client_message(methods::ThreadsSendParams {
                    thread_id: thread.id,
                    message: params.message,
                    message_id: Some(params.id),
                })
                .await;
        }
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
        live.session.steer(&params.id.to_string(), &self.provider_message(&params.message, &live)).await?;
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
        self.prepare_for_computer(&thread, &message).await;
        let (live, session_reused) = match self.ensure_session(&thread).await {
            Ok(live) => live,
            Err(error) => {
                self.emit(thread.id, Some(turn_id), EventPayload::TurnFailed { error: error.to_string() })?;
                let thread_id = thread.id;
                let mut failed = thread;
                failed.status = ThreadStatus::Failed;
                self.update_thread(failed)?;
                self.delegation_turn_finished(thread_id, turn_id, delegation::TurnOutcome::Failed(error.to_string()));
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

        let mut workspace_transition = None;
        let delivery = if is_compact_message(&message) {
            live.session.compact().await
        } else {
            match self.portable_message(&thread, &message).and_then(|portable| self.workspace_transition_message(&thread, &portable)) {
                Ok((workspace_message, transition)) => {
                    workspace_transition = transition;
                    live.session.send_message(&message_id.to_string(), &self.provider_message(&workspace_message, &live)).await
                }
                Err(error) => Err(kybern_drivers::DriverError::Unsupported(error.to_string())),
            }
        };
        if let Err(e) = delivery {
            self.emit(thread.id, Some(turn_id), EventPayload::TurnFailed { error: e.to_string() })?;
            let thread_id = thread.id;
            let mut t = thread;
            t.status = ThreadStatus::Failed;
            self.update_thread(t)?;
            *live.turn.lock().await = None;
            self.delegation_turn_finished(thread_id, turn_id, delegation::TurnOutcome::Failed(e.to_string()));
            return Err(e.into());
        }
        if !is_compact_message(&message) {
            self.inner.store.meta_set(&format!("handoff:{}", thread.id), "")?;
            if let Some(sequence) = workspace_transition {
                self.workspace_transition_delivered(thread.id, sequence)?;
            }
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
        // Interrupting a subagent thread stops that subagent, not its parent.
        if self.inner.store.thread_get(thread_id)?.is_some_and(|thread| thread.subagent.is_some()) {
            self.stop_runtime_task(thread_id, "").await?;
            return Ok(());
        }
        // The thread is flagged (it cannot delegate any more) and interrupted
        // first, and the cascade over what it delegated runs alongside; a
        // delegated child stopped directly (Lineage Stop) is cancelled and its
        // parent told.
        self.delegation_stop(thread_id, true).await
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
        let (thread_id, task_id) = self.resolve_task_control(thread_id, task_id)?;
        let task_id = task_id.as_str();
        let live = self.task_session(thread_id, task_id).await?;
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
        live.session.stop_runtime_task(&self.native_runtime_task(&live, &task).await).await?;
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
        let (thread_id, task_id) = self.resolve_task_control(thread_id, task_id)?;
        let task_id = task_id.as_str();
        let live = self.task_session(thread_id, task_id).await?;
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
        live.session.background_runtime_task(&self.native_runtime_task(&live, &task).await).await?;
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
        self.ensure_not_subagent(params.thread_id)?;
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
            live.session.steer(&message_id.to_string(), &self.provider_message(&message, &live)).await?;
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
        // Release the map before touching other state; restoring the thread
        // status reads it again.
        let daemon_owned = {
            let approvals = live.daemon_approvals.lock().await;
            match approvals.get(&approval_id) {
                Some(entry) if entry.decision.borrow().is_some() => return Err(anyhow!("approval already resolved")),
                Some(entry) => {
                    entry.decision.send_replace(Some(decision.clone()));
                    true
                }
                None => false,
            }
        };
        if daemon_owned {
            live.touch();
            self.inner.store.approval_resolve(approval_id, &decision)?;
            self.emit(approval.thread_id, Some(approval.turn_id), EventPayload::ApprovalResolved { approval_id, decision })?;
            self.restore_running_after_approval(approval.thread_id, &live).await?;
            return Ok(());
        }
        let mut pending = live.pending.lock().await;
        let request_id = pending.get(&approval_id).cloned().ok_or_else(|| anyhow!("approval no longer pending"))?;
        live.touch();
        live.session.respond_permission(&request_id, &decision).await?;
        pending.remove(&approval_id);
        drop(pending);
        self.inner.store.approval_resolve(approval_id, &decision)?;
        self.emit(approval.thread_id, Some(approval.turn_id), EventPayload::ApprovalResolved { approval_id, decision })?;
        self.restore_running_after_approval(approval.thread_id, &live).await?;
        Ok(())
    }

    async fn restore_running_after_approval(&self, thread_id: ThreadId, live: &LiveSession) -> Result<()> {
        let daemon_waiting = live.daemon_approvals.lock().await.values().any(|entry| entry.decision.borrow().is_none());
        if live.pending.lock().await.is_empty()
            && !daemon_waiting
            && let Some(mut t) = self.inner.store.thread_get(thread_id)?
            && t.status == ThreadStatus::AwaitingApproval
        {
            t.status = ThreadStatus::Running;
            self.update_thread(t)?;
        }
        Ok(())
    }

    /// Ask the user, through a normal approval card, to let this chat control
    /// an app. A retry of the same request in the same turn reuses the card
    /// and its answer.
    async fn ask_computer_consent(
        &self,
        thread_id: ThreadId,
        turn_id: TurnId,
        live: &Arc<LiveSession>,
        request: crate::computer::ConsentRequest,
    ) -> Result<crate::computer::ConsentAnswer> {
        use crate::computer::{ConsentAnswer, Mode};
        let key = format!("{}:{:?}", request.bundle_id.as_deref().unwrap_or(&request.app.to_lowercase()), request.mode);
        let foreground = request.mode == Mode::Foreground;
        let input = serde_json::json!({
            "app": request.app,
            "bundle_id": request.bundle_id,
            "mode": if foreground { "foreground" } else { "background" },
            "action": request.first_action,
        });
        let summary = if foreground {
            format!("Let this chat use your cursor and keyboard in {}", request.app)
        } else {
            format!("Let this chat control {} in the background", request.app)
        };
        let (_, answer) =
            self.ask_daemon_approval(thread_id, turn_id, live, key, crate::computer::APPROVAL_TOOL, input, summary, None).await?;
        Ok(match answer {
            DaemonAnswer::Decided(ApprovalDecision::AllowAlways) => ConsentAnswer::Session,
            DaemonAnswer::Decided(ApprovalDecision::Submit { response })
                if response.get("scope").and_then(serde_json::Value::as_str) == Some("always") =>
            {
                ConsentAnswer::Always
            }
            DaemonAnswer::Decided(ApprovalDecision::Deny { reason }) => ConsentAnswer::Denied(reason),
            DaemonAnswer::Decided(_) => ConsentAnswer::Turn,
            DaemonAnswer::TurnEnded => ConsentAnswer::Denied(Some("the turn ended".into())),
            DaemonAnswer::Pending => ConsentAnswer::Pending,
        })
    }

    /// Open (or, for a retry with the same `key` in the same turn, reuse) a
    /// daemon-owned approval card and wait for the answer. The card resolves in
    /// the daemon, not the provider, and keeps its answer until the turn ends.
    /// A card another `operation` consumed (see [`Self::consume_daemon_approval`])
    /// is not reused. Returns the card's id with the answer.
    #[allow(clippy::too_many_arguments)]
    async fn ask_daemon_approval(
        &self,
        thread_id: ThreadId,
        turn_id: TurnId,
        live: &Arc<LiveSession>,
        key: String,
        tool_name: &str,
        input: serde_json::Value,
        summary: String,
        operation: Option<Uuid>,
    ) -> Result<(ApprovalId, DaemonAnswer)> {
        let (card, mut receiver) = {
            let mut approvals = live.daemon_approvals.lock().await;
            let reusable = approvals.iter().find(|(_, entry)| {
                entry.turn_id == turn_id && entry.key == key && entry.consumed_by.is_none_or(|by| Some(by) == operation)
            });
            match reusable {
                Some((id, entry)) => (*id, entry.decision.subscribe()),
                None => {
                    let approval = ApprovalRequest {
                        id: Uuid::now_v7(),
                        thread_id,
                        turn_id,
                        tool_call_id: None,
                        tool_name: tool_name.into(),
                        input,
                        summary,
                        suggestions: Vec::new(),
                        created_at: Utc::now(),
                    };
                    let (sender, receiver) = tokio::sync::watch::channel(None);
                    let card = approval.id;
                    approvals.insert(card, DaemonApproval { turn_id, key, decision: sender, consumed_by: None });
                    drop(approvals);
                    if let Some(turn) = live.turn.lock().await.as_mut() {
                        turn.active_messages.remove(&EventOrigin::Root);
                    }
                    self.inner.store.approval_insert(&approval)?;
                    self.emit(thread_id, Some(turn_id), EventPayload::ApprovalRequested { approval })?;
                    let mut t = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("thread vanished"))?;
                    if t.status != ThreadStatus::AwaitingApproval {
                        t.status = ThreadStatus::AwaitingApproval;
                        self.update_thread(t)?;
                    }
                    (card, receiver)
                }
            }
        };
        let decision = tokio::time::timeout(crate::computer::CONSENT_WAIT, receiver.wait_for(Option::is_some)).await;
        let answer = match decision {
            Ok(Ok(decision)) => match decision.clone() {
                Some(decision) => DaemonAnswer::Decided(decision),
                None => DaemonAnswer::Pending,
            },
            Ok(Err(_)) => DaemonAnswer::TurnEnded,
            Err(_) => DaemonAnswer::Pending,
        };
        Ok((card, answer))
    }

    /// Spend a card's one-time answer on `operation`. False when another
    /// operation already spent it; a retry of the same operation may spend it again.
    async fn consume_daemon_approval(&self, live: &LiveSession, card: ApprovalId, operation: Uuid) -> Result<bool> {
        let mut approvals = live.daemon_approvals.lock().await;
        let entry = approvals.get_mut(&card).ok_or_else(|| anyhow!("The turn ended before this change was made. Nothing was saved."))?;
        Ok(match entry.consumed_by {
            None => {
                entry.consumed_by = Some(operation);
                true
            }
            Some(by) => by == operation,
        })
    }

    async fn resolve_finished_requests(&self, thread_id: ThreadId, turn_id: TurnId, live: &LiveSession) -> Result<()> {
        let finished: Vec<(ApprovalId, DaemonApproval)> = {
            let mut approvals = live.daemon_approvals.lock().await;
            let ids = approvals.iter().filter(|(_, entry)| entry.turn_id == turn_id).map(|(id, _)| *id).collect::<Vec<_>>();
            ids.into_iter().filter_map(|id| approvals.remove(&id).map(|entry| (id, entry))).collect()
        };
        for (id, entry) in finished {
            if entry.decision.borrow().is_some() {
                continue;
            }
            let decision = ApprovalDecision::Deny { reason: Some("turn ended".into()) };
            entry.decision.send_replace(Some(decision.clone()));
            self.inner.store.approval_resolve(id, &decision)?;
            self.emit(thread_id, Some(turn_id), EventPayload::ApprovalResolved { approval_id: id, decision })?;
        }
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
        // A task's run keeps the task's title.
        if self.inner.task_threads.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).contains(&thread.id) {
            return;
        }
        let Ok((first, turns)) = self.inner.store.first_turn_message_and_count(thread.id) else { return };
        let Some(first) = first else { return };
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
        self.ensure_not_subagent(thread_id)?;
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

    /// `@Computer`: warm the driver, and in a chat whose process started before
    /// computer use was available, close the idle process so this turn resumes
    /// with the tools.
    /// The thread is already Running for this turn, so only the process's own
    /// work counts as busy.
    async fn prepare_for_computer(&self, thread: &Thread, message: &UserMessage) {
        if !crate::computer::ComputerUse::mentions(message)
            || !self.native_tool_restrictions(thread).is_ok_and(|restrictions| self.computer_tools_offered(thread, &restrictions))
        {
            return;
        }
        self.inner.computer.prewarm();
        let live = {
            let mut sessions = self.inner.sessions.lock().await;
            let Some(live) = sessions.get(&thread.id).cloned() else { return };
            if live.computer_tools
                || live.turn.lock().await.is_some()
                || live.tasks.lock().await.values().any(|task| task.status.is_active())
                || !live.pending.lock().await.is_empty()
            {
                return;
            }
            sessions.remove(&thread.id);
            live
        };
        live.mark_released();
        self.revoke_native_session(&live);
        if let Err(error) = live.session.close().await {
            tracing::debug!(%error, thread_id = %thread.id, "closing a session without computer tools failed");
        }
        let _ = self.emit(thread.id, None, EventPayload::ProviderSessionReleased { reason: SessionReleaseReason::Manual });
    }

    async fn ensure_session(&self, thread: &Thread) -> Result<(Arc<LiveSession>, bool)> {
        let expected = self.session_identity(thread)?;
        let current = self.inner.sessions.lock().await.get(&thread.id).cloned();
        if let Some(live) = current {
            let identity = self.inner.store.meta_get(&format!("live_identity:{}", thread.id))?;
            if identity.as_deref().is_none_or(|identity| identity == expected) {
                return Ok((live, true));
            }
            self.retire_or_close_session(thread.id, live, identity.unwrap_or_default()).await?;
        }
        let retained = self.inner.retained_sessions.lock().await.remove(&(thread.id, expected.clone()));
        if let Some((owner, live)) = retained {
            if owner == thread.provider && !live.is_released() {
                live.retained.store(false, Ordering::Relaxed);
                self.inner.sessions.lock().await.insert(thread.id, live.clone());
                self.inner.store.meta_set_many(&[
                    (&format!("live_fingerprint:{}", thread.id), &self.environment_fingerprint(thread)?),
                    (&format!("live_identity:{}", thread.id), &expected),
                    (&format!("live_owner:{}", thread.id), &serde_json::to_string(&thread.provider)?),
                ])?;
                return Ok((live, true));
            }
            live.mark_released();
            self.revoke_native_session(&live);
            live.session.close().await?;
        }
        let waiting = self.inner.releasing.lock().await.get(&thread.id).cloned();
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
        provider_settings.env = self.account_environment(thread)?;
        let mut profile_binding = None;
        if thread.provider.kind == ProviderKind::Omp && thread.provider.instance == "default" {
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
        let computer_tools = self.computer_tools_offered(thread, &restrictions);
        let native_tool_bridge = self
            .inner
            .native_tools
            .as_ref()
            .map(|gateway| {
                let mut tools = crate::app_tools::native_tool_definitions();
                // Ordinary threads delegate with kybern_agent_*; the collaboration
                // tools are for project coordinators and their workers only.
                if !self.collaboration_tools_enabled(thread).unwrap_or(false) {
                    tools.retain(|tool| !tool.name.starts_with("kybern_collaboration_"));
                }
                if self.inner.computer.offered_to(thread.provider.kind) {
                    tools.extend(crate::computer::ComputerUse::tool_definitions());
                }
                let guide = self.agent_guide(&tools, &restrictions);
                gateway.register_coordinator(thread.id, session_instance_id, tools, restrictions, coordinator_instructions, guide)
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
            computer_tools,
            last_activity: std::sync::Mutex::new(SessionActivityTime::now()),
            released: AtomicBool::new(false),
            retained: AtomicBool::new(false),
            stop_cleanup: AtomicBool::new(false),
            turn: Mutex::new(None),
            continuation: Mutex::new(None),
            turn_ready: tokio::sync::Notify::new(),
            last_turn_id: Mutex::new(None),
            tasks: Mutex::new(HashMap::new()),
            task_aliases: Mutex::new(HashMap::new()),
            deferred_checkpoints: Mutex::new(HashSet::new()),
            pending: Mutex::new(HashMap::new()),
            daemon_approvals: Mutex::new(HashMap::new()),
            app_tool_requests: Mutex::new(HashSet::new()),
            app_tool_permits: Arc::new(Semaphore::new(crate::app_tools::MAX_CONCURRENT_REQUESTS)),
        });
        self.inner.store.meta_set_many(&[
            (&format!("live_fingerprint:{}", thread.id), &self.environment_fingerprint(thread)?),
            (&format!("live_identity:{}", thread.id), &self.session_identity(thread)?),
            (&format!("live_owner:{}", thread.id), &serde_json::to_string(&thread.provider)?),
        ])?;
        self.inner.sessions.lock().await.insert(thread.id, live.clone());
        let this = self.clone();
        let thread_id = thread.id;
        let pump_live = live.clone();
        tokio::spawn(async move { this.pump(thread_id, pump_live, events).await });
        Ok(live)
    }

    /// Whether a session spawned now would expose the computer-use tools.
    fn computer_tools_offered(&self, thread: &Thread, restrictions: &kybern_drivers::NativeToolRestrictions) -> bool {
        const PROBE: &str = "kybern_computer_act";
        self.inner.native_tools.is_some()
            && self.inner.computer.offered_to(thread.provider.kind)
            && (restrictions.allowed_tools.is_empty() || restrictions.allowed_tools.iter().any(|tool| tool == PROBE))
            && !restrictions.denied_tools.iter().any(|tool| tool == PROBE)
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
                "kybern_html_preview",
                "kybern_html_publish",
                "kybern_preview_open",
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
                "kybern_notes_search",
                "kybern_note_read",
                "kybern_note_create",
                "kybern_note_append",
                "kybern_note_update",
                "kybern_tasks_list",
                "kybern_task_read",
                "kybern_task_create",
                "kybern_task_update",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
            denied_tools: vec!["kybern_collaboration_report".into()],
            require_enforcement: true,
        })
    }

    /// The "Working in Kybern" guide for a session with these tools, or `None`
    /// when the user turned "Tell agents about Kybern" off.
    fn agent_guide(
        &self,
        tools: &[kybern_drivers::NativeToolDefinition],
        restrictions: &kybern_drivers::NativeToolRestrictions,
    ) -> Option<String> {
        if !self.inner.settings.get().tell_agents_about_kybern {
            return None;
        }
        let names = tools.iter().map(|tool| tool.name.as_str()).filter(|name| restrictions.permits(name));
        let guide = crate::agent_guide::render(&crate::agent_guide::GuideTools::from_names(names));
        tracing::debug!(version = crate::agent_guide::GUIDE_VERSION, bytes = guide.len(), "attaching the Kybern guide to a new session");
        Some(guide)
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
        mut incoming: DriverRuntimeTask,
    ) -> Result<RuntimeTask> {
        let raw_id = incoming.id.clone();
        let alias = live.task_aliases.lock().await.get(&raw_id).cloned();
        if let Some(alias) = alias {
            incoming.id = alias;
        } else if !live.tasks.lock().await.contains_key(&raw_id)
            && self.inner.store.runtime_tasks_for_thread(thread_id)?.iter().any(|task| task.id == raw_id)
        {
            incoming.id = format!("native:{}:{raw_id}", live.session_instance_id);
            live.task_aliases.lock().await.insert(raw_id, incoming.id.clone());
        }
        if let Some(parent) = incoming.parent_id.as_mut() {
            let existing = live.task_aliases.lock().await.get(parent).cloned();
            if let Some(alias) = existing {
                *parent = alias;
            } else if !live.tasks.lock().await.contains_key(parent)
                && self.inner.store.runtime_tasks_for_thread(thread_id)?.iter().any(|task| task.id == *parent)
            {
                // Native child rosters can precede their parent's start frame.
                // Reserve the owning parent's alias before linking the child.
                let alias = format!("native:{}:{parent}", live.session_instance_id);
                live.task_aliases.lock().await.insert(parent.clone(), alias.clone());
                *parent = alias;
            }
        }
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
        if let Err(error) = self.subagent_sync(thread_id, &task, Some(live.session_instance_id)) {
            tracing::warn!(%thread_id, task_id = %task.id, %error, "could not update the subagent thread");
        }
        if !task.status.is_active() {
            self.finish_deferred_checkpoint(thread_id, live, task.origin_turn_id).await?;
        }
        Ok(task)
    }

    async fn apply_runtime_task_update(
        &self,
        thread_id: ThreadId,
        live: &Arc<LiveSession>,
        mut update: DriverRuntimeTaskUpdate,
        kind: RuntimeTaskUpdateKind,
    ) -> Result<Option<RuntimeTask>> {
        if let Some(alias) = live.task_aliases.lock().await.get(&update.id).cloned() {
            update.id = alias;
        }
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
        if let Err(error) = self.subagent_sync(thread_id, &task, Some(live.session_instance_id)) {
            tracing::warn!(%thread_id, task_id = %task.id, %error, "could not update the subagent thread");
        }
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
        let owners = self.inner.retained_sessions.lock().await.values().map(|(_, owner)| owner.clone()).collect::<Vec<_>>();
        let mut retained_ids = HashSet::new();
        for owner in owners {
            retained_ids.extend(owner.tasks.lock().await.keys().cloned());
        }
        let mut tasks = live.tasks.lock().await;
        for task in stored.into_iter().filter(|task| task.status.is_active() && !retained_ids.contains(&task.id)) {
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
        self.inner.retained_sessions.lock().await.retain(|_, (_, current)| !Arc::ptr_eq(current, &live));
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
            self.delegation_turn_finished(
                thread_id,
                turn.id,
                delegation::TurnOutcome::Failed("provider exited before finishing the turn".into()),
            );
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
        if serde_json::to_vec(&arguments).map_or(true, |encoded| encoded.len() > crate::app_tools::argument_limit(&name)) {
            reject_app_tool_request(live, request_id, "tool arguments exceed the size limit for this tool");
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
                let timeout = if name == "kybern_collaboration_wait"
                    || delegation::BLOCKING_TOOLS.contains(&name.as_str())
                    || (name == "kybern_thread_send" && arguments.get("wait_for_reply").and_then(serde_json::Value::as_bool) == Some(true))
                    || matches!(name.as_str(), "kybern_html_preview" | "kybern_html_publish")
                    || crate::computer::ComputerUse::is_tool(&name)
                    || agent_items::WRITE_TOOLS.contains(&name.as_str())
                {
                    Duration::from_secs(65)
                } else {
                    crate::app_tools::REQUEST_TIMEOUT
                };
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
        if live.retained.load(Ordering::Relaxed) {
            return self.handle_retained_event(thread_id, live, ev).await;
        }
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
        if let DriverEvent::SubagentMessageDelivered { task_id, message_id } = &ev {
            self.acknowledge_subagent_message(thread_id, live.session_instance_id, task_id, message_id)?;
            return Ok(());
        }
        // A subagent's own prose and tool calls belong to its child thread and
        // never reach the parent's log or its turn bookkeeping.
        if live.stop_cleanup.load(Ordering::Relaxed) && !retiring {
            return Ok(());
        }
        let Some(ev) = self.subagent_take_event(thread_id, ev)? else { return Ok(()) };
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
            DriverEvent::SubagentMessageDelivered { .. } => unreachable!("handled before root turn bookkeeping"),
            // Consumed by `subagent_take_event` before this point.
            DriverEvent::SubagentPrompt { .. } | DriverEvent::SubagentOnly { .. } => {}
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
                if let Some(mut selected) = self.stored_target(&t)?
                    && selected.provider == t.provider
                    && selected.model.is_none()
                    && model.is_some()
                {
                    selected.model = t.model.clone();
                    self.inner.store.meta_set(&format!("target:{thread_id}"), &serde_json::to_string(&selected)?)?;
                }
                // Native canonical model reports belong to this live binding and must
                // not look like a user-requested reconfiguration on the next send.
                self.inner.store.meta_set(&format!("live_identity:{thread_id}"), &self.session_identity(&t)?)?;
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
            DriverEvent::ThinkingCompleted { message_id, origin } => {
                // Close the reasoning of the message it streamed into. It never
                // opens a message: a late signal after completion has nothing to close.
                let id = turn_guard.as_ref().and_then(|turn| {
                    let active = turn.active_messages.get(&origin)?;
                    (turn.messages.get(&(origin.clone(), message_id)) == Some(active)).then_some(*active)
                });
                if let Some(id) = id {
                    self.emit(thread_id, turn_id, EventPayload::AssistantThinkingCompleted { message_id: id, origin })?;
                }
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
                // The same call also belongs to the subagent that made it, and the
                // prompt of a launching call becomes that subagent's first message.
                if let Some(parent_id) = call.parent_id.as_deref() {
                    self.subagent_mirror_tool_started(thread_id, parent_id, &call)?;
                }
                if let Some(prompt) = json_text(&call.input, &["prompt"])
                    && generic_runtime_task(&call).is_some_and(|task| task.kind == RuntimeTaskKind::Agent)
                {
                    self.subagent_remember_prompt(thread_id, &call.id, &prompt);
                }
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
                self.guard_tool_started(thread_id, provider, &call);
                if let Some(task) = generic_runtime_task_for_provider(provider, &call) {
                    self.persist_runtime_task_start(thread_id, live, turn_id, task).await?;
                }
            }
            DriverEvent::ToolOutputDelta { tool_call_id, delta } => {
                // Preview screenshots belong only to the transient tool transport.
                // A provider may echo its MCP content as a JSON output stream.
                if self.inner.store.tool_call_name(thread_id, &tool_call_id)?.as_deref().is_some_and(crate::visuals::is_preview_tool) {
                    return Ok(());
                }
                if self.subagent_holds_call(thread_id, &tool_call_id) {
                    self.subagent_mirror_tool_event(
                        thread_id,
                        &tool_call_id,
                        DriverEvent::ToolOutputDelta { tool_call_id: tool_call_id.clone(), delta: delta.clone() },
                    )?;
                }
                self.emit(thread_id, turn_id, EventPayload::ToolCallOutputDelta { tool_call_id, delta })?;
            }
            DriverEvent::ToolCompleted { tool_call_id, output, is_error } => {
                if self.subagent_holds_call(thread_id, &tool_call_id) {
                    self.subagent_mirror_tool_event(
                        thread_id,
                        &tool_call_id,
                        DriverEvent::ToolCompleted { tool_call_id: tool_call_id.clone(), output: output.clone(), is_error },
                    )?;
                }
                self.emit(
                    thread_id,
                    turn_id,
                    EventPayload::ToolCallCompleted {
                        tool_call_id: tool_call_id.clone(),
                        output: crate::visuals::persisted_output(
                            self.inner.store.tool_call_name(thread_id, &tool_call_id)?.as_deref(),
                            output.clone(),
                        ),
                        output_omitted: false,
                        stream_recoverable: false,
                        is_error,
                    },
                )?;
                let provider = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("thread vanished"))?.provider.kind;
                if provider == ProviderKind::Cursor {
                    self.guard_tool_completed(thread_id, &tool_call_id, &output);
                }
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
                    live.tasks.lock().await.values().any(|task| {
                        task.origin_turn_id == turn.id
                            && task.kind != RuntimeTaskKind::Monitor
                            && !(task.kind == RuntimeTaskKind::Process && task.backgrounded)
                            && task.status.is_active()
                    })
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
                self.inner.usage.turn_finished(t.provider.kind);
                t.status = ThreadStatus::Idle;
                let t = self.update_thread(t)?;
                self.save_account_binding(&t)?;
                let this = self.clone();
                tokio::spawn(async move {
                    if let Err(error) = this.apply_pending_permission(thread_id, false).await {
                        tracing::warn!(%error, "pending permission change was not applied");
                    }
                });
                self.maybe_generate_title(&t);
                self.delegation_turn_finished(thread_id, turn_id, delegation::TurnOutcome::Completed { stop_reason, terminal_message_id });
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
                self.emit(thread_id, Some(turn_id), EventPayload::TurnFailed { error: error.clone() })?;
                // A failed turn may have hit a plan limit.
                self.inner.usage.turn_finished(t.provider.kind);
                t.status = ThreadStatus::Failed;
                self.update_thread(t)?;
                self.delegation_turn_finished(thread_id, turn_id, delegation::TurnOutcome::Failed(error));
            }
            DriverEvent::CommandsUpdated(commands) => {
                self.emit(thread_id, turn_id, EventPayload::ProviderCommandsUpdated { commands })?;
            }
            DriverEvent::UsageUpdated(usage) => {
                if let Some(context) = &usage.context
                    && let Some(thread) = self.inner.store.thread_get(thread_id)?
                {
                    self.inner.store.meta_set(
                        &format!(
                            "model_context:{}:{}:{}",
                            thread.provider.kind,
                            thread.provider.instance,
                            thread.model.as_deref().unwrap_or("default")
                        ),
                        &context.window_tokens.to_string(),
                    )?;
                }
                // Plan limits are account-wide: every client's limits view
                // updates, not only this thread's.
                if let Some(limits) = usage.limits.as_deref()
                    && let Some(thread) = self.inner.store.thread_get(thread_id)?
                {
                    let admitted = self.inner.store.meta_get(&format!("live_fingerprint:{thread_id}"))?;
                    if admitted
                        .as_deref()
                        .is_none_or(|identity| self.environment_fingerprint(&thread).is_ok_and(|current| current == identity))
                    {
                        self.inner.usage.observe_account(&thread.provider, limits);
                    }
                    self.inner.store.meta_set(
                        &format!("account_usage:{}:{}", thread.provider.kind, thread.provider.instance),
                        &serde_json::to_string(&usage)?,
                    )?;
                }
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

// Cursor SDK cannot implement a human approval mode. New threads without an
// explicit mode use its sandboxed policy; explicit unsupported choices still
// fail at the driver boundary, never silently gain permissions.
fn default_provider_permission(provider: ProviderKind, mode: PermissionMode) -> PermissionMode {
    if provider == ProviderKind::Cursor && !matches!(mode, PermissionMode::Auto | PermissionMode::FullAccess) {
        PermissionMode::Auto
    } else {
        mode
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
    // SDK events already carry the native task lifecycle and nested ownership.
    // Legacy Cursor ACP chats still need the conservative tool-only fallback.
    if provider == ProviderKind::Cursor && call.id.starts_with("cursor-sdk:") {
        return None;
    }
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
    use std::path::PathBuf;
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
        reject_permission: bool,
        stopped_tasks: Arc<Mutex<Vec<String>>>,
    }

    #[async_trait::async_trait]
    impl AgentSession for TestSession {
        async fn send_subagent_message(&self, _task_id: &str, _message_id: &str, _message: &UserMessage) -> kybern_drivers::Result<()> {
            Ok(())
        }

        async fn stop_runtime_task(&self, task: &RuntimeTask) -> kybern_drivers::Result<()> {
            self.stopped_tasks.lock().await.push(task.id.clone());
            Ok(())
        }

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
            if self.reject_permission {
                return Err(kybern_drivers::DriverError::Unsupported("fixture rejects permissions".into()));
            }
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

    #[tokio::test]
    async fn free_chat_uses_a_hidden_neutral_workspace() {
        let root = std::env::temp_dir().join(format!("kybern-free-chat-test-{}", Uuid::now_v7()));
        let paths = Paths::resolve(Some(root.clone())).unwrap();
        let settings = SettingsStore::load(&paths.settings).unwrap();
        let store = Store::open_in_memory().unwrap();
        let (events_tx, _) = crate::bounded_broadcast::channel(32, 8 * 1024 * 1024);
        let orchestrator = Orchestrator::new(store.clone(), DriverRegistry::default(), events_tx, paths, settings);

        let thread = orchestrator
            .create_thread(methods::ThreadsCreateParams {
                project_id: None,
                provider: ProviderInstance::default_for(ProviderKind::Codex),
                model: None,
                effort: None,
                permission_mode: None,
                use_worktree: None,
                base_branch: None,
                title: Some("Free chat".into()),
                message: None,
            })
            .await
            .unwrap();

        assert_eq!(thread.project_id, FREE_CHAT_PROJECT_ID);
        assert_eq!(PathBuf::from(&thread.cwd), root.join("free-chat"));
        assert!(PathBuf::from(&thread.cwd).is_dir());
        assert!(store.projects_list().unwrap().is_empty(), "the neutral workspace is not a user project");
        assert!(store.project_get(FREE_CHAT_PROJECT_ID).unwrap().is_some());
        assert!(store.project_delete(FREE_CHAT_PROJECT_ID).is_err());

        let rejected = orchestrator
            .create_thread(methods::ThreadsCreateParams {
                project_id: None,
                provider: ProviderInstance::default_for(ProviderKind::Codex),
                model: None,
                effort: None,
                permission_mode: None,
                use_worktree: Some(true),
                base_branch: None,
                title: None,
                message: None,
            })
            .await;
        assert!(rejected.is_err());

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
        let sdk_agent = ToolCall { id: "cursor-sdk:r1:tool:agent-1".into(), ..agent };
        assert!(generic_runtime_task_for_provider(ProviderKind::Cursor, &sdk_agent).is_none());
    }

    #[test]
    fn cursor_sdk_defaults_to_its_sandboxed_policy_without_changing_other_providers() {
        use super::default_provider_permission;
        assert_eq!(default_provider_permission(ProviderKind::Cursor, PermissionMode::Supervised), PermissionMode::Auto);
        assert_eq!(default_provider_permission(ProviderKind::Cursor, PermissionMode::AcceptEdits), PermissionMode::Auto);
        assert_eq!(default_provider_permission(ProviderKind::Cursor, PermissionMode::FullAccess), PermissionMode::FullAccess);
        assert_eq!(default_provider_permission(ProviderKind::ClaudeCode, PermissionMode::Supervised), PermissionMode::Supervised);
    }

    #[tokio::test]
    async fn claude_result_waits_for_background_agents_and_scopes_the_continuation() {
        assert_claude_background_continuation(RuntimeTaskKind::Agent).await;
    }

    #[tokio::test]
    async fn claude_background_process_leaves_the_composer_ready_for_normal_send() {
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
            task_prefix: None,
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
            subagent: None,
            delegation: None,
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
            computer_tools: false,
            last_activity: std::sync::Mutex::new(SessionActivityTime::now()),
            released: AtomicBool::new(false),
            retained: AtomicBool::new(false),
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
            task_aliases: Mutex::new(HashMap::new()),
            deferred_checkpoints: Mutex::new(HashSet::new()),
            pending: Mutex::new(HashMap::new()),
            daemon_approvals: Mutex::new(HashMap::new()),
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
        if kind == RuntimeTaskKind::Agent {
            assert!(live.turn.lock().await.as_ref().is_some_and(|turn| turn.pending_completion.is_some()));
            assert!(
                !store
                    .events_for_thread(thread.id)
                    .unwrap()
                    .iter()
                    .any(|event| matches!(event.payload, EventPayload::TurnCompleted { .. }))
            );
        } else {
            assert!(live.turn.lock().await.is_none(), "background services and monitors may outlive the foreground request");
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
        if kind == RuntimeTaskKind::Agent {
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
        assert_eq!(resumed, usize::from(kind != RuntimeTaskKind::Agent));
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
        assert_eq!(completed.len(), if kind == RuntimeTaskKind::Agent { 1 } else { 2 });
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
            Self::with_drivers_and_gateway(drivers, None)
        }

        fn with_drivers_and_gateway(drivers: DriverRegistry, gateway: Option<crate::native_tools_mcp::NativeToolsGateway>) -> Self {
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
                task_prefix: None,
                created_at: now,
                updated_at: now,
            };
            store.project_insert(&project).unwrap();
            let (events_tx, _) = crate::bounded_broadcast::channel(64, 8 * 1024 * 1024);
            let mut orchestrator = Orchestrator::new(store.clone(), drivers, events_tx, paths, settings);
            if let Some(gateway) = gateway {
                orchestrator = orchestrator.with_native_tools(gateway);
            }
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
                subagent: None,
                delegation: None,
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
                computer_tools: false,
                last_activity: std::sync::Mutex::new(SessionActivityTime { monotonic: last_activity, wall: SystemTime::now() }),
                released: AtomicBool::new(false),
                retained: AtomicBool::new(false),
                stop_cleanup: AtomicBool::new(false),
                turn: Mutex::new(None),
                continuation: Mutex::new(None),
                turn_ready: tokio::sync::Notify::new(),
                last_turn_id: Mutex::new(None),
                tasks: Mutex::new(HashMap::new()),
                task_aliases: Mutex::new(HashMap::new()),
                deferred_checkpoints: Mutex::new(HashSet::new()),
                pending: Mutex::new(HashMap::new()),
                daemon_approvals: Mutex::new(HashMap::new()),
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
                computer_tools: false,
                last_activity: std::sync::Mutex::new(SessionActivityTime::now()),
                released: AtomicBool::new(false),
                retained: AtomicBool::new(false),
                stop_cleanup: AtomicBool::new(false),
                turn: Mutex::new(None),
                continuation: Mutex::new(None),
                turn_ready: tokio::sync::Notify::new(),
                last_turn_id: Mutex::new(None),
                tasks: Mutex::new(HashMap::new()),
                task_aliases: Mutex::new(HashMap::new()),
                deferred_checkpoints: Mutex::new(HashSet::new()),
                pending: Mutex::new(HashMap::new()),
                daemon_approvals: Mutex::new(HashMap::new()),
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
    async fn computer_consent_resolves_in_the_daemon_and_is_reused_on_retry() {
        use crate::computer::{ConsentAnswer, ConsentRequest, Mode};
        let fixture = Fixture::new();
        let thread = fixture.thread(ThreadStatus::Idle);
        let (live, _) = fixture.active_app_tool_session(&thread).await;
        let turn_id = live.turn.lock().await.as_ref().unwrap().id;
        let request = || ConsentRequest {
            app: "Notes".into(),
            bundle_id: Some("com.apple.Notes".into()),
            mode: Mode::Background,
            first_action: "press @1".into(),
        };
        let asking = {
            let (orchestrator, live, thread_id) = (fixture.orchestrator.clone(), live.clone(), thread.id);
            tokio::spawn(async move { orchestrator.ask_computer_consent(thread_id, turn_id, &live, request()).await })
        };
        let approval_id = loop {
            if let Some(id) = live.daemon_approvals.lock().await.keys().next().copied() {
                break id;
            }
            tokio::task::yield_now().await;
        };
        assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().status, ThreadStatus::AwaitingApproval);
        tokio::time::timeout(Duration::from_secs(2), fixture.orchestrator.respond_approval(approval_id, ApprovalDecision::AllowAlways))
            .await
            .expect("answering a daemon approval must not deadlock")
            .unwrap();
        assert_eq!(asking.await.unwrap().unwrap(), ConsentAnswer::Session);
        assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().status, ThreadStatus::Running);
        // A retry in the same turn reuses the answer instead of opening a new card.
        let retry =
            tokio::time::timeout(Duration::from_secs(2), fixture.orchestrator.ask_computer_consent(thread.id, turn_id, &live, request()))
                .await
                .unwrap()
                .unwrap();
        assert_eq!(retry, ConsentAnswer::Session);
        assert_eq!(live.daemon_approvals.lock().await.len(), 1);
        assert!(fixture.orchestrator.respond_approval(approval_id, ApprovalDecision::AllowOnce).await.is_err());
        fixture.orchestrator.resolve_finished_requests(thread.id, turn_id, &live).await.unwrap();
        assert!(live.daemon_approvals.lock().await.is_empty());
    }

    impl Fixture {
        /// A thread in `mode` with an active turn, ready for native tool calls.
        async fn tool_thread(&self, mode: PermissionMode) -> (Thread, Arc<LiveSession>) {
            let mut thread = self.thread(ThreadStatus::Idle);
            thread.permission_mode = mode;
            self.store.thread_upsert(&thread).unwrap();
            let (live, _) = self.active_app_tool_session(&thread).await;
            (thread, live)
        }

        async fn tool(
            &self,
            thread: &Thread,
            live: &LiveSession,
            call: &str,
            name: &str,
            args: serde_json::Value,
        ) -> anyhow::Result<serde_json::Value> {
            self.orchestrator.execute_native_app_tool_call(thread.id, live.session_instance_id, call, name, args).await
        }
    }

    #[tokio::test]
    async fn agents_edit_only_their_own_notes_and_tasks_and_never_close_tasks() {
        let fixture = Fixture::new();
        let (thread, live) = fixture.tool_thread(PermissionMode::FullAccess).await;
        let notes_changed = fixture.orchestrator.subscribe_notes();
        let mut tasks_changed = fixture.orchestrator.subscribe_tasks();

        // The user's note: append only.
        let user_note = fixture
            .orchestrator
            .note_create(methods::NotesCreateParams {
                scope: methods::NoteScope::Project,
                project_id: Some(fixture.project.id),
                title: Some("Plan".into()),
                body: Some("Ship it".into()),
            })
            .unwrap();
        let error = fixture
            .tool(&thread, &live, "u1", "kybern_note_update", json!({"note_id": user_note.summary.id, "body": "mine now"}))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("only append"), "{error}");
        let appended = fixture
            .tool(&thread, &live, "a1", "kybern_note_append", json!({"note_id": user_note.summary.id, "text": "Found the bug."}))
            .await
            .unwrap();
        assert_eq!((appended["action"].clone(), appended["agent_editable"].clone()), (json!("appended"), json!(false)));
        assert_eq!(fixture.store.note_get(user_note.summary.id).unwrap().unwrap().body, "Ship it\n\nFound the bug.");
        // Without a note id the thread's own note is created and appended to.
        fixture.tool(&thread, &live, "a2", "kybern_note_append", json!({"text": "First"})).await.unwrap();
        fixture.tool(&thread, &live, "a3", "kybern_note_append", json!({"text": "Second"})).await.unwrap();
        assert_eq!(fixture.store.note_for_thread(thread.id).unwrap().unwrap().body, "First\n\nSecond");

        // An agent's note: fully editable, attributed, linked.
        let created = fixture.tool(&thread, &live, "c1", "kybern_note_create", json!({"title": "Findings", "body": "one"})).await.unwrap();
        let note_id: Uuid = serde_json::from_value(created["id"].clone()).unwrap();
        assert_eq!(created["link"], json!(format!("kybern://note/{note_id}")));
        assert_eq!(created["markdown"], json!(format!("[Findings](kybern://note/{note_id})")));
        assert_eq!(created["created_by_thread"], json!(thread.id));
        assert_eq!(created["scope"], json!("project"));
        // Replacing text needs the revision it was based on.
        let error =
            fixture.tool(&thread, &live, "u2-blind", "kybern_note_update", json!({"note_id": note_id, "body": "blind"})).await.unwrap_err();
        assert!(error.to_string().contains("Pass expected_revision") && error.to_string().contains("kybern_note_read"), "{error}");
        let revision = created["revision"].as_i64().unwrap();
        let error = fixture
            .tool(
                &thread,
                &live,
                "u2-stale",
                "kybern_note_update",
                json!({"note_id": note_id, "body": "stale", "expected_revision": revision - 1}),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("changed since you read it"), "{error}");
        assert_eq!(fixture.store.note_get(note_id).unwrap().unwrap().body, "one", "a rejected update writes nothing");
        fixture
            .tool(
                &thread,
                &live,
                "u2",
                "kybern_note_update",
                json!({"note_id": note_id, "title": "Findings v2", "body": "two", "expected_revision": revision}),
            )
            .await
            .unwrap();
        let note = fixture.store.note_get(note_id).unwrap().unwrap();
        assert_eq!((note.summary.title.as_str(), note.body.as_str()), ("Findings v2", "two"));
        assert!(notes_changed.len() >= 4, "every write is published");

        // The user's task: append, check, priority; no title, no close, no review without a run.
        let user_task = fixture
            .orchestrator
            .task_item_create(methods::TaskItemsCreateParams {
                scope: methods::TaskScope::Project,
                project_id: Some(fixture.project.id),
                title: "Fix login".into(),
                body: Some("Redirect.\n\n- [ ] Lands on home\n- [ ] Has a test\n".into()),
                status: Some(methods::TaskStatus::Todo),
                priority: None,
                note_ids: None,
                source: None,
            })
            .unwrap();
        while tasks_changed.try_recv().is_ok() {}
        let error =
            fixture.tool(&thread, &live, "t1", "kybern_task_update", json!({"task": user_task.key, "title": "Mine"})).await.unwrap_err();
        assert!(error.to_string().contains("cannot replace its title"), "{error}");
        for status in ["done", "canceled"] {
            let error = fixture
                .tool(&thread, &live, status, "kybern_task_update", json!({"task": user_task.key, "status": status}))
                .await
                .unwrap_err();
            assert!(error.to_string().contains("Only the user closes a task"), "{error}");
        }
        let error = fixture
            .tool(&thread, &live, "t2", "kybern_task_update", json!({"task": user_task.key, "status": "needs_review"}))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("Claim it with kybern_task_claim first"), "{error}");
        let updated = fixture
            .tool(
                &thread,
                &live,
                "t3",
                "kybern_task_update",
                json!({"task": user_task.key, "append": "Safari only.", "check": [1], "priority": 2}),
            )
            .await
            .unwrap();
        assert_eq!((updated["criteria_done"].clone(), updated["priority"].clone()), (json!(1), json!(2)));
        assert_eq!(updated["markdown"], json!(format!("[{} {}](kybern://task/{})", user_task.key, user_task.title, user_task.id)));
        let task = fixture.store.task_item_get(user_task.id).unwrap().unwrap();
        assert_eq!(task.body, "Redirect.\n\nSafari only.\n\n- [x] Lands on home\n- [ ] Has a test\n");
        assert!(tasks_changed.try_recv().is_ok(), "the update is published");

        // Claiming links this chat as the run; then it may hand the task over for review.
        let claimed = fixture.tool(&thread, &live, "k1", "kybern_task_claim", json!({"task": user_task.key})).await.unwrap();
        assert_eq!((claimed["action"].clone(), claimed["status"].clone()), (json!("claimed"), json!("running")));
        let task = fixture.store.task_item_get(user_task.id).unwrap().unwrap();
        assert_eq!(task.runs.last().map(|run| run.thread_id), Some(thread.id));
        let context = fixture.tool(&thread, &live, "ctx", "kybern_thread_context", json!({})).await.unwrap();
        assert_eq!(context["task"]["key"], json!(user_task.key), "the context names the task this chat runs");
        let reviewed = fixture
            .tool(
                &thread,
                &live,
                "t4",
                "kybern_task_update",
                json!({"task": format!("kybern://task/{}", user_task.id), "status": "needs_review"}),
            )
            .await
            .unwrap();
        assert_eq!(reviewed["status"], json!("needs_review"));
        // Another chat cannot claim a task whose run is live.
        let (other, other_live) = fixture.tool_thread(PermissionMode::FullAccess).await;
        let second = fixture
            .orchestrator
            .task_item_create(methods::TaskItemsCreateParams {
                scope: methods::TaskScope::Global,
                project_id: None,
                title: "Busy".into(),
                body: None,
                status: None,
                priority: None,
                note_ids: None,
                source: None,
            })
            .unwrap();
        fixture.tool(&other, &other_live, "k2", "kybern_task_claim", json!({"task": second.key})).await.unwrap();
        let error = fixture.tool(&thread, &live, "k3", "kybern_task_claim", json!({"task": second.key})).await.unwrap_err();
        assert!(error.to_string().contains("already has a run in progress in another chat"), "{error}");

        // An agent's task lands in the Inbox, attributed, and is fully editable.
        let filed = fixture
            .tool(
                &thread,
                &live,
                "n1",
                "kybern_task_create",
                json!({"title": "Flaky test", "description": "Seen twice.", "criteria": ["Passes 20 runs"], "priority": 3}),
            )
            .await
            .unwrap();
        assert_eq!((filed["status"].clone(), filed["created_by_thread"].clone()), (json!("inbox"), json!(thread.id)));
        let filed_id: Uuid = serde_json::from_value(filed["id"].clone()).unwrap();
        assert_eq!(fixture.store.task_item_get(filed_id).unwrap().unwrap().body, "Seen twice.\n\n- [ ] Passes 20 runs\n");
        fixture.tool(&thread, &live, "n2", "kybern_task_update", json!({"task": filed["key"], "title": "Flaky login test"})).await.unwrap();
        // A retried call returns the first result instead of filing twice.
        let retried = fixture
            .tool(
                &thread,
                &live,
                "n1",
                "kybern_task_create",
                json!({"title": "Flaky test", "description": "Seen twice.", "criteria": ["Passes 20 runs"], "priority": 3}),
            )
            .await
            .unwrap();
        assert_eq!(retried["id"], filed["id"]);
        let reads = fixture.tool(&thread, &live, "r1", "kybern_tasks_list", json!({"query": "flaky"})).await.unwrap();
        assert_eq!(reads["tasks"].as_array().unwrap().len(), 1);
        let read = fixture.tool(&thread, &live, "r2", "kybern_task_read", json!({"task": user_task.key})).await.unwrap();
        assert_eq!(read["criteria"][0], json!({"number": 1, "text": "Lands on home", "checked": true}));
        let search = fixture.tool(&thread, &live, "r3", "kybern_notes_search", json!({"query": "findings"})).await.unwrap();
        assert_eq!(search["notes"][0]["id"], json!(note_id));

        // The daemon stops a turn after ten filed tasks.
        for index in 1..super::agent_items::MAX_TASK_CREATES_PER_TURN {
            fixture
                .tool(&thread, &live, &format!("cap{index}"), "kybern_task_create", json!({"title": format!("Follow-up {index}")}))
                .await
                .unwrap();
        }
        let error = fixture.tool(&thread, &live, "cap-over", "kybern_task_create", json!({"title": "One too many"})).await.unwrap_err();
        assert!(error.to_string().contains("ask the user"), "{error}");
    }

    #[tokio::test]
    async fn supervised_note_and_task_writes_ask_and_remember_allow_for_this_thread() {
        let fixture = Fixture::new();
        let (thread, live) = fixture.tool_thread(PermissionMode::Supervised).await;
        // Reads never ask.
        fixture.tool(&thread, &live, "list", "kybern_tasks_list", json!({})).await.unwrap();
        assert!(live.daemon_approvals.lock().await.is_empty());

        let creating = {
            let (orchestrator, thread_id, session) = (fixture.orchestrator.clone(), thread.id, live.session_instance_id);
            tokio::spawn(async move {
                orchestrator
                    .execute_native_app_tool_call(thread_id, session, "c1", "kybern_task_create", json!({"title": "Fix flaky login test"}))
                    .await
            })
        };
        let approval_id = loop {
            if let Some(id) = live.daemon_approvals.lock().await.keys().next().copied() {
                break id;
            }
            tokio::task::yield_now().await;
        };
        let (request, _) = fixture.store.approval_get(approval_id).unwrap().unwrap();
        assert_eq!(request.tool_name, "kybern_notes_tasks");
        assert_eq!(request.summary, "Create task 'Fix flaky login test' in fixture");
        assert_eq!((request.input["action"].clone(), request.input["tool"].clone()), (json!("create_task"), json!("kybern_task_create")));
        assert!(fixture.store.task_items_list().unwrap().is_empty(), "nothing is filed before the user answers");
        fixture.orchestrator.respond_approval(approval_id, ApprovalDecision::AllowAlways).await.unwrap();
        let created = creating.await.unwrap().unwrap();
        assert_eq!(created["title"], json!("Fix flaky login test"));
        // "Allow for this thread" covers later writes without another card.
        fixture.tool(&thread, &live, "c2", "kybern_note_append", json!({"text": "noted"})).await.unwrap();
        assert_eq!(live.daemon_approvals.lock().await.len(), 1);

        // A denial in another supervised thread is reported and writes nothing.
        let (other, other_live) = fixture.tool_thread(PermissionMode::AcceptEdits).await;
        let denied = {
            let (orchestrator, thread_id, session) = (fixture.orchestrator.clone(), other.id, other_live.session_instance_id);
            tokio::spawn(async move {
                orchestrator
                    .execute_native_app_tool_call(thread_id, session, "d1", "kybern_note_create", json!({"title": "Nope", "body": ""}))
                    .await
            })
        };
        let approval_id = loop {
            if let Some(id) = other_live.daemon_approvals.lock().await.keys().next().copied() {
                break id;
            }
            tokio::task::yield_now().await;
        };
        fixture.orchestrator.respond_approval(approval_id, ApprovalDecision::Deny { reason: None }).await.unwrap();
        let error = denied.await.unwrap().unwrap_err();
        assert!(error.to_string().contains("The user declined"), "{error}");
        assert!(fixture.store.notes_list().unwrap().iter().all(|note| note.title != "Nope"));
    }

    impl Fixture {
        fn user_task(&self, title: &str, status: methods::TaskStatus) -> methods::TaskItem {
            let task = self
                .orchestrator
                .task_item_create(methods::TaskItemsCreateParams {
                    scope: methods::TaskScope::Project,
                    project_id: Some(self.project.id),
                    title: title.into(),
                    body: None,
                    status: Some(methods::TaskStatus::Todo),
                    priority: None,
                    note_ids: None,
                    source: None,
                })
                .unwrap();
            if status != methods::TaskStatus::Todo {
                self.store.task_item_set_status(task.id, status, None).unwrap();
            }
            self.store.task_item_get(task.id).unwrap().unwrap()
        }

        /// The first daemon approval card of `live` that is not in `seen`.
        async fn next_card(&self, live: &LiveSession, seen: &[ApprovalId]) -> ApprovalId {
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if let Some(id) = live.daemon_approvals.lock().await.keys().find(|id| !seen.contains(id)).copied() {
                        break id;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("an approval card opens")
        }

        fn spawn_tool(
            &self,
            thread: &Thread,
            live: &LiveSession,
            call: &str,
            name: &'static str,
            args: serde_json::Value,
        ) -> tokio::task::JoinHandle<anyhow::Result<serde_json::Value>> {
            let (orchestrator, thread_id, session, call) =
                (self.orchestrator.clone(), thread.id, live.session_instance_id, call.to_owned());
            tokio::spawn(async move { orchestrator.execute_native_app_tool_call(thread_id, session, &call, name, args).await })
        }
    }

    #[tokio::test]
    async fn agent_status_changes_never_reopen_pull_back_or_hand_over_a_stale_run() {
        use methods::TaskStatus;
        let fixture = Fixture::new();
        let (thread, live) = fixture.tool_thread(PermissionMode::FullAccess).await;
        // Inbox and To do only move between each other.
        let inbox = fixture.user_task("Triage", TaskStatus::Inbox);
        let moved = fixture.tool(&thread, &live, "m1", "kybern_task_update", json!({"task": inbox.key, "status": "todo"})).await.unwrap();
        assert_eq!(moved["status"], json!("todo"));
        // Closed, running and in-review tasks are never moved back.
        for status in [TaskStatus::Done, TaskStatus::Canceled, TaskStatus::Running, TaskStatus::NeedsReview] {
            let task = fixture.user_task("Settled", status);
            for target in ["inbox", "todo"] {
                let error = fixture
                    .tool(
                        &thread,
                        &live,
                        &format!("{status:?}-{target}"),
                        "kybern_task_update",
                        json!({"task": task.key, "status": target}),
                    )
                    .await
                    .unwrap_err();
                assert!(error.to_string().contains("only between Inbox and To do"), "{status:?} -> {target}: {error}");
                assert_eq!(fixture.store.task_item_get(task.id).unwrap().unwrap().status, status);
            }
        }

        // The handover needs the task Running...
        let task = fixture.user_task("Fix login", TaskStatus::Todo);
        fixture.tool(&thread, &live, "k1", "kybern_task_claim", json!({"task": task.key})).await.unwrap();
        fixture.store.task_item_set_status(task.id, TaskStatus::Todo, None).unwrap();
        let error = fixture
            .tool(&thread, &live, "h1", "kybern_task_update", json!({"task": task.key, "status": "needs_review"}))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("not Running"), "{error}");
        assert_eq!(fixture.store.task_item_get(task.id).unwrap().unwrap().status, TaskStatus::Todo);

        // ...and this chat's run to be the latest one.
        let (newer, _) = fixture.tool_thread(PermissionMode::FullAccess).await;
        fixture.store.task_run_start(task.id, newer.id, &newer.provider, None, &[]).unwrap();
        let error = fixture
            .tool(&thread, &live, "h2", "kybern_task_update", json!({"task": task.key, "status": "needs_review"}))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("newer run"), "{error}");
        assert_eq!(fixture.store.task_item_get(task.id).unwrap().unwrap().status, TaskStatus::Running);
    }

    #[tokio::test]
    async fn one_chat_claims_several_tasks_and_hands_them_over_together_or_one_by_one() {
        let fixture = Fixture::new();
        let (thread, live) = fixture.tool_thread(PermissionMode::FullAccess).await;
        let (a, b, c) = (
            fixture.user_task("First", methods::TaskStatus::Todo),
            fixture.user_task("Second", methods::TaskStatus::Todo),
            fixture.user_task("Third", methods::TaskStatus::Todo),
        );
        let status = |task: &methods::TaskItem| fixture.store.task_item_get(task.id).unwrap().unwrap().status;

        // A list claims every task, and the chat is the run of each.
        let claimed = fixture.tool(&thread, &live, "m1", "kybern_task_claim", json!({"tasks": [a.key, b.key]})).await.unwrap();
        assert_eq!(claimed["claimed"].as_array().unwrap().len(), 2);
        for task in [&a, &b] {
            let current = fixture.store.task_item_get(task.id).unwrap().unwrap();
            assert_eq!((current.status, current.runs.last().map(|run| run.thread_id)), (methods::TaskStatus::Running, Some(thread.id)));
        }
        // A later claim in the same chat adds a third task; claiming again is idempotent.
        fixture.tool(&thread, &live, "m2", "kybern_task_claim", json!({"task": c.key})).await.unwrap();
        fixture.tool(&thread, &live, "m3", "kybern_task_claim", json!({"tasks": [c.key, a.key]})).await.unwrap();
        assert_eq!(fixture.store.task_runs_for_thread(thread.id).unwrap().len(), 3);
        assert_eq!(fixture.store.task_item_get(a.id).unwrap().unwrap().runs.len(), 1, "no second run");

        // One task is handed over early; claiming another reopens only the claimed one.
        let reviewed =
            fixture.tool(&thread, &live, "m4", "kybern_task_update", json!({"task": a.key, "status": "needs_review"})).await.unwrap();
        assert_eq!(reviewed["status"], json!("needs_review"));
        assert_eq!(
            (status(&a), status(&b), status(&c)),
            (methods::TaskStatus::NeedsReview, methods::TaskStatus::Running, methods::TaskStatus::Running)
        );
        fixture.tool(&thread, &live, "m5", "kybern_task_update", json!({"task": b.key, "status": "needs_review"})).await.unwrap();
        fixture.tool(&thread, &live, "m6", "kybern_task_claim", json!({"task": c.key})).await.unwrap();
        assert_eq!(
            (status(&a), status(&b), status(&c)),
            (methods::TaskStatus::NeedsReview, methods::TaskStatus::NeedsReview, methods::TaskStatus::Running)
        );
        // Reopening one task leaves the others' handover alone; reclaiming it comes back Running.
        fixture.tool(&thread, &live, "m7", "kybern_task_claim", json!({"task": b.key})).await.unwrap();
        assert_eq!((status(&a), status(&b)), (methods::TaskStatus::NeedsReview, methods::TaskStatus::Running));

        // The turn's end moves the tasks still Running, and only those, to Needs review.
        let turn = live.turn.lock().await.as_ref().map(|turn| turn.id);
        fixture
            .orchestrator
            .emit(
                thread.id,
                turn,
                EventPayload::TurnCompleted {
                    stop_reason: StopReason::Completed,
                    usage: Usage::default(),
                    cost_usd: None,
                    duration_ms: 1,
                    terminal_message_id: None,
                },
            )
            .unwrap();
        for task in [&a, &b, &c] {
            assert_eq!(status(task), methods::TaskStatus::NeedsReview, "{}", task.key);
        }
    }

    #[tokio::test]
    async fn a_list_claim_is_all_or_none_and_refuses_closed_or_busy_tasks() {
        let fixture = Fixture::new();
        let (thread, live) = fixture.tool_thread(PermissionMode::FullAccess).await;
        let (other, other_live) = fixture.tool_thread(PermissionMode::FullAccess).await;
        let (a, busy, closed) = (
            fixture.user_task("Free", methods::TaskStatus::Todo),
            fixture.user_task("Busy", methods::TaskStatus::Todo),
            fixture.user_task("Closed", methods::TaskStatus::Done),
        );
        fixture.tool(&other, &other_live, "o1", "kybern_task_claim", json!({"task": busy.key})).await.unwrap();

        let error = fixture.tool(&thread, &live, "l1", "kybern_task_claim", json!({"tasks": [a.key, busy.key]})).await.unwrap_err();
        assert!(error.to_string().contains("already has a run in progress in another chat"), "{error}");
        let error = fixture.tool(&thread, &live, "l2", "kybern_task_claim", json!({"tasks": [a.key, closed.key]})).await.unwrap_err();
        assert!(error.to_string().contains("closed"), "{error}");
        let error = fixture.tool(&thread, &live, "l3", "kybern_task_claim", json!({"task": a.key, "tasks": [a.key]})).await.unwrap_err();
        assert!(error.to_string().contains("either task or tasks"), "{error}");
        let keys: Vec<String> = (0..11).map(|_| a.key.clone()).collect();
        let error = fixture.tool(&thread, &live, "l4", "kybern_task_claim", json!({"tasks": keys})).await.unwrap_err();
        assert!(error.to_string().contains("at most 10"), "{error}");
        let free = fixture.store.task_item_get(a.id).unwrap().unwrap();
        assert!(free.runs.is_empty() && free.status == methods::TaskStatus::Todo, "nothing was claimed");
        assert!(fixture.store.task_runs_for_thread(thread.id).unwrap().is_empty());
    }

    #[tokio::test]
    async fn parallel_task_creates_stop_at_the_cap_even_while_cards_are_open() {
        let fixture = Fixture::new();
        let cap = super::agent_items::MAX_TASK_CREATES_PER_TURN as usize;
        // Full access: parallel calls race straight to the store.
        let (thread, live) = fixture.tool_thread(PermissionMode::FullAccess).await;
        let calls: Vec<_> = (0..cap + 5)
            .map(|index| {
                fixture.spawn_tool(&thread, &live, &format!("p{index}"), "kybern_task_create", json!({"title": format!("Task {index}")}))
            })
            .collect();
        let mut filed = 0;
        for call in calls {
            match call.await.unwrap() {
                Ok(_) => filed += 1,
                Err(error) => assert!(error.to_string().contains("the most allowed"), "{error}"),
            }
        }
        assert_eq!(filed, cap);
        assert_eq!(fixture.store.task_items_list().unwrap().len(), cap);

        // Supervised: creates waiting on a card hold their slot, so no eleventh card opens.
        let (thread, live) = fixture.tool_thread(PermissionMode::Supervised).await;
        let calls: Vec<_> = (0..cap + 2)
            .map(|index| {
                fixture.spawn_tool(&thread, &live, &format!("s{index}"), "kybern_task_create", json!({"title": format!("Card {index}")}))
            })
            .collect();
        let mut cards = Vec::new();
        while cards.len() < cap {
            cards.push(fixture.next_card(&live, &cards).await);
        }
        for card in &cards {
            fixture.orchestrator.respond_approval(*card, ApprovalDecision::AllowOnce).await.unwrap();
        }
        let mut filed = 0;
        for call in calls {
            if call.await.unwrap().is_ok() {
                filed += 1;
            }
        }
        assert_eq!(filed, cap);
        assert_eq!(live.daemon_approvals.lock().await.len(), cap, "the calls over the cap never asked");
    }

    #[tokio::test]
    async fn allow_once_covers_one_write_and_only_its_retry() {
        let fixture = Fixture::new();
        let (thread, live) = fixture.tool_thread(PermissionMode::Supervised).await;
        let append = json!({"text": "Same line"});
        let first = fixture.spawn_tool(&thread, &live, "a1", "kybern_note_append", append.clone());
        let card = fixture.next_card(&live, &[]).await;
        fixture.orchestrator.respond_approval(card, ApprovalDecision::AllowOnce).await.unwrap();
        let written = first.await.unwrap().unwrap();
        // A retry of the same call returns its receipt without asking.
        let retried = fixture.tool(&thread, &live, "a1", "kybern_note_append", append.clone()).await.unwrap();
        assert_eq!(retried, written);
        assert_eq!(live.daemon_approvals.lock().await.len(), 1);
        // An identical second write needs its own answer.
        let second = fixture.spawn_tool(&thread, &live, "a2", "kybern_note_append", append.clone());
        let second_card = fixture.next_card(&live, &[card]).await;
        assert!(!second.is_finished(), "the second write waits for the user");
        fixture.orchestrator.respond_approval(second_card, ApprovalDecision::AllowOnce).await.unwrap();
        second.await.unwrap().unwrap();
        assert_eq!(fixture.store.note_for_thread(thread.id).unwrap().unwrap().body, "Same line\n\nSame line");

        // Two identical calls waiting on one card: the answer covers one of them.
        let both = [
            fixture.spawn_tool(&thread, &live, "b1", "kybern_note_append", json!({"text": "Twin"})),
            fixture.spawn_tool(&thread, &live, "b2", "kybern_note_append", json!({"text": "Twin"})),
        ];
        let shared = fixture.next_card(&live, &[card, second_card]).await;
        // Let both calls reach the card before it is answered.
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
        fixture.orchestrator.respond_approval(shared, ApprovalDecision::AllowOnce).await.unwrap();
        let again = fixture.next_card(&live, &[card, second_card, shared]).await;
        fixture.orchestrator.respond_approval(again, ApprovalDecision::AllowOnce).await.unwrap();
        for call in both {
            call.await.unwrap().unwrap();
        }
        assert_eq!(fixture.store.note_for_thread(thread.id).unwrap().unwrap().body, "Same line\n\nSame line\n\nTwin\n\nTwin");
        assert_eq!(live.daemon_approvals.lock().await.len(), 4);
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
        // A visual is part of the coordinator's reply, not an edit to project code.
        let turn_id = live.turn.lock().await.as_ref().unwrap().id;
        let published = fixture
            .orchestrator
            .execute_native_app_tool_call(
                thread.id,
                live.session_instance_id,
                "allowed-visual",
                "kybern_html_publish",
                json!({"html": "<button>Review findings</button>", "title": "Review", "height": 240}),
            )
            .await
            .unwrap();
        let visual_id: Uuid = serde_json::from_value(published["visual"]["id"].clone()).unwrap();
        let events = fixture.store.events_for_thread(thread.id).unwrap();
        assert!(events.iter().any(|event| event.turn_id == Some(turn_id)
            && matches!(&event.payload, EventPayload::HtmlPublished { visual } if visual.id == visual_id)));
        assert!(fixture.store.visual_read(thread.id, visual_id).unwrap().unwrap().contains("Review findings"));
        assert!(fixture.store.visual_read(fixture.thread(ThreadStatus::Idle).id, visual_id).unwrap().is_none());
        assert!(live.daemon_approvals.lock().await.is_empty(), "Publishing a reply needs no notes/tasks write approval");
        for name in ["kybern_html_preview", "kybern_html_publish"] {
            let error = fixture
                .orchestrator
                .execute_native_app_tool_call(
                    thread.id,
                    live.session_instance_id,
                    "wrong-visual-owner",
                    name,
                    json!({"thread_id": Uuid::now_v7(), "html": "<p>Wrong owner</p>", "title": "Review", "height": 240}),
                )
                .await
                .unwrap_err();
            assert!(error.to_string().contains("bound to the current thread"), "{name}: {error}");
        }
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
                fixture.store.project_coordinator_put(thread.project_id, thread.id, group.id).unwrap();
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
    async fn assignment_dispatch_busy_race_returns_to_pending_without_accepting_turn() {
        let fixture = Fixture::new();
        let mut thread = fixture.thread(ThreadStatus::Idle);
        let group = fixture
            .orchestrator
            .collaboration_group_create(methods::CollaborationGroupsCreateParams {
                operation_id: Uuid::now_v7(),
                project_id: thread.project_id,
                coordinator_thread_id: thread.id,
                objective: "Retry a busy assignment".into(),
                success_criteria: vec![],
                coordinator_mode: Some(CoordinatorMode::Ordinary),
                policy: None,
            })
            .unwrap();
        let mut assignment = fixture
            .orchestrator
            .collaboration_assignment_create(
                methods::CollaborationAssignmentsCreateParams {
                    operation_id: Uuid::now_v7(),
                    group_id: group.id,
                    parent_assignment_id: None,
                    owner_thread_id: Some(thread.id),
                    child: None,
                    title: "Follow-up".into(),
                    instructions: "Read the result".into(),
                    kind: AssignmentKind::Research,
                },
                None,
                None,
            )
            .await
            .unwrap();
        // Another send won after the scheduler observed an idle owner.
        thread.status = ThreadStatus::Running;
        fixture.store.thread_upsert(&thread).unwrap();
        assert!(!fixture.orchestrator.start_collaboration_assignment(&group, &mut assignment).await.unwrap());
        let pending = fixture.store.collaboration_assignment_get(assignment.id).unwrap().unwrap();
        assert_eq!(pending.status, AssignmentStatus::Pending);
        assert_eq!(pending.owner_thread_id, Some(thread.id));
        assert!(pending.dispatch_message_id.is_none());
        assert!(pending.uncertainty.is_none());
        assert!(
            fixture
                .store
                .events_for_thread(thread.id)
                .unwrap()
                .iter()
                .all(|event| !matches!(event.payload, EventPayload::TurnStarted { .. }))
        );
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
        fixture.store.project_coordinator_put(thread.project_id, thread.id, group.id).unwrap();
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
        fixture.store.project_coordinator_put(thread.project_id, thread.id, group.id).unwrap();
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
        let coordinator = fixture
            .orchestrator
            .project_coordinator_get_or_create(methods::CollaborationCoordinatorGetOrCreateParams {
                operation_id: Uuid::now_v7(),
                project_id: fixture.project.id,
                provider: ProviderInstance::default_for(ProviderKind::Codex),
                model: None,
                effort: None,
                permission_mode: Some(PermissionMode::Supervised),
                coordinator_mode: Some(CoordinatorMode::Ordinary),
                initial_goal: Some("Remember project facts".into()),
            })
            .await
            .unwrap();
        let thread = coordinator.thread;
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
        let entries: Vec<_> =
            fixture.store.collaboration_context_latest(group).unwrap().into_iter().filter(|entry| entry.key == "test-command").collect();
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
        assert_eq!(
            fixture.store.collaboration_context_latest(group).unwrap().into_iter().find(|entry| entry.key == "test-command").unwrap().body,
            "Run cargo test -p sample."
        );
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
    async fn ordinary_thread_is_refused_project_knowledge_and_the_role_prefix_stays_stable() {
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
        // Orchestrator V2: an ordinary thread is not offered the collaboration tools.
        let refused = fixture
            .orchestrator
            .execute_native_app_tool_call(
                thread.id,
                live.session_instance_id,
                "read-project-knowledge",
                "kybern_collaboration_context_read",
                json!({"keys":["shared.fact"], "limit":10}),
            )
            .await
            .unwrap_err();
        assert!(refused.to_string().contains("only for project coordinators") && refused.to_string().contains("kybern_agent_delegate"));
        assert_eq!(fixture.store.collaboration_group_for_thread(thread.id).unwrap(), None);
        let role_after = fixture.orchestrator.coordinator_instructions(&coordinator.thread).unwrap().unwrap();
        assert_eq!(role_before, role_after, "changing project knowledge must not replace the cached system prefix");
        assert!(!role_after.contains("The project uses a scratch daemon"), "live knowledge belongs in tool responses");
        let mut resumed = coordinator.thread.clone();
        resumed.provider_session_id = Some("saved-provider-session".into());
        assert_eq!(fixture.orchestrator.coordinator_instructions(&resumed).unwrap().as_deref(), Some(role_before.as_str()));
    }

    /// Records the bridge each spawned session is given.
    struct BridgeCapture {
        kind: ProviderKind,
        bridges: Arc<std::sync::Mutex<Vec<Option<kybern_drivers::NativeToolBridge>>>>,
    }

    #[async_trait::async_trait]
    impl kybern_drivers::AgentDriver for BridgeCapture {
        fn kind(&self) -> ProviderKind {
            self.kind
        }

        async fn probe(&self, _binary: Option<&PathBuf>) -> ProviderStatus {
            ProviderStatus {
                kind: self.kind,
                display_name: "Capture".into(),
                available: true,
                binary_path: None,
                version: None,
                unavailable_reason: None,
                supported_permission_modes: PermissionMode::ALL.to_vec(),
                supports_fork: false,
                supports_model_switch: false,
                supports_effort_switch: false,
                supported_efforts: vec![],
                models: vec![],
                instances: vec![],
            }
        }

        async fn spawn(&self, config: kybern_drivers::SessionConfig) -> kybern_drivers::Result<kybern_drivers::SpawnedSession> {
            self.bridges.lock().unwrap().push(config.native_tool_bridge);
            let (_tx, events) = tokio::sync::mpsc::channel(1);
            Ok(kybern_drivers::SpawnedSession { session: Box::new(TestSession::default()), events })
        }
    }

    fn capture_fixture(kind: ProviderKind) -> (Fixture, Arc<std::sync::Mutex<Vec<Option<kybern_drivers::NativeToolBridge>>>>) {
        let bridges = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut drivers = DriverRegistry::default();
        drivers.register(Arc::new(BridgeCapture { kind, bridges: bridges.clone() }));
        let gateway = crate::native_tools_mcp::NativeToolsGateway::default();
        (Fixture::with_drivers_and_gateway(drivers, Some(gateway)), bridges)
    }

    #[tokio::test]
    async fn every_new_session_receives_the_guide_for_its_own_tools_unless_turned_off() {
        let (fixture, bridges) = capture_fixture(ProviderKind::Codex);
        let thread = fixture.thread_with_provider(ThreadStatus::Idle, ProviderKind::Codex);
        let spawn = || async {
            let live = fixture.orchestrator.spawn_session(&thread, None).await.unwrap();
            fixture.orchestrator.revoke_native_session(&live);
            bridges.lock().unwrap().last().cloned().flatten().expect("bridge")
        };

        let first = spawn().await;
        let guide = first.guide().expect("an ordinary thread gets the guide").to_owned();
        assert_eq!(first.provider_instructions().as_deref(), Some(guide.as_str()), "no coordinator role on an ordinary thread");
        assert!(guide.starts_with("# Working in Kybern") && guide.contains("## Notes and tasks"));
        assert!(!guide.contains("The user's Mac"), "Codex has no Kybern computer tools");
        assert_eq!(spawn().await.guide(), Some(guide.as_str()), "respawn and resume keep the prefix byte-identical");

        let mut settings = fixture.orchestrator.inner.settings.get();
        settings.tell_agents_about_kybern = false;
        fixture.orchestrator.inner.settings.set(settings).unwrap();
        let off = spawn().await;
        assert_eq!(off.guide(), None);
        assert_eq!(off.provider_instructions(), None);
        assert!(off.tools().next().is_some(), "turning the guide off leaves the tools alone");
    }

    #[tokio::test]
    async fn a_coordinator_gets_the_guide_for_its_restricted_tools_then_its_stable_role() {
        let (fixture, bridges) = capture_fixture(ProviderKind::ClaudeCode);
        let coordinator = fixture
            .orchestrator
            .project_coordinator_get_or_create(methods::CollaborationCoordinatorGetOrCreateParams {
                operation_id: Uuid::now_v7(),
                project_id: fixture.project.id,
                provider: ProviderInstance::default_for(ProviderKind::ClaudeCode),
                model: None,
                effort: None,
                permission_mode: Some(PermissionMode::Supervised),
                coordinator_mode: Some(CoordinatorMode::Dedicated),
                initial_goal: Some("Coordinate".into()),
            })
            .await
            .unwrap();
        let live = fixture.orchestrator.spawn_session(&coordinator.thread, None).await.unwrap();
        fixture.orchestrator.revoke_native_session(&live);
        let bridge = bridges.lock().unwrap().last().cloned().flatten().expect("bridge");
        let role = fixture.orchestrator.coordinator_instructions(&coordinator.thread).unwrap().unwrap();
        let guide = bridge.guide().unwrap();
        assert_eq!(bridge.provider_instructions(), Some(format!("{guide}\n{role}")));
        assert!(guide.contains("## Notes and tasks") && guide.contains("kybern_thread_read"));
        assert!(!guide.contains("kybern_collaboration_spawn") || bridge.has_tool("kybern_collaboration_spawn"));
        assert!(guide.contains("## Visual replies"));
        for name in ["kybern_html_preview", "kybern_html_publish"] {
            assert!(bridge.has_tool(name), "Coordinators can illustrate their own review: {name}");
        }
        for name in ["kybern_thread_send", "kybern_workspace_diff", "kybern_html_preview", "kybern_html_publish"] {
            assert_eq!(guide.contains(name), bridge.has_tool(name), "the guide must describe exactly the tools the session has: {name}");
        }
    }

    #[tokio::test]
    async fn preview_open_tool_reports_status_notifies_clients_and_archive_revokes_tickets() {
        let fixture = Fixture::new();
        // The fixture project is the data directory, which previews never serve.
        let work = std::env::temp_dir().join(format!("kybern-preview-tool-{}", Uuid::now_v7()));
        std::fs::create_dir_all(&work).unwrap();
        let work = work.canonicalize().unwrap();
        std::fs::write(work.join("mock.html"), "<p>mock</p>").unwrap();
        let mut thread = fixture.thread_with_provider(ThreadStatus::Idle, ProviderKind::Pi);
        thread.cwd = work.to_string_lossy().into_owned();
        fixture.orchestrator.inner.store.thread_upsert(&thread).unwrap();
        let (live, _) = fixture.active_app_tool_session(&thread).await;
        let call = |id: &'static str, args: serde_json::Value| {
            fixture.orchestrator.execute_native_app_tool_call(thread.id, live.session_instance_id, id, "kybern_preview_open", args)
        };
        // Nobody is listening yet.
        assert_eq!(call("p0", json!({"target": "mock.html"})).await.unwrap()["status"], "no_client");
        let mut clients = fixture.orchestrator.subscribe_preview_requests();
        let shown = call("p1", json!({"target": "mock.html", "title": "Mock"})).await.unwrap();
        assert_eq!(shown["status"], "shown");
        let note = clients.try_recv().unwrap();
        assert_eq!((note.thread_id, note.title.as_deref(), note.requested_by_agent), (thread.id, Some("Mock"), true));
        assert!(note.target.ends_with("mock.html") && std::path::Path::new(&note.target).is_absolute());
        assert_eq!(call("p2", json!({"target": "http://localhost:5173"})).await.unwrap()["status"], "shown");
        assert_eq!(call("p3", json!({"target": "https://example.com/docs"})).await.unwrap()["status"], "opens_in_browser");
        let error = call("p4", json!({"target": "mock.html", "thread_id": Uuid::now_v7()})).await.unwrap_err();
        assert!(error.to_string().contains("bound to the current thread"), "{error}");
        assert!(call("p5", json!({"target": "mock.html", "allow_folder": true})).await.is_err(), "agents cannot grant folders");
        // Archiving a thread revokes its preview tickets.
        let ticket =
            fixture.orchestrator.inner.previews.mint(crate::previews::tickets::TicketKind::Files { root: work.clone() }, thread.id, None);
        assert!(fixture.orchestrator.inner.previews.lookup(&ticket).is_some());
        fixture.orchestrator.archive_thread(thread.id).await.unwrap();
        assert!(fixture.orchestrator.inner.previews.lookup(&ticket).is_none());
        let _ = std::fs::remove_dir_all(&work);
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
    async fn omp_background_job_timeout_after_its_turn_completes_the_task_as_failed() {
        let fixture = Fixture::new();
        let thread = fixture.thread_with_provider(ThreadStatus::Idle, ProviderKind::Omp);
        let (live, _) = fixture.park(&thread, Instant::now()).await;
        fixture.orchestrator.send(thread.id, UserMessage::text("run the slow command")).await.unwrap();
        live.turn_ready.notified().await;
        let task = DriverRuntimeTask {
            id: "tool:call-1".into(),
            kind: RuntimeTaskKind::Process,
            status: RuntimeTaskStatus::Running,
            title: "sleep 30".into(),
            detail: None,
            provider_type: Some("bash".into()),
            parent_id: None,
            tool_call_id: Some("call-1".into()),
            provider_thread_id: Some("bg_2".into()),
            model: None,
            effort: None,
            backgrounded: true,
            last_tool_name: None,
            usage: None,
            stats: RuntimeTaskStats::default(),
            capabilities: RuntimeTaskCapabilities::default(),
        };
        fixture.orchestrator.handle_driver_event(thread.id, &live, DriverEvent::RuntimeTaskStarted(task)).await.unwrap();
        // Background work outlives the turn that started it.
        fixture.orchestrator.handle_driver_event(thread.id, &live, completed_response(StopReason::Completed)).await.unwrap();
        assert!(fixture.store.runtime_tasks_for_thread(thread.id).unwrap()[0].status.is_active());

        fixture
            .orchestrator
            .handle_driver_event(
                thread.id,
                &live,
                DriverEvent::RuntimeTaskCompleted(DriverRuntimeTaskUpdate {
                    detail: Some("Command timed out after 20 seconds".into()),
                    ..DriverRuntimeTaskUpdate::status("tool:call-1", RuntimeTaskStatus::Failed)
                }),
            )
            .await
            .unwrap();
        let tasks = fixture.store.runtime_tasks_for_thread(thread.id).unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].status, RuntimeTaskStatus::Failed);
        assert_eq!(tasks[0].title, "sleep 30");
        assert!(tasks[0].completed_at.is_some());
        assert!(tasks.iter().all(|task| !task.status.is_active()));
        assert!(matches!(
            &fixture.store.events_for_thread(thread.id).unwrap().last().unwrap().payload,
            EventPayload::RuntimeTaskCompleted { task } if task.status == RuntimeTaskStatus::Failed
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
        assert!(events.is_empty(), "notes are stored in the notes table, not as thread events");
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
                .set_notes(methods::ThreadNotesSetParams { thread_id: a.id, text: "x".repeat(512 * 1024 + 1), expected_revision: 2 })
                .is_err()
        );
    }

    #[tokio::test]
    async fn legacy_notepad_shims_the_thread_note_and_clearing_a_missing_note_saves_nothing() {
        let fixture = Fixture::new();
        let thread = fixture.thread(ThreadStatus::Idle);
        let cleared = fixture
            .orchestrator
            .set_notes(methods::ThreadNotesSetParams { thread_id: thread.id, text: String::new(), expected_revision: 0 })
            .unwrap();
        assert_eq!(cleared, methods::ThreadNotes::default());
        assert!(fixture.store.note_for_thread(thread.id).unwrap().is_none());

        let saved = fixture
            .orchestrator
            .set_notes(methods::ThreadNotesSetParams { thread_id: thread.id, text: "legacy text".into(), expected_revision: 0 })
            .unwrap();
        let note = fixture.store.note_for_thread(thread.id).unwrap().unwrap();
        assert_eq!(
            (note.body.as_str(), note.summary.revision, note.summary.scope),
            ("legacy text", saved.revision, methods::NoteScope::Thread)
        );
        assert_eq!(note.summary.title, thread.title);
        assert!(
            fixture
                .orchestrator
                .set_notes(methods::ThreadNotesSetParams { thread_id: Uuid::now_v7(), text: "x".into(), expected_revision: 0 })
                .is_err()
        );
    }

    #[tokio::test]
    async fn note_changes_are_published_and_unchanged_saves_stay_quiet() {
        let fixture = Fixture::new();
        let mut changes = fixture.orchestrator.subscribe_notes();
        let note = fixture
            .orchestrator
            .note_create(methods::NotesCreateParams {
                scope: methods::NoteScope::Project,
                project_id: Some(fixture.project.id),
                title: Some("Plan".into()),
                body: Some("- [ ] ship".into()),
            })
            .unwrap();
        assert_eq!(changes.try_recv().unwrap().note.unwrap().id, note.summary.id);

        let update = |body: &str, expected_revision| methods::NotesUpdateParams {
            id: Some(note.summary.id),
            thread_id: None,
            expected_revision,
            title: None,
            body: Some(body.into()),
        };
        fixture.orchestrator.note_update(update("- [ ] ship", 1)).unwrap();
        assert!(changes.try_recv().is_err(), "nothing changed, nothing published");
        let edited = fixture.orchestrator.note_update(update("- [x] ship", 1)).unwrap();
        assert_eq!(changes.try_recv().unwrap().note.unwrap().checklist, methods::NoteChecklist { done: 1, total: 1 });
        assert!(fixture.orchestrator.note_update(update("stale", 1)).is_err());
        assert!(changes.try_recv().is_err(), "a rejected save is not published");

        let both = methods::NotesUpdateParams { thread_id: Some(Uuid::now_v7()), ..update("x", edited.summary.revision) };
        assert!(fixture.orchestrator.note_update(both).is_err(), "exactly one of id and thread_id");
        fixture.orchestrator.note_delete(note.summary.id).unwrap();
        assert!(changes.try_recv().unwrap().note.unwrap().deleted_at.is_some());
        fixture.orchestrator.note_purge(note.summary.id).unwrap();
        assert_eq!(changes.try_recv().unwrap().purged_id, Some(note.summary.id));
    }

    #[tokio::test]
    async fn removing_a_project_moves_its_notes_to_recently_deleted_and_publishes_them() {
        let fixture = Fixture::new();
        let thread = fixture.thread(ThreadStatus::Idle);
        let page = fixture
            .orchestrator
            .note_create(methods::NotesCreateParams {
                scope: methods::NoteScope::Project,
                project_id: Some(fixture.project.id),
                title: Some("Plan".into()),
                body: None,
            })
            .unwrap();
        fixture
            .orchestrator
            .set_notes(methods::ThreadNotesSetParams { thread_id: thread.id, text: "thread note".into(), expected_revision: 0 })
            .unwrap();
        let mut changes = fixture.orchestrator.subscribe_notes();
        fixture.orchestrator.remove_project(fixture.project.id).unwrap();
        let mut deleted = [changes.try_recv().unwrap().note.unwrap(), changes.try_recv().unwrap().note.unwrap()];
        deleted.sort_by_key(|note| note.scope as u8);
        assert!(deleted.iter().all(|note| note.deleted_at.is_some()));
        assert_eq!(deleted[0].origin.as_deref(), Some("fixture"));
        assert_eq!(deleted[1].origin.as_deref(), Some(format!("fixture › {}", thread.title).as_str()));
        assert!(fixture.store.project_get(fixture.project.id).unwrap().is_none());
        assert!(fixture.store.note_get(page.summary.id).unwrap().is_some(), "the note outlives its project");
        assert!(fixture.orchestrator.remove_project(FREE_CHAT_PROJECT_ID).is_err());
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

    fn agent_task(id: &str, tool_call_id: Option<&str>, parent_id: Option<&str>) -> DriverRuntimeTask {
        DriverRuntimeTask {
            id: id.into(),
            kind: RuntimeTaskKind::Agent,
            status: RuntimeTaskStatus::Running,
            title: format!("Task {id}"),
            detail: None,
            provider_type: Some("Explore".into()),
            parent_id: parent_id.map(str::to_string),
            tool_call_id: tool_call_id.map(str::to_string),
            provider_thread_id: None,
            model: Some("claude-haiku".into()),
            effort: None,
            backgrounded: false,
            last_tool_name: None,
            usage: None,
            stats: RuntimeTaskStats::default(),
            capabilities: RuntimeTaskCapabilities { stop: true, background: true },
        }
    }

    fn agent_text(task_id: &str, id: &str, text: &str) -> DriverEvent {
        DriverEvent::MessageCompleted {
            message_id: id.into(),
            origin: EventOrigin::Agent { task_id: task_id.into(), provider_thread_id: None },
            text: text.into(),
            thinking: None,
        }
    }

    fn child_of(fixture: &Fixture, root: ThreadId, task_id: &str) -> Thread {
        fixture.store.subagent_thread_find(root, task_id).unwrap().expect("a child thread for the task")
    }

    async fn subagent_fixture() -> (Fixture, Thread, Arc<LiveSession>) {
        let fixture = Fixture::new();
        let thread = fixture.thread(ThreadStatus::Idle);
        let (live, _) = fixture.park(&thread, Instant::now()).await;
        fixture.orchestrator.send(thread.id, UserMessage::text("delegate")).await.unwrap();
        live.turn_ready.notified().await;
        (fixture, thread, live)
    }

    #[tokio::test]
    async fn a_subagent_becomes_a_read_only_thread_fed_by_its_own_output() {
        let (fixture, thread, live) = subagent_fixture().await;
        let o = &fixture.orchestrator;
        let launch = ToolCall { id: "toolu_1".into(), name: "Agent".into(), input: json!({"prompt":"Read note.txt"}), parent_id: None };
        o.handle_driver_event(thread.id, &live, DriverEvent::ToolStarted(launch)).await.unwrap();
        o.handle_driver_event(thread.id, &live, DriverEvent::SubagentPrompt { task_id: "task-1".into(), prompt: "Read note.txt".into() })
            .await
            .unwrap();
        o.handle_driver_event(thread.id, &live, DriverEvent::RuntimeTaskStarted(agent_task("task-1", Some("toolu_1"), None)))
            .await
            .unwrap();
        let child = child_of(&fixture, thread.id, "task-1");
        assert_eq!(child.parent_thread_id, Some(thread.id));
        assert_eq!(child.status, ThreadStatus::Running);
        let info = child.subagent.clone().unwrap();
        assert_eq!(
            (info.root_thread_id, info.status, info.tool_call_id.as_deref()),
            (thread.id, RuntimeTaskStatus::Running, Some("toolu_1"))
        );
        assert_eq!(info.agent_type.as_deref(), Some("Explore"));
        assert!(info.transcript && info.capabilities.stop);

        // The subagent's tool call stays nested in the parent and is mirrored into the child.
        let read = ToolCall {
            id: "toolu_2".into(),
            name: "Read".into(),
            input: json!({"file_path":"note.txt"}),
            parent_id: Some("toolu_1".into()),
        };
        o.handle_driver_event(thread.id, &live, DriverEvent::ToolStarted(read)).await.unwrap();
        o.handle_driver_event(
            thread.id,
            &live,
            DriverEvent::ToolCompleted { tool_call_id: "toolu_2".into(), output: json!({"content":"hi"}), is_error: false },
        )
        .await
        .unwrap();
        o.handle_driver_event(thread.id, &live, agent_text("toolu_1", "msg-1", "The note says hello.\nMore detail.")).await.unwrap();
        o.handle_driver_event(
            thread.id,
            &live,
            DriverEvent::RuntimeTaskCompleted(DriverRuntimeTaskUpdate::status("task-1", RuntimeTaskStatus::Completed)),
        )
        .await
        .unwrap();

        let parent_events = fixture.store.events_for_thread(thread.id).unwrap();
        assert!(
            !parent_events.iter().any(|event| matches!(&event.payload, EventPayload::AssistantMessageCompleted { .. })),
            "child prose never reaches the parent transcript"
        );
        assert!(parent_events.iter().any(|event| matches!(&event.payload,
            EventPayload::ToolCallStarted { call, origin: EventOrigin::Agent { .. } } if call.id == "toolu_2" && call.parent_id.as_deref() == Some("toolu_1"))));
        assert!(
            parent_events.iter().any(|event| matches!(&event.payload, EventPayload::RuntimeTaskStarted { task } if task.id == "task-1"))
        );

        let events = fixture.store.events_for_thread(child.id).unwrap();
        let kinds: Vec<_> = events.iter().map(|event| event.payload.kind()).collect();
        assert_eq!(
            kinds,
            [
                "thread_created",
                "turn_started",
                "tool_call_started",
                "thread_updated",
                "tool_call_completed",
                "assistant_message_completed",
                "turn_completed",
                "thread_updated"
            ]
        );
        assert!(matches!(&events[1].payload, EventPayload::TurnStarted { message, .. } if message.plain_text() == "Read note.txt"));
        assert!(matches!(&events[2].payload,
            EventPayload::ToolCallStarted { call, origin: EventOrigin::Root } if call.parent_id.is_none() && call.name == "Read"));
        let message_id = match &events[5].payload {
            EventPayload::AssistantMessageCompleted { message_id, origin: EventOrigin::Root, .. } => *message_id,
            other => panic!("unexpected {other:?}"),
        };
        assert!(matches!(&events[6].payload,
            EventPayload::TurnCompleted { stop_reason: StopReason::Completed, terminal_message_id: Some(id), .. } if *id == message_id));
        let done = child_of(&fixture, thread.id, "task-1");
        assert_eq!(done.status, ThreadStatus::Idle);
        let info = done.subagent.unwrap();
        assert_eq!(info.result.as_deref(), Some("The note says hello."));
        assert!(info.progress.is_none() && info.completed_at.is_some());

        // The transcript projects like any other thread.
        let transcript = fixture.store.project_transcript_through(child.id, done.last_seq).unwrap();
        assert!(
            transcript
                .iter()
                .any(|entry| matches!(entry, TranscriptEntry::Assistant { text, .. } if text.starts_with("The note says hello")))
        );

        // Read-only.
        let rejected = o.send(child.id, UserMessage::text("hi")).await.unwrap_err().to_string();
        assert!(rejected.contains("read-only"), "{rejected}");
        assert!(
            o.update_thread_fields(methods::ThreadsUpdateParams {
                thread_id: child.id,
                title: Some("x".into()),
                pinned: None,
                permission_mode: None,
                model: None,
                effort: None
            })
            .is_err()
        );
        // Lists leave them to callers that ask.
        assert_eq!(fixture.store.subagent_children(thread.id).unwrap().len(), 1);
    }

    #[tokio::test]
    async fn subagent_output_waits_for_its_task_and_nested_agents_hang_below_their_parent() {
        let (fixture, thread, live) = subagent_fixture().await;
        let o = &fixture.orchestrator;
        // Output that arrives before the task starts is held, then delivered.
        o.handle_driver_event(thread.id, &live, agent_text("toolu_1", "early", "Early words")).await.unwrap();
        o.handle_driver_event(thread.id, &live, DriverEvent::RuntimeTaskStarted(agent_task("task-1", Some("toolu_1"), None)))
            .await
            .unwrap();
        let first = child_of(&fixture, thread.id, "task-1");
        assert!(fixture.store.events_for_thread(first.id).unwrap().iter().any(|event| matches!(&event.payload,
            EventPayload::AssistantMessageCompleted { text, .. } if text == "Early words")));

        // A tool call the first subagent makes launches a second one below it.
        let launch = ToolCall { id: "toolu_nested".into(), name: "Agent".into(), input: json!({}), parent_id: Some("toolu_1".into()) };
        o.handle_driver_event(thread.id, &live, DriverEvent::ToolStarted(launch)).await.unwrap();
        o.handle_driver_event(thread.id, &live, DriverEvent::RuntimeTaskStarted(agent_task("task-2", Some("toolu_nested"), None)))
            .await
            .unwrap();
        let second = child_of(&fixture, thread.id, "task-2");
        assert_eq!(second.parent_thread_id, Some(first.id));
        assert_eq!(second.subagent.as_ref().unwrap().root_thread_id, thread.id);
        // The first subagent's own thread shows the launch row.
        assert!(fixture.store.runtime_tasks_for_thread(first.id).unwrap().iter().any(|task| task.id == "task-2"));

        // Archiving the parent settles and archives the whole subtree.
        o.archive_thread(thread.id).await.unwrap();
        for id in [first.id, second.id] {
            assert_eq!(fixture.store.thread_get(id).unwrap().unwrap().status, ThreadStatus::Archived);
            assert!(fixture.store.events_for_thread(id).unwrap().iter().any(|event| matches!(event.payload, EventPayload::ThreadArchived)));
        }
    }

    #[tokio::test]
    async fn codex_style_subagent_output_goes_only_to_its_thread_and_the_prompt_may_arrive_late() {
        let fixture = Fixture::new();
        let thread = fixture.thread_with_provider(ThreadStatus::Idle, ProviderKind::Codex);
        let (live, _) = fixture.park(&thread, Instant::now()).await;
        let o = &fixture.orchestrator;
        o.send(thread.id, UserMessage::text("delegate")).await.unwrap();
        live.turn_ready.notified().await;
        let mut task = agent_task("child-thread", None, None);
        task.provider_thread_id = Some("child-thread".into());
        o.handle_driver_event(thread.id, &live, DriverEvent::RuntimeTaskStarted(task)).await.unwrap();
        let child = child_of(&fixture, thread.id, "child-thread");
        let wrap = |event| DriverEvent::SubagentOnly { task_id: "child-thread".into(), event: Box::new(event) };
        // The turn has not started: its first message is still unknown.
        assert!(
            !fixture
                .store
                .events_for_thread(child.id)
                .unwrap()
                .iter()
                .any(|event| matches!(event.payload, EventPayload::TurnStarted { .. }))
        );
        o.handle_driver_event(
            thread.id,
            &live,
            DriverEvent::SubagentPrompt { task_id: "child-thread".into(), prompt: "Review the diff".into() },
        )
        .await
        .unwrap();
        o.handle_driver_event(
            thread.id,
            &live,
            wrap(DriverEvent::ToolStarted(ToolCall {
                id: "cmd-1".into(),
                name: "shell".into(),
                input: json!({"command":"git diff"}),
                parent_id: None,
            })),
        )
        .await
        .unwrap();
        o.handle_driver_event(thread.id, &live, wrap(DriverEvent::ToolOutputDelta { tool_call_id: "cmd-1".into(), delta: "+line".into() }))
            .await
            .unwrap();
        o.handle_driver_event(
            thread.id,
            &live,
            wrap(DriverEvent::ToolCompleted { tool_call_id: "cmd-1".into(), output: json!({}), is_error: false }),
        )
        .await
        .unwrap();
        o.handle_driver_event(
            thread.id,
            &live,
            wrap(DriverEvent::ThinkingDelta { message_id: "r1".into(), origin: EventOrigin::Root, delta: "hmm".into() }),
        )
        .await
        .unwrap();
        o.handle_driver_event(
            thread.id,
            &live,
            wrap(DriverEvent::ThinkingCompleted { message_id: "r1".into(), origin: EventOrigin::Root }),
        )
        .await
        .unwrap();
        o.handle_driver_event(
            thread.id,
            &live,
            wrap(DriverEvent::TextDelta { message_id: "m1".into(), origin: EventOrigin::Root, delta: "Looks".into() }),
        )
        .await
        .unwrap();
        o.handle_driver_event(
            thread.id,
            &live,
            wrap(DriverEvent::MessageCompleted {
                message_id: "m1".into(),
                origin: EventOrigin::Root,
                text: "Looks fine".into(),
                thinking: None,
            }),
        )
        .await
        .unwrap();

        let events = fixture.store.events_for_thread(child.id).unwrap();
        let kinds: Vec<_> = events.iter().map(|event| event.payload.kind()).collect();
        assert_eq!(
            kinds,
            [
                "thread_created",
                "turn_started",
                "tool_call_started",
                "tool_call_output_delta",
                "tool_call_completed",
                "assistant_thinking_delta",
                "assistant_thinking_completed",
                "assistant_text_delta",
                "assistant_message_completed"
            ]
        );
        // Reasoning, text and the final message share one logical message.
        let ids: HashSet<_> = events
            .iter()
            .filter_map(|event| match &event.payload {
                EventPayload::AssistantThinkingDelta { message_id, .. }
                | EventPayload::AssistantTextDelta { message_id, .. }
                | EventPayload::AssistantMessageCompleted { message_id, .. } => Some(*message_id),
                _ => None,
            })
            .collect();
        assert_eq!(ids.len(), 1);
        let parent = fixture.store.events_for_thread(thread.id).unwrap();
        assert!(!parent.iter().any(|event| matches!(
            &event.payload,
            EventPayload::ToolCallStarted { .. } | EventPayload::ToolCallOutputDelta { .. } | EventPayload::AssistantTextDelta { .. }
        )));
    }

    #[tokio::test]
    async fn stopping_a_subagent_thread_stops_its_task_in_the_root_session() {
        let fixture = Fixture::new();
        let thread = fixture.thread(ThreadStatus::Idle);
        let stopped = Arc::new(Mutex::new(Vec::new()));
        let live = Arc::new(LiveSession {
            session_instance_id: Uuid::now_v7(),
            session: Box::new(TestSession { stopped_tasks: stopped.clone(), ..Default::default() }),
            computer_tools: false,
            last_activity: std::sync::Mutex::new(SessionActivityTime::now()),
            released: AtomicBool::new(false),
            retained: AtomicBool::new(false),
            stop_cleanup: AtomicBool::new(false),
            turn: Mutex::new(None),
            continuation: Mutex::new(None),
            turn_ready: tokio::sync::Notify::new(),
            last_turn_id: Mutex::new(None),
            tasks: Mutex::new(HashMap::new()),
            task_aliases: Mutex::new(HashMap::new()),
            deferred_checkpoints: Mutex::new(HashSet::new()),
            pending: Mutex::new(HashMap::new()),
            daemon_approvals: Mutex::new(HashMap::new()),
            app_tool_requests: Mutex::new(HashSet::new()),
            app_tool_permits: Arc::new(Semaphore::new(crate::app_tools::MAX_CONCURRENT_REQUESTS)),
        });
        fixture.orchestrator.inner.sessions.lock().await.insert(thread.id, live.clone());
        fixture.orchestrator.send(thread.id, UserMessage::text("delegate")).await.unwrap();
        live.turn_ready.notified().await;
        let o = &fixture.orchestrator;
        o.handle_driver_event(thread.id, &live, DriverEvent::RuntimeTaskStarted(agent_task("task-1", Some("toolu_1"), None)))
            .await
            .unwrap();
        let child = child_of(&fixture, thread.id, "task-1");
        // Interrupting the child thread (or tasks.stop with its id) stops that subagent only.
        o.interrupt(child.id).await.unwrap();
        assert_eq!(*stopped.lock().await, ["task-1"]);
        assert_eq!(child_of(&fixture, thread.id, "task-1").subagent.unwrap().status, RuntimeTaskStatus::Stopping);
        o.handle_driver_event(
            thread.id,
            &live,
            DriverEvent::RuntimeTaskCompleted(DriverRuntimeTaskUpdate::status("task-1", RuntimeTaskStatus::Stopped)),
        )
        .await
        .unwrap();
        let done = child_of(&fixture, thread.id, "task-1");
        assert_eq!(done.status, ThreadStatus::Idle);
        assert!(
            fixture
                .store
                .events_for_thread(child.id)
                .unwrap()
                .iter()
                .any(|event| matches!(event.payload, EventPayload::TurnCompleted { stop_reason: StopReason::Interrupted, .. }))
        );
    }

    #[tokio::test]
    async fn a_daemon_restart_settles_running_subagent_threads() {
        let (fixture, thread, live) = subagent_fixture().await;
        fixture
            .orchestrator
            .handle_driver_event(thread.id, &live, DriverEvent::RuntimeTaskStarted(agent_task("task-1", None, None)))
            .await
            .unwrap();
        let child = child_of(&fixture, thread.id, "task-1");
        assert_eq!(child.status, ThreadStatus::Running);
        fixture.orchestrator.recover_after_restart().await.unwrap();
        let after = child_of(&fixture, thread.id, "task-1");
        assert_eq!(after.status, ThreadStatus::Idle);
        assert_eq!(after.subagent.unwrap().status, RuntimeTaskStatus::Interrupted);
        let kinds: Vec<_> = fixture.store.events_for_thread(child.id).unwrap().iter().map(|event| event.payload.kind()).collect();
        assert_eq!(kinds.iter().filter(|kind| **kind == "turn_completed").count(), 1);
        assert!(!kinds.contains(&"turn_failed"));
    }

    include!("orchestrator/delegation_tests.rs");
    include!("orchestrator/messaging_tests.rs");
    include!("orchestrator/account_tests.rs");
    include!("orchestrator/worktree_tests.rs");
    include!("orchestrator/subagent_messaging_tests.rs");
}
