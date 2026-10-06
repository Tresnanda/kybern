//! Orchestrator V2 delegation engine: `kybern_agent_*` tools, child threads,
//! completion batching, stop/archive cascades, restart recovery and cleanup of
//! delegated worktrees. See `docs/design/orchestrator-v2.md` (sections 2 and 3).
//!
//! The hooks in `orchestrator.rs` stay small and call into this module. Two
//! rules keep it free of lock inversions: completion work is spawned after
//! `emit` returns (never from inside `update_thread` or the `commands` mutex),
//! and every status change goes through [`Orchestrator::delegation_update`],
//! which re-reads the thread under `thread_updates` so a stale copy elsewhere
//! can never roll a delegation back.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::Duration;

use anyhow::{Result, anyhow, bail, ensure};
use chrono::Utc;
use kybern_git::Repo;
use kybern_protocol::*;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Notify;
use uuid::Uuid;

use super::{LiveSession, Orchestrator, derived_operation_id, truncate_utf8};

/// Names of the tools this module serves.
pub(crate) const TOOL_NAMES: [&str; 6] = [
    "kybern_agent_capabilities",
    "kybern_agent_delegate",
    "kybern_agent_status",
    "kybern_agent_cancel",
    "kybern_agent_wait",
    "kybern_thread_interrupt",
];

/// Tools that can block for up to a minute and so need the long request timeout.
pub(crate) const BLOCKING_TOOLS: [&str; 2] = ["kybern_agent_delegate", "kybern_agent_wait"];

pub(crate) fn is_tool(name: &str) -> bool {
    TOOL_NAMES.contains(&name)
}

/// Child result text kept on the thread (UTF-8 bytes).
const RESULT_CAP: usize = 16 * 1024;
/// Result text returned by `kybern_agent_status`.
const STATUS_RESULT_CAP: usize = 4 * 1024;
const FILES_CAP_ITEM: usize = 50;
const MAX_TITLE_CHARS: usize = 60;
const MAX_OWNS: usize = 32;
const WAIT_DEFAULT_MS: u64 = 55_000;
const WAIT_MAX_MS: u64 = 60_000;
const DEFAULT_DEBOUNCE_MS: u64 = 1_500;
const STATUS_LIMIT: usize = 20;

/// Harnesses whose sessions accept a message inside a running turn.
pub(crate) fn harness_supports_steer(kind: ProviderKind) -> bool {
    matches!(kind, ProviderKind::ClaudeCode | ProviderKind::Codex | ProviderKind::Pi | ProviderKind::Omp)
}

/// Daemon-side state of the delegation engine.
pub(super) struct DelegationState {
    /// Results waiting for the debounce window to close, per delegating thread.
    pending: std::sync::Mutex<HashMap<ThreadId, PendingBatch>>,
    /// Tasks whose outcome a blocked `wait` call already returned; skipped in batches.
    inline_delivered: std::sync::Mutex<HashSet<Uuid>>,
    /// Notified after every delegation change so `wait` calls re-check.
    changed: Notify,
    /// Serializes the limit check with the insert so parallel delegations cannot overshoot.
    create: tokio::sync::Mutex<()>,
    debounce_ms: std::sync::atomic::AtomicU64,
}

impl Default for DelegationState {
    fn default() -> Self {
        Self {
            pending: Default::default(),
            inline_delivered: Default::default(),
            changed: Notify::new(),
            create: Default::default(),
            debounce_ms: std::sync::atomic::AtomicU64::new(DEFAULT_DEBOUNCE_MS),
        }
    }
}

#[derive(Default)]
struct PendingBatch {
    items: Vec<AgentResultItem>,
    scheduled: bool,
}

/// How a turn of a delegated child ended.
pub(super) enum TurnOutcome {
    Completed { stop_reason: StopReason, terminal_message_id: Option<MessageId> },
    Failed(String),
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
enum DelegateMode {
    #[default]
    Async,
    Wait,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyArgs {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DelegateArgs {
    #[serde(default)]
    operation_id: Option<Uuid>,
    task: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    role: Option<DelegationRole>,
    #[serde(default)]
    provider: Option<ProviderKind>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    effort: Option<String>,
    #[serde(default)]
    permission_mode: Option<PermissionMode>,
    #[serde(default)]
    workspace: Option<DelegationWorkspace>,
    #[serde(default)]
    owns: Option<Vec<String>>,
    #[serde(default)]
    mode: Option<DelegateMode>,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StatusArgs {
    #[serde(default)]
    task_ids: Option<Vec<Uuid>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CancelArgs {
    #[serde(default)]
    #[allow(dead_code)]
    operation_id: Option<Uuid>,
    task_id: Uuid,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WaitArgs {
    #[serde(default)]
    task_ids: Option<Vec<Uuid>>,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InterruptArgs {
    #[serde(default)]
    #[allow(dead_code)]
    operation_id: Option<Uuid>,
    thread_id: ThreadId,
}

/// The mode a delegated child gets: the parent's unless a subset is asked for.
///
/// A child may never hold more authority than its parent. Crossing to another
/// harness cannot carry an `accept-edits` or `auto` mapping, so it drops to
/// `supervised` unless the parent has full access. An explicit request must be
/// `supervised`, the parent's own mode on the same harness, or anything when
/// the parent has full access.
pub(super) fn resolve_child_permission(
    parent_mode: PermissionMode,
    parent_kind: ProviderKind,
    child_kind: ProviderKind,
    requested: Option<PermissionMode>,
) -> Result<PermissionMode> {
    let crosses_provider = child_kind != parent_kind;
    let requested = requested.unwrap_or(if crosses_provider && parent_mode != PermissionMode::FullAccess {
        PermissionMode::Supervised
    } else {
        parent_mode
    });
    let allowed = parent_mode == PermissionMode::FullAccess
        || requested == PermissionMode::Supervised
        || (!crosses_provider && requested == parent_mode);
    if !allowed {
        return Err(anyhow!(
            "child permission mode has no conservative subset mapping for the parent harness; use supervised or delegate from a full-access parent"
        ));
    }
    Ok(requested)
}

fn truncate_with_marker(text: &str, max_bytes: usize) -> String {
    let mut text = text.to_owned();
    if text.len() > max_bytes {
        truncate_utf8(&mut text, max_bytes);
        text.push_str("\n\n[result truncated]");
    }
    text
}

fn child_title(title: Option<&str>, task: &str) -> String {
    let source = title
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| task.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or("Delegated task"));
    let collapsed = source.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= MAX_TITLE_CHARS {
        return collapsed;
    }
    let mut short: String = collapsed.chars().take(MAX_TITLE_CHARS - 1).collect();
    short.push('…');
    short
}

fn validate_owns(owns: &[String]) -> Result<()> {
    ensure!(owns.len() <= MAX_OWNS, "owns takes at most {MAX_OWNS} globs. Group paths with ** instead.");
    for glob in owns {
        ensure!(
            !glob.trim().is_empty() && glob.len() <= 256,
            "each owns glob must be a non-empty path pattern of at most 256 bytes, such as src/api/**"
        );
        let path = Path::new(glob);
        ensure!(
            !path.is_absolute() && path.components().all(|part| !matches!(part, std::path::Component::ParentDir)),
            "owns globs are relative to the checkout root and cannot leave it: {glob}"
        );
    }
    Ok(())
}

/// The first user message of a delegated child (contract section 2.2, step 6).
fn delegation_brief(
    role: DelegationRole,
    parent_title: &str,
    workspace: DelegationWorkspace,
    owns: &[String],
    branch: Option<&str>,
    task: &str,
) -> String {
    let rules = match workspace {
        DelegationWorkspace::Shared => {
            let mut rules = String::from(
                "You share the parent's checkout and branch. Do not commit, stash, reset, checkout, rebase or switch branches; the parent integrates.",
            );
            if owns.is_empty() {
                rules.push_str(" Other agents may be editing this checkout; keep edits focused on your task.");
            } else {
                rules.push_str(&format!(" You own: {}. Avoid editing other paths; other agents may own them.", owns.join(", ")));
            }
            rules
        }
        DelegationWorkspace::Worktree => format!(
            "You work in your own worktree on branch {}, seeded from the parent's current changes. Commit your work on this branch before you finish. Do not push.",
            branch.unwrap_or("kybern/<child>")
        ),
    };
    format!(
        "You are a delegated {role} agent working for thread \"{parent_title}\".\n{rules}\nYour final message is returned to the parent as your result, so end with a concise summary of what you did, what changed, and anything unresolved.\n\nTask:\n{task}"
    )
}

/// One finished (or running) delegation as an [`AgentResultItem`].
pub(super) fn agent_result_item(thread: &Thread) -> Option<AgentResultItem> {
    let info = thread.delegation.as_ref()?;
    Some(AgentResultItem {
        task_id: info.task_id,
        thread_id: thread.id,
        title: thread.title.clone(),
        provider: thread.provider.kind,
        model: thread.model.clone(),
        role: info.role,
        status: info.status,
        result: info.result.clone(),
        error: info.error.clone(),
        workspace: info.workspace,
        branch: info.branch.clone(),
        head_commit: info.head_commit.clone(),
        diffstat: info.diffstat,
        files_touched: info.files_touched.iter().take(FILES_CAP_ITEM).cloned().collect(),
        conflicts: info.conflicts.clone(),
    })
}

/// The JSON a tool returns for one delegation.
fn delegation_view(thread: &Thread, result_cap: usize) -> Value {
    let Some(info) = thread.delegation.as_ref() else { return json!({"thread_id": thread.id}) };
    let end = info.completed_at.unwrap_or_else(Utc::now);
    let elapsed_ms = (end - info.started_at).num_milliseconds().max(0);
    let mut view = json!({
        "task_id": info.task_id,
        "thread_id": thread.id,
        "title": thread.title,
        "provider": thread.provider.kind,
        "model": thread.model,
        "role": info.role,
        "workspace": info.workspace,
        "status": info.status,
        "elapsed_ms": elapsed_ms,
        "started_at": info.started_at,
    });
    let object = view.as_object_mut().expect("view is an object");
    if let Some(result) = &info.result {
        object.insert("result".into(), json!(truncate_with_marker(result, result_cap)));
    }
    if let Some(error) = &info.error {
        object.insert("error".into(), json!(error));
    }
    if let Some(at) = info.completed_at {
        object.insert("completed_at".into(), json!(at));
    }
    if !info.files_touched.is_empty() {
        object.insert("files_touched".into(), json!(info.files_touched.iter().take(FILES_CAP_ITEM).collect::<Vec<_>>()));
    }
    if !info.conflicts.is_empty() {
        object.insert("conflicts".into(), json!(info.conflicts));
    }
    if let Some(branch) = &info.branch {
        object.insert("branch".into(), json!(branch));
    }
    if let Some(commit) = &info.head_commit {
        object.insert("head_commit".into(), json!(commit));
    }
    if let Some(diffstat) = info.diffstat {
        object.insert("diffstat".into(), json!(diffstat));
    }
    if let Some(state) = info.worktree_state {
        object.insert("worktree_state".into(), json!(state));
    }
    view
}

impl Orchestrator {
    /// Shorten the batching window (tests only).
    #[cfg(test)]
    pub(crate) fn set_delegation_debounce(&self, delay: Duration) {
        self.inner.delegation.debounce_ms.store(delay.as_millis() as u64, std::sync::atomic::Ordering::Relaxed);
    }

    /// Whether this thread may use the `kybern_collaboration_*` tools: project
    /// coordinators and the members of a coordinator group. Everyone else
    /// delegates with `kybern_agent_delegate`.
    pub(super) fn collaboration_tools_enabled(&self, thread: &Thread) -> Result<bool> {
        if thread.coordinator_project_id.is_some() {
            return Ok(true);
        }
        let group_id = match thread.collaboration_group_id {
            Some(group_id) => Some(group_id),
            None => self.inner.store.collaboration_group_for_thread(thread.id)?,
        };
        match group_id {
            Some(group_id) => Ok(self.inner.store.project_coordinator_for_group(group_id)?.is_some()),
            None => Ok(false),
        }
    }

    // ---- tool dispatch ----

    pub(super) async fn execute_agent_tool(
        &self,
        thread: &Thread,
        turn_id: TurnId,
        live: &LiveSession,
        name: &str,
        arguments: Value,
    ) -> Result<Value> {
        match name {
            "kybern_agent_capabilities" => {
                let _: EmptyArgs = crate::app_tools::parse(arguments)?;
                self.agent_capabilities(thread).await
            }
            "kybern_agent_delegate" => self.agent_delegate(thread, turn_id, live, crate::app_tools::parse(arguments)?).await,
            "kybern_agent_status" => self.agent_status(thread, crate::app_tools::parse(arguments)?),
            "kybern_agent_wait" => self.agent_wait(thread, crate::app_tools::parse(arguments)?).await,
            "kybern_agent_cancel" => {
                let args: CancelArgs = crate::app_tools::parse(arguments)?;
                let child = self
                    .inner
                    .store
                    .delegation_find_by_task(args.task_id)?
                    .ok_or_else(|| anyhow!("unknown task_id. Call kybern_agent_status to list your agents."))?;
                self.agent_cancel_child(thread, turn_id, live, child).await
            }
            "kybern_thread_interrupt" => {
                let args: InterruptArgs = crate::app_tools::parse(arguments)?;
                let child = self
                    .inner
                    .store
                    .thread_get(args.thread_id)?
                    .filter(|child| child.delegation.is_some())
                    .ok_or_else(|| anyhow!("kybern_thread_interrupt only works on threads you delegated work to"))?;
                self.agent_cancel_child(thread, turn_id, live, child).await
            }
            _ => bail!("unknown Kybern agent tool: {name}"),
        }
    }

    async fn ensure_turn_active(live: &LiveSession, turn_id: TurnId) -> Result<()> {
        let guard = live.turn.lock().await;
        if guard.as_ref().is_none_or(|turn| turn.id != turn_id || turn.completed) {
            bail!("native tool caller turn ended before mutation reservation");
        }
        Ok(())
    }

    fn orchestration_limits(&self) -> (u32, u32) {
        let settings = self.inner.settings.get().orchestration;
        (settings.max_active_children.clamp(1, 16), settings.max_depth.clamp(1, 4))
    }

    /// Whether `ancestor` sits above `child` in the parent chain.
    fn is_descendant_of(&self, ancestor: ThreadId, child: &Thread) -> Result<bool> {
        let mut cursor = child.parent_thread_id;
        for _ in 0..16 {
            match cursor {
                Some(id) if id == ancestor => return Ok(true),
                Some(id) => cursor = self.inner.store.thread_get(id)?.and_then(|thread| thread.parent_thread_id),
                None => return Ok(false),
            }
        }
        Ok(false)
    }

    // ---- kybern_agent_capabilities ----

    async fn agent_capabilities(&self, caller: &Thread) -> Result<Value> {
        let cached = self.cached_provider_statuses(caller.project_id).await?;
        let (statuses, catalog_state) = match cached {
            Some(statuses) => (statuses, "cached"),
            None => match tokio::time::timeout(Duration::from_secs(10), self.refresh_provider_statuses(caller.project_id)).await {
                Ok(Ok(statuses)) => (statuses, "fresh"),
                _ => (Vec::new(), "loading"),
            },
        };
        let settings = self.inner.settings.get();
        let mut harnesses: Vec<Value> = statuses
            .into_iter()
            .map(|status| {
                let configured = settings.providers.get(&status.kind).and_then(|provider| provider.model.clone());
                let default_model = status.models.iter().find(|model| model.is_default).map(|model| model.id.clone()).or(configured);
                let model_count = status.models.len();
                let models: Vec<Value> = status
                    .models
                    .into_iter()
                    .take(32)
                    .map(|model| {
                        json!({
                            "id": model.id,
                            "display_name": model.display_name,
                            "efforts": model.efforts.into_iter().take(20).collect::<Vec<_>>(),
                            "default_effort": model.default_effort,
                            "is_default": model.is_default,
                        })
                    })
                    .collect();
                json!({
                    "provider": status.kind,
                    "display_name": status.display_name,
                    "available": status.available,
                    "unavailable_reason": status.unavailable_reason,
                    "supports_steer": harness_supports_steer(status.kind),
                    "supported_permission_modes": status.supported_permission_modes,
                    "supported_efforts": status.supported_efforts,
                    "default_model": default_model,
                    "models": models,
                    "models_truncated": model_count.saturating_sub(32),
                })
            })
            .collect();
        if harnesses.is_empty() {
            harnesses = ProviderKind::ALL
                .into_iter()
                .filter(|kind| self.inner.drivers.get(*kind).is_some())
                .map(|kind| json!({"provider": kind, "available": null, "supports_steer": harness_supports_steer(kind), "models": []}))
                .collect();
        }
        let (max_children, max_depth) = self.orchestration_limits();
        let depth = caller.delegation.as_ref().map_or(0, |info| u32::from(info.depth));
        let active = self.inner.store.delegation_active_count(caller.id)?;
        Ok(json!({
            "harnesses": harnesses,
            "catalog_state": catalog_state,
            "you": {
                "provider": caller.provider.kind,
                "model": caller.model,
                "effort": caller.effort,
                "permission_mode": caller.permission_mode,
            },
            "limits": {
                "max_active_children": max_children,
                "max_depth": max_depth,
                "caller_depth": depth,
                "active_children": active,
                "can_delegate": depth < max_depth && active < max_children,
            },
        }))
    }

    // ---- kybern_agent_delegate ----

    async fn agent_delegate(&self, parent: &Thread, turn_id: TurnId, live: &LiveSession, args: DelegateArgs) -> Result<Value> {
        let operation_id = args.operation_id.unwrap_or_else(Uuid::now_v7);
        let mode = args.mode.unwrap_or_default();
        let timeout = Duration::from_millis(args.timeout_ms.unwrap_or(WAIT_DEFAULT_MS).clamp(1, WAIT_MAX_MS));

        if let Some(existing) = self.inner.store.delegation_find_by_operation(operation_id)? {
            return self.delegate_response(existing, parent.id, mode, timeout).await;
        }
        let task = args.task.trim().to_owned();
        ensure!(!task.is_empty(), "task is required: write the full brief for the agent");
        let workspace = args.workspace.unwrap_or_default();
        let owns = args.owns.unwrap_or_default();
        ensure!(
            workspace == DelegationWorkspace::Shared || owns.is_empty(),
            "owns only applies to a shared workspace. A worktree agent has its own copy of the files."
        );
        validate_owns(&owns)?;
        Self::ensure_turn_active(live, turn_id).await?;

        let _creating = self.inner.delegation.create.lock().await;
        // A retry that raced the first call finds the child created under the lock.
        if let Some(existing) = self.inner.store.delegation_find_by_operation(operation_id)? {
            return self.delegate_response(existing, parent.id, mode, timeout).await;
        }

        // Limits.
        let (max_children, max_depth) = self.orchestration_limits();
        let depth = parent.delegation.as_ref().map_or(0, |info| u32::from(info.depth)) + 1;
        ensure!(
            depth <= max_depth,
            "Delegation depth limit reached (max {max_depth}). Do this work yourself, or ask the user to raise \"Delegation depth\" in Settings."
        );
        let active = self.inner.store.delegation_active_count(parent.id)?;
        ensure!(
            active < max_children,
            "You already have {active} delegated agents running (max {max_children}). End your turn to be woken with their results, or cancel one with kybern_agent_cancel."
        );

        // Harness, model, effort and permissions (all default to the parent's).
        let kind = args.provider.unwrap_or(parent.provider.kind);
        ensure!(
            self.inner.drivers.get(kind).is_some(),
            "{kind} is not available in this build. Call kybern_agent_capabilities to see the installed harnesses."
        );
        if let Some(statuses) = self.cached_provider_statuses(parent.project_id).await?
            && let Some(status) = statuses.iter().find(|status| status.kind == kind)
            && !status.available
        {
            bail!(
                "{kind} is not installed or usable: {}. Call kybern_agent_capabilities to pick another harness.",
                status.unavailable_reason.as_deref().unwrap_or("it was not found")
            );
        }
        let same_kind = kind == parent.provider.kind;
        let provider = if same_kind { parent.provider.clone() } else { ProviderInstance::default_for(kind) };
        let configured_model = self.inner.settings.get().providers.get(&kind).and_then(|provider| provider.model.clone());
        let model = args
            .model
            .clone()
            .filter(|model| !model.trim().is_empty())
            .or_else(|| same_kind.then(|| parent.model.clone()).flatten())
            .or(configured_model);
        let effort = args
            .effort
            .clone()
            .filter(|effort| !effort.trim().is_empty())
            .or_else(|| (same_kind && args.model.is_none()).then(|| parent.effort.clone()).flatten());
        self.validate_provider_selection(parent.project_id, &provider, model.as_deref(), effort.as_deref()).await?;
        let permission_mode = resolve_child_permission(parent.permission_mode, parent.provider.kind, kind, args.permission_mode)?;

        // Workspace.
        let project = self.inner.store.project_get(parent.project_id)?.ok_or_else(|| anyhow!("project not found"))?;
        let child_id = Uuid::now_v7();
        let task_id = Uuid::now_v7();
        let (cwd, worktree, base_commit, branch) = match workspace {
            DelegationWorkspace::Shared => (parent.cwd.clone(), parent.worktree.clone(), None, None),
            DelegationWorkspace::Worktree => {
                ensure!(
                    Repo::is_repo(Path::new(&parent.cwd)).await,
                    "A worktree needs a git repository, and this project is not one. Use workspace \"shared\"."
                );
                let repo = Repo::new(&parent.cwd);
                let base = repo.snapshot("kybern delegation base").await?;
                let branch = format!("kybern/{child_id}");
                let dir = self.inner.paths.worktrees.join(&project.name).join(child_id.to_string());
                if let Some(parent_dir) = dir.parent() {
                    std::fs::create_dir_all(parent_dir)?;
                }
                repo.worktree_add(&dir, &branch, Some(&base)).await?;
                let path = dir.to_string_lossy().into_owned();
                (path.clone(), Some(WorktreeInfo { path, branch: branch.clone() }), Some(base), Some(branch))
            }
        };

        let now = Utc::now();
        let role = args.role.unwrap_or_default();
        let info = DelegationInfo {
            task_id,
            operation_id,
            parent_thread_id: parent.id,
            depth: depth as u8,
            role,
            workspace,
            owns: owns.clone(),
            status: DelegationStatus::Running,
            result: None,
            error: None,
            files_touched: Vec::new(),
            conflicts: Vec::new(),
            base_commit,
            branch: branch.clone(),
            head_commit: None,
            diffstat: None,
            worktree_state: (workspace == DelegationWorkspace::Worktree).then_some(WorktreeState::Active),
            started_at: now,
            completed_at: None,
        };
        let thread = Thread {
            id: child_id,
            project_id: parent.project_id,
            title: child_title(args.title.as_deref(), &task),
            provider,
            model,
            effort,
            permission_mode,
            status: ThreadStatus::Idle,
            worktree,
            cwd,
            provider_session_id: None,
            pinned: false,
            created_at: now,
            updated_at: now,
            last_seq: 0,
            parent_thread_id: Some(parent.id),
            coordinator_project_id: None,
            collaboration_group_id: None,
            subagent: None,
            delegation: Some(info),
        };
        let created = {
            let guard = live.turn.lock().await;
            if guard.as_ref().is_none_or(|turn| turn.id != turn_id || turn.completed) {
                None
            } else {
                self.inner.store.thread_upsert(&thread)?;
                let event = self.emit(thread.id, None, EventPayload::ThreadCreated { thread: thread.clone() })?;
                let thread = Thread { last_seq: event.seq, ..thread.clone() };
                self.inner.store.thread_upsert(&thread)?;
                Some(thread)
            }
        };
        let Some(thread) = created else {
            self.discard_unstarted_worktree(&parent.cwd, &thread).await;
            bail!("native tool caller turn ended before the agent was created");
        };

        // First turn: the brief, recorded as a delivered task message from the parent.
        let brief = delegation_brief(role, &parent.title, workspace, &owns, branch.as_deref(), &task);
        let message_id = Uuid::now_v7();
        let record = ThreadMessageRecord {
            id: message_id,
            operation_id: derived_operation_id(operation_id, 0x7a),
            from_thread_id: Some(parent.id),
            to_thread_id: child_id,
            purpose: ThreadMessagePurpose::Task,
            reply_to: None,
            body: brief.clone(),
            delivery: ThreadMessageDelivery::Queue,
            state: ThreadMessageState::Delivered,
            held_reason: None,
            created_at: now,
            updated_at: now,
        };
        self.inner.store.thread_message_insert(&record)?;
        let message = UserMessage {
            parts: vec![ContentPart::ThreadMessage {
                message_id,
                from_thread_id: Some(parent.id),
                from_title: parent.title.clone(),
                purpose: ThreadMessagePurpose::Task,
                reply_to: None,
                body: brief,
            }],
        };
        if let Err(error) = self.send_with_id(child_id, message_id, message, false, false).await {
            let reason = format!("The agent could not start: {error}");
            let _ = self.delegation_update(child_id, |info| {
                info.status = DelegationStatus::Failed;
                info.error = Some(reason.clone());
                info.completed_at = Some(Utc::now());
                true
            });
            return Err(anyhow!("{reason}"));
        }
        let created = self.inner.store.thread_get(child_id)?.unwrap_or(thread);
        drop(_creating);
        self.delegate_response(created, parent.id, mode, timeout).await
    }

    /// Remove a worktree made for a delegation that never got a thread.
    async fn discard_unstarted_worktree(&self, source_cwd: &str, thread: &Thread) {
        let Some(info) = thread.worktree.as_ref() else { return };
        let repo = Repo::new(source_cwd);
        let _ = repo.worktree_remove(Path::new(&info.path), true).await;
        let _ = repo.delete_branch(&info.branch, true).await;
    }

    async fn delegate_response(&self, child: Thread, caller: ThreadId, mode: DelegateMode, timeout: Duration) -> Result<Value> {
        ensure!(
            child.parent_thread_id == Some(caller),
            "operation_id already belongs to another thread's delegation. Use a fresh request_key."
        );
        let mut thread = child;
        let mut timed_out = false;
        if mode == DelegateMode::Wait && thread.delegation.as_ref().is_some_and(|info| info.status == DelegationStatus::Running) {
            let task_id = thread.delegation.as_ref().map(|info| info.task_id).expect("checked above");
            let (mut threads, waited_out) = self.wait_for_delegations(&[task_id], timeout).await?;
            timed_out = waited_out;
            if let Some(updated) = threads.pop() {
                thread = updated;
            }
            self.mark_inline_delivered(&[&thread]);
        }
        let info = thread.delegation.as_ref().ok_or_else(|| anyhow!("thread is not a delegation"))?;
        let mut response = json!({
            "task_id": info.task_id,
            "thread_id": thread.id,
            "title": thread.title,
            "provider": thread.provider.kind,
            "model": thread.model,
            "workspace": info.workspace,
            "status": info.status,
        });
        let object = response.as_object_mut().expect("response is an object");
        if let Some(branch) = &info.branch {
            object.insert("branch".into(), json!(branch));
        }
        if let Some(result) = &info.result {
            object.insert("result".into(), json!(truncate_with_marker(result, RESULT_CAP)));
        }
        if let Some(error) = &info.error {
            object.insert("error".into(), json!(error));
        }
        if timed_out {
            object.insert("wait_timed_out".into(), json!(true));
            object.insert(
                "note".into(),
                json!("The agent is still running. End your turn: Kybern wakes you with its result when it finishes."),
            );
        } else if info.status == DelegationStatus::Running {
            object.insert(
                "note".into(),
                json!("The agent is working. End your turn instead of polling; Kybern wakes you with its result when it finishes."),
            );
        }
        Ok(response)
    }

    // ---- kybern_agent_status / kybern_agent_wait ----

    fn agent_status(&self, caller: &Thread, args: StatusArgs) -> Result<Value> {
        let threads = self.agent_threads(caller, args.task_ids.as_deref())?;
        Ok(json!({ "agents": threads.iter().map(|thread| delegation_view(thread, STATUS_RESULT_CAP)).collect::<Vec<_>>() }))
    }

    /// The caller's delegations: the listed ones, else its direct children newest first.
    fn agent_threads(&self, caller: &Thread, task_ids: Option<&[Uuid]>) -> Result<Vec<Thread>> {
        match task_ids {
            Some(ids) => ids
                .iter()
                .map(|task_id| {
                    let child = self
                        .inner
                        .store
                        .delegation_find_by_task(*task_id)?
                        .filter(|child| self.is_descendant_of(caller.id, child).unwrap_or(false))
                        .ok_or_else(|| {
                            anyhow!("unknown task_id {task_id}. Call kybern_agent_status without task_ids to list your agents.")
                        })?;
                    Ok(child)
                })
                .collect(),
            None => {
                let mut children = self.inner.store.delegation_children(caller.id)?;
                children.reverse();
                children.truncate(STATUS_LIMIT);
                Ok(children)
            }
        }
    }

    async fn agent_wait(&self, caller: &Thread, args: WaitArgs) -> Result<Value> {
        let timeout = Duration::from_millis(args.timeout_ms.unwrap_or(WAIT_DEFAULT_MS).clamp(1, WAIT_MAX_MS));
        let task_ids: Vec<Uuid> = match args.task_ids {
            Some(ids) => {
                self.agent_threads(caller, Some(&ids))?;
                ids
            }
            None => self
                .inner
                .store
                .delegation_children(caller.id)?
                .into_iter()
                .filter_map(|child| child.delegation.filter(|info| info.status == DelegationStatus::Running).map(|info| info.task_id))
                .collect(),
        };
        if task_ids.is_empty() {
            return Ok(json!({ "agents": [], "wait_timed_out": false, "note": "None of your agents is running." }));
        }
        let (threads, timed_out) = self.wait_for_delegations(&task_ids, timeout).await?;
        self.mark_inline_delivered(&threads.iter().collect::<Vec<_>>());
        let mut response = json!({
            "agents": threads.iter().map(|thread| delegation_view(thread, RESULT_CAP)).collect::<Vec<_>>(),
            "wait_timed_out": timed_out,
        });
        if timed_out {
            response["note"] = json!("Some agents are still running. End your turn: Kybern wakes you with their results.");
        }
        Ok(response)
    }

    /// Block until every listed delegation leaves `running`, or the timeout.
    async fn wait_for_delegations(&self, task_ids: &[Uuid], timeout: Duration) -> Result<(Vec<Thread>, bool)> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let notified = self.inner.delegation.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let threads = task_ids
                .iter()
                .map(|task_id| {
                    self.inner.store.delegation_find_by_task(*task_id)?.ok_or_else(|| anyhow!("delegation {task_id} no longer exists"))
                })
                .collect::<Result<Vec<_>>>()?;
            let running =
                threads.iter().any(|thread| thread.delegation.as_ref().is_some_and(|info| info.status == DelegationStatus::Running));
            if !running {
                return Ok((threads, false));
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                // Query once more so a result persisted at the boundary is not reported as a timeout.
                let threads = task_ids
                    .iter()
                    .filter_map(|task_id| self.inner.store.delegation_find_by_task(*task_id).ok().flatten())
                    .collect::<Vec<_>>();
                let still_running =
                    threads.iter().any(|thread| thread.delegation.as_ref().is_some_and(|info| info.status == DelegationStatus::Running));
                return Ok((threads, still_running));
            }
        }
    }

    /// Remember outcomes a blocked call returned so the batch does not repeat them.
    fn mark_inline_delivered(&self, threads: &[&Thread]) {
        let mut delivered = self.inner.delegation.inline_delivered.lock().unwrap_or_else(|error| error.into_inner());
        if delivered.len() > 1024 {
            delivered.clear();
        }
        for thread in threads {
            if let Some(info) = thread.delegation.as_ref().filter(|info| info.status != DelegationStatus::Running) {
                delivered.insert(info.task_id);
            }
        }
    }

    // ---- kybern_agent_cancel / kybern_thread_interrupt ----

    async fn agent_cancel_child(&self, caller: &Thread, turn_id: TurnId, live: &LiveSession, child: Thread) -> Result<Value> {
        ensure!(
            self.is_descendant_of(caller.id, &child)?,
            "You can only stop agents you delegated work to. Call kybern_agent_status to list them."
        );
        Self::ensure_turn_active(live, turn_id).await?;
        self.delegation_cancel_tree(child.id, false).await?;
        if let Err(error) = self.interrupt_with_grace(child.id, Duration::from_secs(5)).await {
            tracing::debug!(thread_id = %child.id, %error, "stopped agent had no live session to interrupt");
        }
        let child = self.inner.store.thread_get(child.id)?.unwrap_or(child);
        Ok(delegation_view(&child, STATUS_RESULT_CAP))
    }

    // ---- status changes ----

    /// Change a delegation under the thread-update lock. `change` returns
    /// whether it modified anything; `None` means nothing was written.
    pub(super) fn delegation_update(
        &self,
        thread_id: ThreadId,
        change: impl FnOnce(&mut DelegationInfo) -> bool,
    ) -> Result<Option<Thread>> {
        let updated = {
            let _updates = self.inner.thread_updates.lock().map_err(|_| anyhow!("thread update lock poisoned"))?;
            let Some(mut thread) = self.inner.store.thread_get(thread_id)? else { return Ok(None) };
            let Some(info) = thread.delegation.as_mut() else { return Ok(None) };
            if !change(info) {
                return Ok(None);
            }
            self.write_thread_update(thread, false)?
        };
        self.inner.delegation.changed.notify_waiters();
        Ok(Some(updated))
    }

    /// Last root assistant text of `turn_id` (the terminal message when known).
    fn last_assistant_text(&self, thread_id: ThreadId, turn_id: Option<TurnId>, terminal: Option<MessageId>) -> Option<String> {
        let events = self.inner.store.events_for_thread_recent(thread_id, 600).ok()?;
        let mut last = None;
        let mut terminal_text = None;
        for event in events {
            let EventPayload::AssistantMessageCompleted { message_id, origin, text, .. } = event.payload else { continue };
            if !origin.is_root() || text.trim().is_empty() || turn_id.is_some_and(|turn| event.turn_id != Some(turn)) {
                continue;
            }
            if Some(message_id) == terminal {
                terminal_text = Some(text.clone());
            }
            last = Some(text);
        }
        terminal_text.or(last).map(|text| truncate_with_marker(&text, RESULT_CAP))
    }

    /// Hook: a turn of `thread_id` just ended (its events and status are persisted).
    /// Cheap and non-blocking: the real work runs on its own task, after `emit` returned.
    pub(super) fn delegation_turn_finished(&self, thread_id: ThreadId, turn_id: TurnId, outcome: TurnOutcome) {
        let this = self.clone();
        tokio::spawn(async move {
            if let Err(error) = this.delegation_finish_turn(thread_id, turn_id, outcome).await {
                tracing::warn!(%thread_id, %error, "delegation bookkeeping after a turn failed");
            }
        });
    }

    async fn delegation_finish_turn(&self, thread_id: ThreadId, turn_id: TurnId, outcome: TurnOutcome) -> Result<()> {
        let Some(thread) = self.inner.store.thread_get(thread_id)? else { return Ok(()) };
        if thread.delegation.as_ref().is_some_and(|info| info.status == DelegationStatus::Running) {
            self.delegation_complete_child(&thread, turn_id, outcome).await?;
        }
        // A finished parent turn is when merged child branches get cleaned up.
        self.delegation_cleanup_children(thread_id).await;
        Ok(())
    }

    async fn delegation_complete_child(&self, child: &Thread, turn_id: TurnId, outcome: TurnOutcome) -> Result<()> {
        let info = child.delegation.clone().ok_or_else(|| anyhow!("not a delegation"))?;
        let (status, error, terminal) = match outcome {
            TurnOutcome::Completed { stop_reason: StopReason::Completed | StopReason::MaxTurns, terminal_message_id } => {
                (DelegationStatus::Completed, None, terminal_message_id)
            }
            TurnOutcome::Completed { stop_reason: StopReason::Interrupted, terminal_message_id } => {
                (DelegationStatus::Interrupted, Some("The agent was interrupted before it finished.".to_string()), terminal_message_id)
            }
            TurnOutcome::Completed { stop_reason: StopReason::Error, terminal_message_id } => {
                (DelegationStatus::Failed, Some("The agent stopped with an error.".to_string()), terminal_message_id)
            }
            TurnOutcome::Failed(error) => (DelegationStatus::Failed, Some(error), None),
        };
        let result = self.last_assistant_text(child.id, Some(turn_id), terminal);
        let (head_commit, diffstat) = self.worktree_outcome(child, &info).await;
        let updated = self.delegation_update(child.id, |info| {
            if info.status != DelegationStatus::Running {
                return false;
            }
            info.status = status;
            info.error = error.clone();
            info.result = result.clone();
            info.head_commit = head_commit.clone();
            info.diffstat = diffstat;
            info.completed_at = Some(Utc::now());
            true
        })?;
        if let Some(updated) = updated
            && let Some(item) = agent_result_item(&updated)
        {
            self.delegation_push_result(info.parent_thread_id, item);
        }
        Ok(())
    }

    async fn worktree_outcome(&self, child: &Thread, info: &DelegationInfo) -> (Option<String>, Option<DiffStat>) {
        if info.workspace != DelegationWorkspace::Worktree || info.worktree_state == Some(WorktreeState::Removed) {
            return (None, None);
        }
        let repo = Repo::new(&child.cwd);
        let Some(head) = repo.head().await else { return (None, None) };
        let diffstat = match info.base_commit.as_deref() {
            Some(base) => repo.diffstat(base, &head).await.ok(),
            None => None,
        };
        (Some(head), diffstat)
    }

    // ---- batching results to the delegating thread ----

    /// Add an outcome to the parent's pending batch; one message goes out after the debounce window.
    pub(super) fn delegation_push_result(&self, parent_id: ThreadId, item: AgentResultItem) {
        let schedule = {
            let mut pending = self.inner.delegation.pending.lock().unwrap_or_else(|error| error.into_inner());
            let batch = pending.entry(parent_id).or_default();
            batch.items.retain(|existing| existing.task_id != item.task_id);
            batch.items.push(item);
            !std::mem::replace(&mut batch.scheduled, true)
        };
        if schedule {
            let delay = Duration::from_millis(self.inner.delegation.debounce_ms.load(std::sync::atomic::Ordering::Relaxed));
            let this = self.clone();
            tokio::spawn(async move {
                tokio::time::sleep(delay).await;
                this.delegation_flush(parent_id).await;
            });
        }
    }

    async fn delegation_flush(&self, parent_id: ThreadId) {
        let mut items = {
            let mut pending = self.inner.delegation.pending.lock().unwrap_or_else(|error| error.into_inner());
            pending.remove(&parent_id).map(|batch| batch.items).unwrap_or_default()
        };
        {
            let mut delivered = self.inner.delegation.inline_delivered.lock().unwrap_or_else(|error| error.into_inner());
            items.retain(|item| !delivered.remove(&item.task_id));
        }
        if items.is_empty() {
            return;
        }
        if let Err(error) = self.deliver_agent_results(parent_id, items).await {
            tracing::warn!(%parent_id, %error, "could not deliver delegated agent results");
        }
    }

    async fn deliver_agent_results(&self, parent_id: ThreadId, items: Vec<AgentResultItem>) -> Result<()> {
        let Some(parent) = self.inner.store.thread_get(parent_id)? else { return Ok(()) };
        if parent.status == ThreadStatus::Archived {
            return Ok(());
        }
        if matches!(parent.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval) && harness_supports_steer(parent.provider.kind) {
            let message = UserMessage { parts: vec![ContentPart::AgentResults { items: items.clone() }] };
            match self.steer(methods::QueuedMessage { id: Uuid::now_v7(), thread_id: parent_id, message }).await {
                Ok(_) => return Ok(()),
                Err(error) => tracing::debug!(%parent_id, %error, "steering agent results failed; queueing them instead"),
            }
        }
        self.queue_agent_results(parent_id, items)
    }

    /// Queue the batch, merging into an undelivered queued `AgentResults` message.
    fn queue_agent_results(&self, parent_id: ThreadId, mut items: Vec<AgentResultItem>) -> Result<()> {
        let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
        let queued = self.inner.store.queue_list(Some(parent_id))?;
        let existing = queued.into_iter().find(|queued| matches!(queued.message.parts.as_slice(), [ContentPart::AgentResults { .. }]));
        if let Some(existing) = existing {
            if let [ContentPart::AgentResults { items: earlier }] = existing.message.parts.as_slice() {
                let mut merged: Vec<AgentResultItem> =
                    earlier.iter().filter(|old| !items.iter().any(|new| new.task_id == old.task_id)).cloned().collect();
                merged.append(&mut items);
                items = merged;
            }
            self.emit(parent_id, None, EventPayload::MessageRemoved { message_id: existing.id })?;
        }
        let message = methods::QueuedMessage {
            id: Uuid::now_v7(),
            thread_id: parent_id,
            message: UserMessage { parts: vec![ContentPart::AgentResults { items }] },
        };
        self.emit(parent_id, None, EventPayload::MessageQueued { message })?;
        Ok(())
    }

    // ---- stop / archive cascades ----

    /// Every delegated descendant of `root` (children first, then theirs).
    pub(super) fn delegation_descendants(&self, root: ThreadId) -> Result<Vec<Thread>> {
        let mut found = Vec::new();
        let mut frontier = vec![root];
        let mut seen = HashSet::from([root]);
        while let Some(parent) = frontier.pop() {
            for child in self.inner.store.delegation_children(parent)? {
                if seen.insert(child.id) {
                    frontier.push(child.id);
                    found.push(child);
                }
            }
        }
        Ok(found)
    }

    /// Mark `thread_id`'s running delegated descendants cancelled and interrupt
    /// them, dropping their queued messages. When `thread_id` is itself a
    /// running delegation it is marked cancelled too (and its parent told when
    /// `notify_parent`); interrupting `thread_id`'s own turn is the caller's job.
    /// Failures on individual children are logged, never raised.
    pub(super) async fn delegation_cancel_tree(&self, thread_id: ThreadId, notify_parent: bool) -> Result<()> {
        let mut interrupt = Vec::new();
        for descendant in self.delegation_descendants(thread_id)? {
            if descendant.delegation.as_ref().is_some_and(|info| info.status == DelegationStatus::Running)
                && self.delegation_mark_cancelled(descendant.id, false)?
            {
                interrupt.push(descendant.id);
            }
            self.delegation_drop_queued(descendant.id);
        }
        self.delegation_mark_cancelled(thread_id, notify_parent)?;
        futures::future::join_all(interrupt.into_iter().map(|id| async move {
            if let Err(error) = self.interrupt_with_grace(id, Duration::from_secs(5)).await {
                tracing::debug!(thread_id = %id, %error, "could not interrupt a cancelled agent");
            }
        }))
        .await;
        Ok(())
    }

    fn delegation_mark_cancelled(&self, thread_id: ThreadId, notify_parent: bool) -> Result<bool> {
        let updated = self.delegation_update(thread_id, |info| {
            if info.status != DelegationStatus::Running {
                return false;
            }
            info.status = DelegationStatus::Cancelled;
            info.completed_at = Some(Utc::now());
            true
        })?;
        let Some(updated) = updated else { return Ok(false) };
        if notify_parent
            && let Some(parent) = updated.parent_thread_id
            && let Some(mut item) = agent_result_item(&updated)
        {
            item.result = item.result.or_else(|| self.last_assistant_text(updated.id, None, None));
            self.delegation_push_result(parent, item);
        }
        Ok(true)
    }

    fn delegation_drop_queued(&self, thread_id: ThreadId) {
        self.inner.delegation.pending.lock().unwrap_or_else(|error| error.into_inner()).remove(&thread_id);
        if let Ok(queued) = self.inner.store.queue_list(Some(thread_id)) {
            for message in queued {
                if let Err(error) = self.remove_queued(thread_id, message.id) {
                    tracing::debug!(%thread_id, %error, "queued message already started or removed");
                }
            }
        }
    }

    // ---- restart recovery ----

    /// Mark every delegation that was running when the daemon stopped as
    /// interrupted and tell its parent (through the normal batch).
    pub(super) fn delegation_recover_after_restart(&self) -> Result<()> {
        for thread in self.inner.store.threads_list(None, true)? {
            if !thread.delegation.as_ref().is_some_and(|info| info.status == DelegationStatus::Running) {
                continue;
            }
            let result = self.last_assistant_text(thread.id, None, None);
            let updated = self.delegation_update(thread.id, |info| {
                if info.status != DelegationStatus::Running {
                    return false;
                }
                info.status = DelegationStatus::Interrupted;
                info.error = Some("interrupted by a Kybern restart".into());
                info.result = result.clone();
                info.completed_at = Some(Utc::now());
                true
            })?;
            if let Some(updated) = updated
                && let Some(parent) = updated.parent_thread_id
                && let Some(item) = agent_result_item(&updated)
            {
                self.delegation_push_result(parent, item);
            }
        }
        Ok(())
    }

    // ---- delegated worktrees ----

    /// Whether the child's worktree can go without losing work: clean, and its
    /// branch merged into the parent's checkout or without commits of its own.
    async fn worktree_disposition(&self, child: &Thread, info: &DelegationInfo) -> Result<WorktreeDisposition> {
        let dir = child.worktree.as_ref().map(|worktree| worktree.path.clone()).unwrap_or_else(|| child.cwd.clone());
        if !Path::new(&dir).exists() {
            return Ok(WorktreeDisposition { dir, clean: true, merged: false, no_work: true, missing: true });
        }
        let branch = info.branch.clone().ok_or_else(|| anyhow!("delegation has no branch"))?;
        let clean = Repo::new(&dir).is_clean().await?;
        let source = self.worktree_source_repo(child, info);
        let merged = source.is_ancestor(&branch, "HEAD").await.unwrap_or(false);
        let no_work = match info.base_commit.as_deref() {
            Some(base) => source.is_ancestor(&branch, base).await.unwrap_or(false),
            None => false,
        };
        Ok(WorktreeDisposition { dir, clean, merged, no_work, missing: false })
    }

    /// The parent's checkout, whose HEAD decides whether a child branch is merged.
    fn worktree_source_repo(&self, child: &Thread, info: &DelegationInfo) -> Repo {
        let cwd = self
            .inner
            .store
            .thread_get(info.parent_thread_id)
            .ok()
            .flatten()
            .map(|parent| parent.cwd)
            .or_else(|| self.inner.store.project_get(child.project_id).ok().flatten().map(|project| project.path))
            .unwrap_or_else(|| child.cwd.clone());
        Repo::new(cwd)
    }

    /// Remove the worktree (and the branch when merged or empty) and record `removed`.
    async fn remove_delegated_worktree(
        &self,
        child: &Thread,
        info: &DelegationInfo,
        state: &WorktreeDisposition,
        force: bool,
    ) -> Result<()> {
        let source = self.worktree_source_repo(child, info);
        if !state.missing {
            source.worktree_remove(Path::new(&state.dir), force).await?;
        }
        if let Some(branch) = info.branch.as_deref() {
            if state.merged {
                if let Err(error) = source.delete_branch(branch, false).await {
                    tracing::debug!(%branch, %error, "merged delegation branch could not be deleted");
                }
            } else if state.no_work {
                // Nothing beyond the seed commit, which only holds the parent's own changes.
                if let Err(error) = source.delete_branch(branch, true).await {
                    tracing::debug!(%branch, %error, "empty delegation branch could not be deleted");
                }
            }
        }
        self.delegation_update(child.id, |info| {
            info.worktree_state = Some(WorktreeState::Removed);
            true
        })?;
        Ok(())
    }

    /// Archive trigger: remove the worktree when safe, else mark it kept.
    pub(super) async fn delegation_cleanup_on_archive(&self, thread_id: ThreadId) {
        if let Err(error) = self.cleanup_worktree(thread_id, true).await {
            tracing::warn!(%thread_id, %error, "delegated worktree cleanup failed");
        }
    }

    /// Parent-turn trigger: remove worktrees of finished children whose work is merged.
    async fn delegation_cleanup_children(&self, parent_id: ThreadId) {
        let Ok(children) = self.inner.store.delegation_children(parent_id) else { return };
        for child in children {
            let eligible = child.delegation.as_ref().is_some_and(|info| {
                info.workspace == DelegationWorkspace::Worktree
                    && info.status != DelegationStatus::Running
                    && info.worktree_state == Some(WorktreeState::Active)
            });
            if eligible && let Err(error) = self.cleanup_worktree(child.id, false).await {
                tracing::debug!(thread_id = %child.id, %error, "delegated worktree cleanup skipped");
            }
        }
    }

    async fn cleanup_worktree(&self, thread_id: ThreadId, mark_kept: bool) -> Result<()> {
        let Some(child) = self.inner.store.thread_get(thread_id)? else { return Ok(()) };
        let Some(info) = child.delegation.clone() else { return Ok(()) };
        if info.workspace != DelegationWorkspace::Worktree
            || !matches!(info.worktree_state, Some(WorktreeState::Active | WorktreeState::Kept))
        {
            return Ok(());
        }
        let state = self.worktree_disposition(&child, &info).await?;
        if state.clean && (state.merged || state.no_work) {
            self.remove_delegated_worktree(&child, &info, &state, false).await
        } else {
            if mark_kept && info.worktree_state != Some(WorktreeState::Kept) {
                self.delegation_update(thread_id, |info| {
                    info.worktree_state = Some(WorktreeState::Kept);
                    true
                })?;
            }
            Ok(())
        }
    }

    /// `delegations.worktree_remove`: remove a delegated child's worktree.
    /// Without `force` it must be clean and merged (or empty); the branch is
    /// deleted only when merged.
    pub async fn delegation_worktree_remove(&self, thread_id: ThreadId, force: bool) -> Result<Thread> {
        let child = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("thread not found"))?;
        let info = child.delegation.clone().ok_or_else(|| anyhow!("This thread is not a delegated agent."))?;
        ensure!(info.workspace == DelegationWorkspace::Worktree, "This agent works in the shared checkout; it has no worktree to remove.");
        ensure!(info.status != DelegationStatus::Running, "This agent is still running. Stop it first, then remove its worktree.");
        if info.worktree_state == Some(WorktreeState::Removed) {
            return Ok(child);
        }
        let state = self.worktree_disposition(&child, &info).await?;
        if !force && !(state.clean && (state.merged || state.no_work)) {
            bail!(
                "This worktree has uncommitted changes or commits that are not merged yet. Merge the branch, or remove it anyway to discard that work."
            );
        }
        self.remove_delegated_worktree(&child, &info, &state, force).await?;
        self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("thread not found"))
    }
}

struct WorktreeDisposition {
    dir: String,
    clean: bool,
    merged: bool,
    no_work: bool,
    missing: bool,
}

/// The error a send gets when the child's worktree is already gone.
pub(super) fn worktree_removed_error() -> anyhow::Error {
    anyhow!("This agent's worktree was removed. Delegate the follow-up again with a full brief.")
}
