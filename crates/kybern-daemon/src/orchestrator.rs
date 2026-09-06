//! Owns live provider sessions and turns their events into the persisted,
//! broadcast thread log.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use anyhow::{Context, Result, anyhow};
use chrono::Utc;
use kybern_drivers::registry::DriverRegistry;
use kybern_drivers::{
    AgentSession, DriverEvent, DriverRuntimeTask, DriverRuntimeTaskUpdate, RewindPoint, SessionConfig, SpawnedSession, TurnAnchors,
};
use kybern_git::{Repo, checkpoint_ref};
use kybern_protocol::*;
use kybern_store::{Store, TurnUsageRow};
use tokio::sync::{Mutex, Notify, broadcast};
use uuid::Uuid;

use crate::config::Paths;
use crate::settings::SettingsStore;

#[derive(Clone)]
pub struct Orchestrator {
    inner: Arc<Inner>,
}

struct Inner {
    commands: std::sync::Mutex<()>,
    thread_updates: std::sync::Mutex<()>,
    store: Store,
    drivers: DriverRegistry,
    events: broadcast::Sender<ThreadEvent>,
    paths: Paths,
    settings: SettingsStore,
    sessions: Mutex<HashMap<ThreadId, Arc<LiveSession>>>,
    releasing: Mutex<HashMap<ThreadId, tokio::sync::watch::Receiver<()>>>,
    harness_gates: HashMap<ProviderKind, Arc<tokio::sync::RwLock<()>>>,
    /// Threads whose next session must fork the provider conversation at this point.
    pending_rewinds: Mutex<HashMap<ThreadId, RewindPoint>>,
    /// Woken whenever a queued follow-up may have become dispatchable, so the
    /// queue worker sleeps instead of polling the store.
    queue_wakeup: Notify,
}

struct LiveSession {
    session: Box<dyn AgentSession>,
    /// Last moment the user or the provider touched this session. Idle
    /// release is measured from here.
    last_activity: std::sync::Mutex<Instant>,
    /// Set once the daemon decided to close this process on purpose, so the
    /// provider's exit is not reported as a failure.
    released: AtomicBool,
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
    /// background agents are still active, then resume the root assistant from
    /// an internal task notification. Hold that provisional result so the
    /// continuation remains part of this turn and retains stable message ids.
    pending_completion: Option<PendingTurnCompletion>,
}

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
        *self.last_activity.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Instant::now();
    }

    fn last_activity(&self) -> Instant {
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
        events: broadcast::Sender<ThreadEvent>,
        paths: Paths,
        settings: SettingsStore,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                commands: std::sync::Mutex::new(()),
                thread_updates: std::sync::Mutex::new(()),
                store,
                drivers,
                events,
                paths,
                settings,
                sessions: Mutex::new(HashMap::new()),
                releasing: Mutex::new(HashMap::new()),
                harness_gates: ProviderKind::ALL.into_iter().map(|kind| (kind, Arc::new(tokio::sync::RwLock::new(())))).collect(),
                pending_rewinds: Mutex::new(HashMap::new()),
                queue_wakeup: Notify::new(),
            }),
        }
    }

    /// Resolves the next time a queued follow-up may be ready to dispatch.
    pub async fn queue_changed(&self) {
        self.inner.queue_wakeup.notified().await;
    }

    /// A client opened or subscribed to this thread. Counts as activity so a
    /// thread someone is reading keeps its warm process.
    pub async fn touch_session(&self, thread_id: ThreadId) {
        if let Some(live) = self.inner.sessions.lock().await.get(&thread_id) {
            live.touch();
        }
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
        self.release_idle_sessions_at(policy, saving_power, Instant::now()).await
    }

    async fn release_idle_sessions_at(&self, policy: &BackgroundSettings, saving_power: bool, now: Instant) -> Result<Vec<SessionRelease>> {
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
                parked.push((thread_id, live));
            }
        }
        parked.sort_by_key(|(_, live)| live.last_activity());
        let mut planned = Vec::new();
        let mut fresh = Vec::new();
        for (thread_id, live) in parked {
            match idle_limit {
                Some(limit) if now.saturating_duration_since(live.last_activity()) >= limit => {
                    planned.push((thread_id, live, idle_reason));
                }
                _ => fresh.push((thread_id, live)),
            }
        }
        if let Some(cap) = cap
            && fresh.len() > cap
        {
            let excess = fresh.len() - cap;
            planned.extend(fresh.drain(..excess).map(|(thread_id, live)| (thread_id, live, SessionReleaseReason::Capacity)));
        }
        if planned.is_empty() {
            return Ok(Vec::new());
        }
        let mut claimed = Vec::new();
        {
            let mut sessions = self.inner.sessions.lock().await;
            for (thread_id, live, reason) in planned {
                if !sessions.get(&thread_id).is_some_and(|current| Arc::ptr_eq(current, &live)) {
                    continue;
                }
                if !self.session_parked(thread_id, &live).await? {
                    continue;
                }
                let (done, waiting) = tokio::sync::watch::channel(());
                self.inner.releasing.lock().await.insert(thread_id, waiting);
                sessions.remove(&thread_id);
                live.mark_released();
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
        Ok(())
    }

    pub async fn shutdown(&self) {
        let sessions: Vec<_> = self.inner.sessions.lock().await.drain().collect();
        for (_, live) in &sessions {
            live.mark_released();
        }
        let _ = futures::future::join_all(sessions.iter().map(|(_, live)| live.session.close())).await;
    }

    // ---- persistence helpers ----

    fn emit(&self, thread_id: ThreadId, turn_id: Option<TurnId>, payload: EventPayload) -> Result<ThreadEvent> {
        let ev = self.inner.store.event_append(thread_id, turn_id, payload)?;
        if matches!(
            ev.payload,
            EventPayload::MessageQueued { .. } | EventPayload::ThreadUpdated { .. } | EventPayload::RuntimeTaskCompleted { .. }
        ) {
            self.inner.queue_wakeup.notify_one();
        }
        let _ = self.inner.events.send(ev.clone());
        Ok(ev)
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
            t.status = ThreadStatus::Archived;
            self.update_thread(t)?;
            self.emit(thread_id, None, EventPayload::ThreadArchived)?;
        }
        if let Some(live) = self.inner.sessions.lock().await.remove(&thread_id) {
            live.mark_released();
            let _ = live.session.close().await;
        }
        Ok(())
    }

    pub async fn send(&self, thread_id: ThreadId, message: UserMessage) -> Result<(TurnId, MessageId)> {
        self.send_with_id(thread_id, Uuid::now_v7(), message, false).await
    }

    async fn send_with_id(
        &self,
        thread_id: ThreadId,
        message_id: MessageId,
        mut message: UserMessage,
        queued: bool,
    ) -> Result<(TurnId, MessageId)> {
        let kind = self.inner.store.thread_get(thread_id)?.ok_or_else(|| anyhow!("thread not found"))?.provider.kind;
        let _harness = self.inner.harness_gates[&kind]
            .clone()
            .try_read_owned()
            .map_err(|_| anyhow!("This agent is updating. Try sending again after the update finishes."))?;
        let _command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
        if queued && !self.inner.store.queue_list(Some(thread_id))?.iter().any(|item| item.id == message_id) {
            return Err(anyhow!("queued message was removed"));
        }
        self.resolve_attachments(&mut message);
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
        Ok((turn_id, message_id))
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

    /// One daemon-owned worker consumes accepted follow-ups, independently of clients.
    /// Failed turns retain their queue until the user sends a new successful turn.
    ///
    /// Returns whether a follow-up is still waiting on a thread that is busy
    /// or finishing background work, so the worker knows to check back soon.
    pub async fn drain_queues(&self) -> Result<bool> {
        let mut waiting = false;
        for queued in self.inner.store.queue_list(None)? {
            let Some(thread) = self.inner.store.thread_get(queued.thread_id)? else { continue };
            if thread.status != ThreadStatus::Idle {
                waiting |= matches!(thread.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval);
                continue;
            }
            if self.inner.store.runtime_tasks_for_thread(thread.id)?.iter().any(|task| task.status.is_active()) {
                waiting = true;
                continue;
            }
            if let Err(error) = self.send_with_id(thread.id, queued.id, queued.message, true).await {
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
            *turn = Some(ActiveTurn {
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

        if let Err(e) = live.session.send_message(&message_id.to_string(), &message).await {
            self.emit(thread.id, Some(turn_id), EventPayload::TurnFailed { error: e.to_string() })?;
            let mut t = thread;
            t.status = ThreadStatus::Failed;
            self.update_thread(t)?;
            *live.turn.lock().await = None;
            return Err(e.into());
        }
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
        let live = self.inner.sessions.lock().await.get(&thread_id).cloned();
        match live {
            Some(live) => {
                live.touch();
                Ok(live.session.interrupt().await?)
            }
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
        live.touch();
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
            last_activity: std::sync::Mutex::new(Instant::now()),
            released: AtomicBool::new(false),
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
        let emitted = self.emit(thread_id, Some(task.origin_turn_id), payload)?;
        let task = match emitted.payload {
            EventPayload::RuntimeTaskStarted { task }
            | EventPayload::RuntimeTaskUpdated { task }
            | EventPayload::RuntimeTaskCompleted { task } => task,
            _ => unreachable!("runtime task emission changed payload kind"),
        };
        live.tasks.lock().await.insert(task.id.clone(), task.clone());
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
        // An idle session retired for an update must not remove its replacement.
        {
            let mut sessions = self.inner.sessions.lock().await;
            if sessions.get(&thread_id).is_some_and(|current| Arc::ptr_eq(current, &live)) {
                sessions.remove(&thread_id);
            }
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
    }

    async fn handle_driver_event(&self, thread_id: ThreadId, live: &Arc<LiveSession>, ev: DriverEvent) -> Result<()> {
        live.touch();
        let mut turn_guard = live.turn.lock().await;
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
                            false,
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
                    EventPayload::ToolCallCompleted { tool_call_id: tool_call_id.clone(), output: output.clone(), is_error },
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
            DriverEvent::TurnCompleted { stop_reason, usage, cost_usd, duration_ms, anchors } => {
                let Some(turn) = turn_guard.as_mut() else { return Ok(()) };
                let has_active_agents = if turn.provider == ProviderKind::ClaudeCode && stop_reason == StopReason::Completed {
                    live.tasks
                        .lock()
                        .await
                        .values()
                        .any(|task| task.origin_turn_id == turn.id && task.kind == RuntimeTaskKind::Agent && task.status.is_active())
                } else {
                    false
                };
                if has_active_agents {
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
                        "holding Claude's provisional result while background agents finish"
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
                *turn_guard = None;
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

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    use super::{ActiveTurn, LiveSession, Orchestrator, generic_runtime_task, generic_runtime_task_for_provider, output_indicates_running};
    use crate::config::Paths;
    use crate::settings::SettingsStore;
    use kybern_drivers::registry::DriverRegistry;
    use kybern_drivers::{AgentSession, DriverEvent, DriverRuntimeTaskUpdate, TurnAnchors};
    use kybern_protocol::*;
    use kybern_store::Store;
    use serde_json::json;
    use tokio::sync::{Mutex, broadcast};
    use uuid::Uuid;

    #[derive(Default)]
    struct TestSession {
        closes: Arc<AtomicUsize>,
    }

    #[async_trait::async_trait]
    impl AgentSession for TestSession {
        async fn send_message(&self, _message_id: &str, _message: &UserMessage) -> kybern_drivers::Result<()> {
            Ok(())
        }

        async fn interrupt(&self) -> kybern_drivers::Result<()> {
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
        };
        store.thread_upsert(&thread).unwrap();
        let (events_tx, _) = broadcast::channel(32);
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
            kind: RuntimeTaskKind::Agent,
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
            session: Box::new(TestSession::default()),
            last_activity: std::sync::Mutex::new(Instant::now()),
            released: AtomicBool::new(false),
            turn: Mutex::new(Some(ActiveTurn {
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
            last_turn_id: Mutex::new(Some(turn_id)),
            tasks: Mutex::new(HashMap::from([(task.id.clone(), task)])),
            deferred_checkpoints: Mutex::new(HashSet::new()),
            pending: Mutex::new(HashMap::new()),
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
        assert!(live.turn.lock().await.as_ref().is_some_and(|turn| turn.pending_completion.is_some()));
        assert!(
            !store.events_for_thread(thread.id).unwrap().iter().any(|event| matches!(event.payload, EventPayload::TurnCompleted { .. }))
        );

        orchestrator
            .handle_driver_event(
                thread.id,
                &live,
                DriverEvent::RuntimeTaskCompleted(DriverRuntimeTaskUpdate::status("agent-1", RuntimeTaskStatus::Completed)),
            )
            .await
            .unwrap();
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
        assert_eq!(completed.len(), 1);
        assert_eq!(completed[0].0.input_tokens, 4);
        assert_eq!(completed[0].0.output_tokens, 6);
        assert!((completed[0].1.unwrap_or_default() - 0.3).abs() < f64::EPSILON);
        assert_eq!(*completed[0].2, Some(message_ids[2]));
        assert!(live.turn.lock().await.is_none());

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
            let (events_tx, _) = broadcast::channel(64);
            let orchestrator = Orchestrator::new(store.clone(), DriverRegistry::default(), events_tx, paths, settings);
            Self { root, store, orchestrator, project }
        }

        fn thread(&self, status: ThreadStatus) -> Thread {
            let now = chrono::Utc::now();
            let thread = Thread {
                id: Uuid::now_v7(),
                project_id: self.project.id,
                title: "Fixture".into(),
                provider: ProviderInstance::default_for(ProviderKind::ClaudeCode),
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
            };
            self.store.thread_upsert(&thread).unwrap();
            thread
        }

        /// Attach a parked session whose last activity was `last_activity`.
        async fn park(&self, thread: &Thread, last_activity: Instant) -> (Arc<LiveSession>, Arc<AtomicUsize>) {
            let closes = Arc::new(AtomicUsize::new(0));
            let live = Arc::new(LiveSession {
                session: Box::new(TestSession { closes: closes.clone() }),
                last_activity: std::sync::Mutex::new(last_activity),
                released: AtomicBool::new(false),
                turn: Mutex::new(None),
                last_turn_id: Mutex::new(None),
                tasks: Mutex::new(HashMap::new()),
                deferred_checkpoints: Mutex::new(HashSet::new()),
                pending: Mutex::new(HashMap::new()),
            });
            self.orchestrator.inner.sessions.lock().await.insert(thread.id, live.clone());
            (live, closes)
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

    fn policy(session_idle_minutes: u32, max_idle_sessions: u32) -> BackgroundSettings {
        BackgroundSettings { session_idle_minutes, max_idle_sessions, ..BackgroundSettings::default() }
    }

    const MINUTE: Duration = Duration::from_secs(60);

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

        let early = fixture.orchestrator.release_idle_sessions_at(&policy(10, 0), false, started + 9 * MINUTE).await.unwrap();
        assert!(early.is_empty());
        assert!(fixture.has_session(&thread).await);

        let released = fixture.orchestrator.release_idle_sessions_at(&policy(10, 0), false, started + 10 * MINUTE).await.unwrap();
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
        let released = fixture.orchestrator.release_idle_sessions_at(&policy(30, 4), true, started).await.unwrap();
        assert_eq!(released, vec![super::SessionRelease { thread_id: older.id, reason: SessionReleaseReason::Power }]);
        assert_eq!(closes.load(Ordering::SeqCst), 1);
        assert!(fixture.has_session(&fresh).await, "a session inside the grace period is kept");
        assert_eq!(fixture.release_events(&older), vec![SessionReleaseReason::Power]);

        let released = fixture
            .orchestrator
            .release_idle_sessions_at(&policy(30, 4), true, started + BackgroundSettings::BATTERY_SESSION_IDLE)
            .await
            .unwrap();
        assert_eq!(released.len(), 1);
        assert!(!fixture.has_session(&fresh).await);
    }

    #[tokio::test]
    async fn opening_a_thread_counts_as_activity() {
        let fixture = Fixture::new();
        let thread = fixture.thread(ThreadStatus::Idle);
        let started = Instant::now();
        let (live, _) = fixture.park(&thread, started - 5 * MINUTE).await;
        fixture.orchestrator.touch_session(thread.id).await;
        assert!(live.last_activity() >= started);
        fixture.orchestrator.touch_session(Uuid::now_v7()).await;
    }

    #[tokio::test]
    async fn failed_threads_release_like_idle_ones() {
        let fixture = Fixture::new();
        let thread = fixture.thread(ThreadStatus::Failed);
        let started = Instant::now();
        let (_, closes) = fixture.park(&thread, started).await;
        let released = fixture.orchestrator.release_idle_sessions_at(&policy(1, 0), false, started + MINUTE).await.unwrap();
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

        let released = fixture.orchestrator.release_idle_sessions_at(&policy(1, 1), false, later).await.unwrap();
        assert!(released.is_empty());
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

        let released = fixture.orchestrator.release_idle_sessions_at(&policy(30, 2), false, started + 3 * MINUTE).await.unwrap();
        assert_eq!(released, vec![super::SessionRelease { thread_id: oldest.id, reason: SessionReleaseReason::Capacity }]);
        assert_eq!(oldest_closes.load(Ordering::SeqCst), 1);
        assert_eq!(middle_closes.load(Ordering::SeqCst), 0);
        assert_eq!(newest_closes.load(Ordering::SeqCst), 0);
        assert_eq!(fixture.release_events(&oldest), vec![SessionReleaseReason::Capacity]);

        // Expired sessions do not count against the cap; both rules apply in one pass.
        let released = fixture.orchestrator.release_idle_sessions_at(&policy(2, 1), false, started + 4 * MINUTE).await.unwrap();
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

        live.touch();
        let released = fixture.orchestrator.release_idle_sessions_at(&policy(10, 0), false, started + 10 * MINUTE).await.unwrap();
        assert!(released.is_empty(), "a touch just now keeps the session warm");

        let far = started + 24 * 60 * MINUTE;
        let released = fixture.orchestrator.release_idle_sessions_at(&policy(0, 0), false, far).await.unwrap();
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
}
