//! Owns live provider sessions and turns their events into the persisted,
//! broadcast thread log.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result, anyhow};
use chrono::Utc;
use kybern_drivers::registry::DriverRegistry;
use kybern_drivers::{AgentSession, DriverEvent, RewindPoint, SessionConfig, SpawnedSession, TurnAnchors};
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

    pub fn settings(&self) -> Settings {
        self.inner.settings.get()
    }

    /// Binary override for a provider from settings.
    fn binary_for(&self, kind: ProviderKind) -> Option<PathBuf> {
        self.inner.settings.get().providers.get(&kind).and_then(|p| p.binary.clone()).map(PathBuf::from)
    }

    /// Threads persisted as running belong to a dead daemon; close their turns.
    pub async fn recover_after_restart(&self) -> Result<()> {
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

    pub fn store(&self) -> &Store {
        &self.inner.store
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
        let worktree = if use_worktree { Some(self.create_worktree(&project, id).await?) } else { None };
        let cwd = worktree.as_ref().map(|w| w.path.clone()).unwrap_or_else(|| project.path.clone());
        let thread = Thread {
            id,
            project_id: project.id,
            title: params.title.clone().unwrap_or_else(|| DEFAULT_TITLE.to_string()),
            model: params.model.or_else(|| settings.providers.get(&params.provider.kind).and_then(|p| p.model.clone())),
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

    async fn create_worktree(&self, project: &Project, thread_id: ThreadId) -> Result<WorktreeInfo> {
        let short = &thread_id.to_string()[..8];
        let branch = format!("kybern/{short}");
        let dir = self.inner.paths.worktrees.join(&project.name).join(short);
        std::fs::create_dir_all(dir.parent().unwrap())?;
        Repo::new(&project.path).worktree_add(&dir, &branch).await?;
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
        self.update_thread(t)
    }

    /// Push mode/model changes to a live session after the store is updated.
    pub async fn apply_session_settings(&self, thread_id: ThreadId, mode: Option<PermissionMode>, model: Option<&str>) -> Result<()> {
        let live = self.inner.sessions.lock().await.get(&thread_id).cloned();
        if let Some(live) = live {
            if let Some(mode) = mode {
                live.session.set_permission_mode(mode).await?;
            }
            if let Some(model) = model {
                live.session.set_model(model).await?;
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

        let live = self.ensure_session(&thread).await?;

        let turn_id = Uuid::now_v7();
        let message_id = Uuid::now_v7();
        {
            let mut turn = live.turn.lock().await;
            *turn = Some(ActiveTurn { id: turn_id, started: std::time::Instant::now(), messages: HashMap::new(), completed: false });
        }

        if thread.title == DEFAULT_TITLE {
            thread.title = title_from_message(&message);
        }
        thread.status = ThreadStatus::Running;
        let thread = self.update_thread(thread)?;
        self.emit(thread.id, Some(turn_id), EventPayload::TurnStarted { message_id, message: message.clone() })?;
        self.checkpoint(&thread, turn_id, "before").await;

        if let Err(e) = live.session.send_message(&message_id.to_string(), &message).await {
            self.emit(thread.id, Some(turn_id), EventPayload::TurnFailed { error: e.to_string() })?;
            let mut t = thread;
            t.status = ThreadStatus::Failed;
            self.update_thread(t)?;
            *live.turn.lock().await = None;
            return Err(e.into());
        }
        Ok((turn_id, message_id))
    }

    pub async fn interrupt(&self, thread_id: ThreadId) -> Result<()> {
        let live = self.inner.sessions.lock().await.get(&thread_id).cloned();
        match live {
            Some(live) => Ok(live.session.interrupt().await?),
            None => Err(anyhow!("thread has no live session")),
        }
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
        if live.pending.lock().await.is_empty() {
            if let Some(mut t) = self.inner.store.thread_get(approval.thread_id)? {
                if t.status == ThreadStatus::AwaitingApproval {
                    t.status = ThreadStatus::Running;
                    self.update_thread(t)?;
                }
            }
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
            if let ContentPart::Attachment { asset_id, media_type, .. } = part {
                if media_type.starts_with("image/") {
                    if let Ok(bytes) = std::fs::read(self.inner.paths.assets.join(asset_id.to_string())) {
                        *part = ContentPart::Image {
                            media_type: media_type.clone(),
                            data: base64::engine::general_purpose::STANDARD.encode(bytes),
                        };
                    }
                }
            }
        }
    }

    pub async fn diff(&self, thread_id: ThreadId, turn_id: Option<TurnId>) -> Result<Diff> {
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
        repo.diff(&from, &to).await
    }

    /// Reset the working tree to the snapshot taken before `turn_id`.
    pub async fn revert(&self, thread_id: ThreadId, turn_id: TurnId) -> Result<(String, bool)> {
        let thread = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("thread not found"))?;
        if matches!(thread.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval) {
            return Err(anyhow!("thread is busy; interrupt it first"));
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
            permission_mode: thread.permission_mode,
            resume_session_id: thread.provider_session_id.clone(),
            fork: rewind.is_some(),
            rewind,
            binary: provider_settings.binary.map(PathBuf::from),
            env: provider_settings.env.into_iter().collect(),
        };
        let SpawnedSession { session, events } = driver.spawn(config).await?;
        let live = Arc::new(LiveSession { session, turn: Mutex::new(None), pending: Mutex::new(HashMap::new()) });
        self.inner.sessions.lock().await.insert(thread.id, live.clone());
        let this = self.clone();
        let thread_id = thread.id;
        let pump_live = live.clone();
        tokio::spawn(async move { this.pump(thread_id, pump_live, events).await });
        Ok(live)
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
                self.emit(thread_id, turn_id, EventPayload::ToolCallStarted { call })?;
            }
            DriverEvent::ToolOutputDelta { tool_call_id, delta } => {
                self.emit(thread_id, turn_id, EventPayload::ToolCallOutputDelta { tool_call_id, delta })?;
            }
            DriverEvent::ToolCompleted { tool_call_id, output, is_error } => {
                self.emit(thread_id, turn_id, EventPayload::ToolCallCompleted { tool_call_id, output, is_error })?;
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
                if anchors.turn_id.is_some() || anchors.previous_end.is_some() {
                    if let Ok(Some(mut c)) = self.inner.store.checkpoint_get(turn.id) {
                        c.provider_turn_id = anchors.turn_id.clone();
                        c.provider_turn_end = anchors.previous_end.clone();
                        let _ = self.inner.store.checkpoint_upsert(&c);
                    }
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
                self.checkpoint(&t, turn_id, "after").await;
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
                self.checkpoint(&t, turn_id, "after").await;
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
