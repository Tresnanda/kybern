//! Owns live provider sessions and turns their events into the persisted,
//! broadcast thread log.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result, anyhow};
use chrono::Utc;
use kybern_drivers::registry::DriverRegistry;
use kybern_drivers::{
    AgentSession, DriverEvent, DriverRuntimeTask, DriverRuntimeTaskUpdate, RewindPoint, SessionConfig, SpawnedSession, TurnAnchors,
};
use kybern_git::{Repo, checkpoint_ref};
use kybern_protocol::*;
use kybern_store::{Store, TurnUsageRow};
use tokio::sync::{Mutex, broadcast};
use uuid::Uuid;

use crate::config::Paths;
use crate::settings::SettingsStore;

#[derive(Clone)]
pub struct Orchestrator {
    inner: Arc<Inner>,
}

struct Inner {
    store: Store,
    drivers: DriverRegistry,
    events: broadcast::Sender<ThreadEvent>,
    paths: Paths,
    settings: SettingsStore,
    sessions: Mutex<HashMap<ThreadId, Arc<LiveSession>>>,
    /// Threads whose next session must fork the provider conversation at this point.
    pending_rewinds: Mutex<HashMap<ThreadId, RewindPoint>>,
}

struct LiveSession {
    session: Box<dyn AgentSession>,
    /// The turn currently executing, if any.
    turn: Mutex<Option<ActiveTurn>>,
    /// Most recent parent turn. Provider task notifications can arrive after
    /// the parent reports completion.
    last_turn_id: Mutex<Option<TurnId>>,
    /// Latest provider-owned task state for targeted controls and checkpointing.
    tasks: Mutex<HashMap<String, RuntimeTask>>,
    /// Parent turns whose after-checkpoint waits for launched work to settle.
    deferred_checkpoints: Mutex<HashSet<TurnId>>,
    /// Approval id -> provider request id, for pending permission requests.
    pending: Mutex<HashMap<ApprovalId, String>>,
}

struct ActiveTurn {
    id: TurnId,
    started: std::time::Instant,
    /// Provider message id -> our MessageId, so deltas coalesce.
    messages: HashMap<String, MessageId>,
    completed: bool,
}

pub const DEFAULT_TITLE: &str = "New thread";

impl Orchestrator {
    pub fn new(
        store: Store,
        drivers: DriverRegistry,
        events: broadcast::Sender<ThreadEvent>,
        paths: Paths,
        settings: SettingsStore,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                store,
                drivers,
                events,
                paths,
                settings,
                sessions: Mutex::new(HashMap::new()),
                pending_rewinds: Mutex::new(HashMap::new()),
            }),
        }
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
            t.status = ThreadStatus::Idle;
            self.update_thread(t)?;
        }
        Ok(())
    }

    pub async fn shutdown(&self) {
        let sessions: Vec<_> = self.inner.sessions.lock().await.drain().collect();
        for (_, s) in sessions {
            let _ = s.session.close().await;
        }
    }

    // ---- persistence helpers ----

    fn emit(&self, thread_id: ThreadId, turn_id: Option<TurnId>, payload: EventPayload) -> Result<ThreadEvent> {
        let ev = self.inner.store.event_append(thread_id, turn_id, payload)?;
        let _ = self.inner.events.send(ev.clone());
        Ok(ev)
    }

    fn update_thread(&self, mut thread: Thread) -> Result<Thread> {
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
        if let Some(existing) = self.inner.store.project_by_path(&path)? {
            return Ok(existing);
        }
        let now = Utc::now();
        let project = Project {
            id: Uuid::now_v7(),
            name: name.unwrap_or_else(|| p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| path.clone())),
            is_git: p.join(".git").exists(),
            path,
            worktrees_default: None,
            created_at: now,
            updated_at: now,
        };
        self.inner.store.project_insert(&project)?;
        Ok(project)
    }

    // ---- threads ----

    pub async fn create_thread(&self, params: methods::ThreadsCreateParams) -> Result<Thread> {
        let project = self.inner.store.project_get(params.project_id)?.ok_or_else(|| anyhow!("project not found"))?;
        let settings = self.inner.settings.get();
        let use_worktree = params.use_worktree.or(project.worktrees_default).unwrap_or(settings.worktrees_default);
        if use_worktree && !project.is_git {
            return Err(anyhow!("project is not a git repository; cannot create a worktree"));
        }
        let now = Utc::now();
        let id = Uuid::now_v7();
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
            model: params.model.or_else(|| settings.providers.get(&params.provider.kind).and_then(|p| p.model.clone())),
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
        let short = &thread_id.to_string()[..8];
        let branch = format!("kybern/{short}");
        let dir = self.inner.paths.worktrees.join(&project.name).join(short);
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
        if let Some(live) = self.inner.sessions.lock().await.remove(&thread_id) {
            let _ = live.session.close().await;
        }
        let mut t = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("thread not found"))?;
        t.status = ThreadStatus::Archived;
        self.inner.store.thread_upsert(&t)?;
        self.emit(thread_id, None, EventPayload::ThreadArchived)?;
        Ok(())
    }

    pub async fn send(&self, thread_id: ThreadId, mut message: UserMessage) -> Result<(TurnId, MessageId)> {
        self.resolve_attachments(&mut message);
        let mut thread = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("thread not found"))?;
        if matches!(thread.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval) {
            return Err(anyhow!("thread is busy"));
        }
        if thread.status == ThreadStatus::Archived {
            return Err(anyhow!("thread is archived"));
        }

        let turn_id = Uuid::now_v7();
        let message_id = Uuid::now_v7();
        if thread.title == DEFAULT_TITLE {
            thread.title = title_from_message(&message);
        }
        thread.status = ThreadStatus::Running;
        let thread = self.update_thread(thread)?;
        self.emit(thread.id, Some(turn_id), EventPayload::TurnStarted { message_id, message: message.clone() })?;

        // The user's intent is persisted and broadcast, so the call returns now
        // and clients navigate and render immediately. Spawning the harness,
        // taking the checkpoint and delivering the message can take a second or
        // more; that runs in the background and reports failures as events.
        let this = self.clone();
        tokio::spawn(async move {
            if let Err(e) = this.start_turn(thread, turn_id, message_id, message).await {
                tracing::warn!(turn_id = %turn_id, error = %e, "failed to start turn");
            }
        });
        Ok((turn_id, message_id))
    }

    /// Bring up the session, snapshot the tree and hand the message to the agent.
    /// Failures mark the thread failed and are surfaced as `TurnFailed`.
    async fn start_turn(&self, thread: Thread, turn_id: TurnId, message_id: MessageId, message: UserMessage) -> Result<()> {
        let live = match self.ensure_session(&thread).await {
            Ok(live) => live,
            Err(error) => {
                self.emit(thread.id, Some(turn_id), EventPayload::TurnFailed { error: error.to_string() })?;
                let mut failed = thread;
                failed.status = ThreadStatus::Failed;
                self.update_thread(failed)?;
                return Err(error);
            }
        };
        {
            let mut turn = live.turn.lock().await;
            *turn = Some(ActiveTurn { id: turn_id, started: std::time::Instant::now(), messages: HashMap::new(), completed: false });
        }
        *live.last_turn_id.lock().await = Some(turn_id);
        self.checkpoint(&thread, turn_id, "before").await;

        if let Err(e) = live.session.send_message(&message_id.to_string(), &message).await {
            self.emit(thread.id, Some(turn_id), EventPayload::TurnFailed { error: e.to_string() })?;
            let mut t = thread;
            t.status = ThreadStatus::Failed;
            self.update_thread(t)?;
            *live.turn.lock().await = None;
            return Err(e.into());
        }
        Ok(())
    }

    pub async fn interrupt(&self, thread_id: ThreadId) -> Result<()> {
        let live = self.inner.sessions.lock().await.get(&thread_id).cloned();
        match live {
            Some(live) => Ok(live.session.interrupt().await?),
            None => Err(anyhow!("thread has no live session")),
        }
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
        live.session.stop_runtime_task(&task).await?;
        self.apply_runtime_task_update(
            thread_id,
            &live,
            DriverRuntimeTaskUpdate::status(task.id.clone(), RuntimeTaskStatus::Stopping),
            false,
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
            false,
        )
        .await?
        .ok_or_else(|| anyhow!("task not found"))
    }

    fn provider_name(&self, thread_id: ThreadId) -> Result<&'static str> {
        Ok(self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("thread not found"))?.provider.kind.display_name())
    }

    pub async fn respond_approval(&self, approval_id: ApprovalId, decision: ApprovalDecision) -> Result<()> {
        let (approval, resolved) = self.inner.store.approval_get(approval_id)?.ok_or_else(|| anyhow!("approval not found"))?;
        if resolved {
            return Err(anyhow!("approval already resolved"));
        }
        let live =
            self.inner.sessions.lock().await.get(&approval.thread_id).cloned().ok_or_else(|| anyhow!("thread has no live session"))?;
        let request_id = live.pending.lock().await.remove(&approval_id).ok_or_else(|| anyhow!("approval no longer pending"))?;
        live.session.respond_permission(&request_id, &decision).await?;
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

    async fn ensure_session(&self, thread: &Thread) -> Result<Arc<LiveSession>> {
        if let Some(live) = self.inner.sessions.lock().await.get(&thread.id).cloned() {
            return Ok(live);
        }
        let rewind = self.inner.pending_rewinds.lock().await.remove(&thread.id);
        self.spawn_session(thread, rewind).await
    }

    async fn spawn_session(&self, thread: &Thread, rewind: Option<RewindPoint>) -> Result<Arc<LiveSession>> {
        let driver = self
            .inner
            .drivers
            .get(thread.provider.kind)
            .ok_or_else(|| anyhow!("provider {} is not available in this build", thread.provider.kind))?;
        let provider_settings = self.inner.settings.get().providers.get(&thread.provider.kind).cloned().unwrap_or_default();
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
        };
        let SpawnedSession { session, events } = driver.spawn(config).await?;
        let live = Arc::new(LiveSession {
            session,
            turn: Mutex::new(None),
            last_turn_id: Mutex::new(None),
            tasks: Mutex::new(HashMap::new()),
            deferred_checkpoints: Mutex::new(HashSet::new()),
            pending: Mutex::new(HashMap::new()),
        });
        self.inner.sessions.lock().await.insert(thread.id, live.clone());
        let this = self.clone();
        let thread_id = thread.id;
        let pump_live = live.clone();
        tokio::spawn(async move { this.pump(thread_id, pump_live, events).await });
        Ok(live)
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
        self.emit(thread_id, Some(task.origin_turn_id), payload)?;
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
        completed: bool,
    ) -> Result<Option<RuntimeTask>> {
        let mut tasks = live.tasks.lock().await;
        let Some(task) = tasks.get_mut(&update.id) else {
            tracing::debug!(thread_id = %thread_id, task_id = %update.id, "provider updated an unknown runtime task");
            return Ok(None);
        };
        let next_status = match (update.status, completed) {
            (Some(status), true) if status.is_active() => RuntimeTaskStatus::Completed,
            (Some(status), _) => status,
            (None, true) => RuntimeTaskStatus::Completed,
            (None, false) => task.status,
        };
        if task.status.is_active() || !next_status.is_active() {
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
        if completed || !task.status.is_active() {
            task.completed_at = Some(task.updated_at);
            task.capabilities = RuntimeTaskCapabilities::default();
        }
        let task = task.clone();
        drop(tasks);
        let payload = if completed || !task.status.is_active() {
            EventPayload::RuntimeTaskCompleted { task: task.clone() }
        } else {
            EventPayload::RuntimeTaskUpdated { task: task.clone() }
        };
        self.emit(thread_id, Some(task.origin_turn_id), payload)?;
        if completed || !task.status.is_active() {
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
                    true,
                )
                .await;
        }
    }

    /// Translate driver events into thread events until the provider exits.
    async fn pump(self, thread_id: ThreadId, live: Arc<LiveSession>, mut events: tokio::sync::mpsc::Receiver<DriverEvent>) {
        while let Some(ev) = events.recv().await {
            if let Err(e) = self.handle_driver_event(thread_id, &live, ev).await {
                tracing::error!(%thread_id, error = %e, "failed to persist driver event");
            }
        }
        // Stream closed: provider is gone.
        self.inner.sessions.lock().await.remove(&thread_id);
        self.interrupt_runtime_tasks(thread_id, &live, "Provider exited before this work finished").await;
        let turn = live.turn.lock().await.take();
        if let Some(turn) = turn.filter(|t| !t.completed) {
            let _ =
                self.emit(thread_id, Some(turn.id), EventPayload::TurnFailed { error: "provider exited before finishing the turn".into() });
            if let Ok(Some(mut t)) = self.inner.store.thread_get(thread_id) {
                t.status = ThreadStatus::Failed;
                let _ = self.update_thread(t);
            }
        }
    }

    async fn handle_driver_event(&self, thread_id: ThreadId, live: &Arc<LiveSession>, ev: DriverEvent) -> Result<()> {
        let mut turn_guard = live.turn.lock().await;
        let turn_id = turn_guard.as_ref().map(|t| t.id);
        match ev {
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
            DriverEvent::TextDelta { message_id, delta } => {
                let id = map_message(&mut turn_guard, &message_id);
                self.emit(thread_id, turn_id, EventPayload::AssistantTextDelta { message_id: id, delta })?;
            }
            DriverEvent::ThinkingDelta { message_id, delta } => {
                let id = map_message(&mut turn_guard, &message_id);
                self.emit(thread_id, turn_id, EventPayload::AssistantThinkingDelta { message_id: id, delta })?;
            }
            DriverEvent::MessageCompleted { message_id, text, thinking } => {
                let id = map_message(&mut turn_guard, &message_id);
                self.emit(thread_id, turn_id, EventPayload::AssistantMessageCompleted { message_id: id, text, thinking })?;
            }
            DriverEvent::ToolStarted(call) => {
                self.emit(thread_id, turn_id, EventPayload::ToolCallStarted { call: call.clone() })?;
                if let Some(parent_id) = call.parent_id.as_deref() {
                    let task_id = live
                        .tasks
                        .lock()
                        .await
                        .values()
                        .find(|task| task.id == parent_id || task.tool_call_id.as_deref() == Some(parent_id))
                        .map(|task| task.id.clone());
                    if let Some(task_id) = task_id {
                        let _ = self
                            .apply_runtime_task_update(
                                thread_id,
                                live,
                                DriverRuntimeTaskUpdate {
                                    id: task_id,
                                    status: Some(RuntimeTaskStatus::Running),
                                    detail: None,
                                    backgrounded: None,
                                    last_tool_name: Some(call.name.clone()),
                                    usage: None,
                                    stats: None,
                                    capabilities: None,
                                },
                                false,
                            )
                            .await?;
                    }
                }
                let provider = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("thread vanished"))?.provider.kind;
                if !matches!(provider, ProviderKind::ClaudeCode | ProviderKind::Codex)
                    && let Some(task) = generic_runtime_task(&call)
                {
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
                    EventPayload::ToolCallCompleted { tool_call_id: tool_call_id.clone(), output: output.clone(), is_error },
                )?;
                let provider = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("thread vanished"))?.provider.kind;
                if !matches!(provider, ProviderKind::ClaudeCode | ProviderKind::Codex) {
                    let task_id = live
                        .tasks
                        .lock()
                        .await
                        .values()
                        .find(|task| task.tool_call_id.as_deref() == Some(&tool_call_id))
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
                                true,
                            )
                            .await?;
                    }
                }
            }
            DriverEvent::RuntimeTaskStarted(task) => {
                self.persist_runtime_task_start(thread_id, live, turn_id, task).await?;
            }
            DriverEvent::RuntimeTaskUpdated(update) => {
                let _ = self.apply_runtime_task_update(thread_id, live, update, false).await?;
            }
            DriverEvent::RuntimeTaskCompleted(update) => {
                let _ = self.apply_runtime_task_update(thread_id, live, update, true).await?;
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
                self.emit(thread_id, Some(turn_id), EventPayload::ApprovalRequested { approval })?;
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
                }
            }
            DriverEvent::TurnCompleted { stop_reason, usage, cost_usd, duration_ms, anchors } => {
                let Some(turn) = turn_guard.as_mut() else { return Ok(()) };
                if (anchors.turn_id.is_some() || anchors.previous_end.is_some())
                    && let Ok(Some(mut c)) = self.inner.store.checkpoint_get(turn.id)
                {
                    c.provider_turn_id = anchors.turn_id.clone();
                    c.provider_turn_end = anchors.previous_end.clone();
                    let _ = self.inner.store.checkpoint_upsert(&c);
                }
                turn.completed = true;
                let duration_ms = if duration_ms == 0 { turn.started.elapsed().as_millis() as u64 } else { duration_ms };
                let turn_id = turn.id;
                *turn_guard = None;
                drop(turn_guard);
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
                self.emit(thread_id, Some(turn_id), EventPayload::TurnCompleted { stop_reason, usage, cost_usd, duration_ms })?;
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
            DriverEvent::Notice { level, text, data } => {
                self.emit(thread_id, turn_id, EventPayload::ProviderNotice { level, text, data })?;
            }
            DriverEvent::Exited { code, error } => {
                if let Some(error) = error {
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

fn map_message(turn: &mut Option<ActiveTurn>, provider_id: &str) -> MessageId {
    match turn.as_mut() {
        Some(t) => *t.messages.entry(provider_id.to_string()).or_insert_with(Uuid::now_v7),
        None => Uuid::now_v7(),
    }
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

#[cfg(test)]
mod tests {
    use super::{generic_runtime_task, output_indicates_running};
    use kybern_protocol::{RuntimeTaskKind, ToolCall};
    use serde_json::json;

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

    #[test]
    fn recognizes_detached_results_without_claiming_native_lifecycle() {
        assert!(output_indicates_running(&json!({ "status": "in_progress" })));
        assert!(output_indicates_running(&json!("Process ID 42 is running in background")));
        assert!(!output_indicates_running(&json!({ "status": "completed" })));
    }
}
