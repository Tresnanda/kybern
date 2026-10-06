// Orchestrator V2 delegation tests. Included into `orchestrator::tests` so they
// can use its fixture, live-session helpers and scripted sessions.

/// One agent process the scripted driver started.
#[derive(Clone)]
struct ScriptedChild {
    tx: tokio::sync::mpsc::Sender<DriverEvent>,
    messages: Arc<Mutex<Vec<UserMessage>>>,
    interrupts: Arc<AtomicUsize>,
    closes: Arc<AtomicUsize>,
    cwd: PathBuf,
}

impl ScriptedChild {
    /// Everything this agent was sent, as one searchable string.
    async fn transcript(&self) -> String {
        serde_json::to_string(&*self.messages.lock().await).unwrap()
    }

    async fn finish(&self, text: &str) {
        self.tx
            .send(DriverEvent::MessageCompleted {
                message_id: Uuid::now_v7().to_string(),
                origin: EventOrigin::Root,
                text: text.into(),
                thinking: None,
            })
            .await
            .unwrap();
        self.tx.send(completed_response(StopReason::Completed)).await.unwrap();
    }
}

struct ScriptedSession {
    tx: tokio::sync::mpsc::Sender<DriverEvent>,
    messages: Arc<Mutex<Vec<UserMessage>>>,
    interrupts: Arc<AtomicUsize>,
    closes: Arc<AtomicUsize>,
}

#[async_trait::async_trait]
impl AgentSession for ScriptedSession {
    async fn send_message(&self, _message_id: &str, message: &UserMessage) -> kybern_drivers::Result<()> {
        self.messages.lock().await.push(message.clone());
        Ok(())
    }

    async fn steer(&self, _message_id: &str, message: &UserMessage) -> kybern_drivers::Result<()> {
        self.messages.lock().await.push(message.clone());
        Ok(())
    }

    async fn interrupt(&self) -> kybern_drivers::Result<()> {
        self.interrupts.fetch_add(1, Ordering::SeqCst);
        let _ = self.tx.send(completed_response(StopReason::Interrupted)).await;
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

/// A driver whose agents the test controls event by event.
struct ScriptedDriver {
    kind: ProviderKind,
    spawned: Arc<std::sync::Mutex<Vec<ScriptedChild>>>,
}

#[async_trait::async_trait]
impl kybern_drivers::AgentDriver for ScriptedDriver {
    fn kind(&self) -> ProviderKind {
        self.kind
    }

    async fn probe(&self, _binary: Option<&PathBuf>) -> ProviderStatus {
        ProviderStatus {
            kind: self.kind,
            display_name: "Scripted".into(),
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
        let (tx, events) = tokio::sync::mpsc::channel(64);
        let child = ScriptedChild {
            tx: tx.clone(),
            messages: Arc::new(Mutex::new(Vec::new())),
            interrupts: Arc::new(AtomicUsize::new(0)),
            closes: Arc::new(AtomicUsize::new(0)),
            cwd: config.cwd.clone(),
        };
        let session =
            ScriptedSession { tx, messages: child.messages.clone(), interrupts: child.interrupts.clone(), closes: child.closes.clone() };
        self.spawned.lock().unwrap().push(child);
        Ok(kybern_drivers::SpawnedSession { session: Box::new(session), events })
    }
}

struct Delegating {
    fixture: Fixture,
    spawned: Arc<std::sync::Mutex<Vec<ScriptedChild>>>,
    parent: Thread,
    live: Arc<LiveSession>,
    parent_messages: Arc<Mutex<Vec<UserMessage>>>,
}

impl Delegating {
    async fn new() -> Self {
        Self::with_mode(PermissionMode::Supervised).await
    }

    async fn with_mode(mode: PermissionMode) -> Self {
        let spawned = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut drivers = DriverRegistry::default();
        drivers.register(Arc::new(ScriptedDriver { kind: ProviderKind::ClaudeCode, spawned: spawned.clone() }));
        drivers.register(Arc::new(ScriptedDriver { kind: ProviderKind::Codex, spawned: spawned.clone() }));
        let fixture = Fixture::with_drivers(drivers);
        std::fs::create_dir_all(&fixture.root).unwrap();
        fixture.orchestrator.set_delegation_debounce(Duration::from_millis(60));
        let mut parent = fixture.thread(ThreadStatus::Idle);
        parent.title = "Parent thread".into();
        parent.permission_mode = mode;
        fixture.store.thread_upsert(&parent).unwrap();
        let (live, _, parent_messages) = fixture.park_recording(&parent, Instant::now()).await;
        fixture.orchestrator.send(parent.id, UserMessage::text("coordinate the work")).await.unwrap();
        live.turn_ready.notified().await;
        Self { fixture, spawned, parent, live, parent_messages }
    }

    async fn tool(&self, name: &str, args: serde_json::Value) -> anyhow::Result<serde_json::Value> {
        self.fixture.tool(&self.parent, &self.live, &Uuid::now_v7().to_string(), name, args).await
    }

    async fn delegate(&self, args: serde_json::Value) -> serde_json::Value {
        self.tool("kybern_agent_delegate", args).await.unwrap()
    }

    /// The scripted agent whose brief mentions `needle`, once it has been sent its task.
    async fn agent(&self, needle: &str) -> ScriptedChild {
        eventually(|| async {
            let candidates: Vec<ScriptedChild> = self.spawned.lock().unwrap().clone();
            for candidate in candidates {
                if candidate.transcript().await.contains(needle) {
                    return Some(candidate);
                }
            }
            None
        })
        .await
    }

    fn delegation(&self, task_id: &serde_json::Value) -> Thread {
        let task_id = Uuid::parse_str(task_id.as_str().unwrap()).unwrap();
        self.fixture.store.delegation_find_by_task(task_id).unwrap().unwrap()
    }

    fn queued_results(&self) -> Vec<Vec<AgentResultItem>> {
        self.fixture
            .store
            .queue_list(Some(self.parent.id))
            .unwrap()
            .into_iter()
            .filter_map(|queued| match queued.message.parts.as_slice() {
                [ContentPart::AgentResults { items }] => Some(items.clone()),
                _ => None,
            })
            .collect()
    }

    /// End the parent's turn so results queue instead of steering.
    async fn end_parent_turn(&self) {
        self.fixture
            .orchestrator
            .process_driver_event(self.parent.id, &self.live, completed_response(StopReason::Completed), false)
            .await
            .unwrap();
        assert_eq!(self.fixture.store.thread_get(self.parent.id).unwrap().unwrap().status, ThreadStatus::Idle);
    }

    async fn child_session(&self, thread: &Thread) -> Arc<LiveSession> {
        eventually(|| async { self.fixture.orchestrator.inner.sessions.lock().await.get(&thread.id).cloned() }).await
    }
}

async fn eventually<T, F, Fut>(mut check: F) -> T
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Option<T>>,
{
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            if let Some(value) = check().await {
                return value;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("condition was not met in time")
}

fn run_git(dir: &std::path::Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "user.name=t", "-c", "user.email=t@t"])
        .args(args)
        .output()
        .unwrap();
    assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn init_project_repo(dir: &std::path::Path) {
    std::fs::create_dir_all(dir).unwrap();
    run_git(dir, &["init", "-q"]);
    std::fs::write(dir.join("tracked.txt"), "one\n").unwrap();
    run_git(dir, &["add", "."]);
    run_git(dir, &["commit", "-q", "-m", "init"]);
}

#[test]
fn child_permission_is_never_broader_than_the_parents() {
    use super::delegation::resolve_child_permission as resolve;
    use PermissionMode::*;
    use ProviderKind::{ClaudeCode, Codex};
    assert_eq!(resolve(AcceptEdits, ClaudeCode, ClaudeCode, None).unwrap(), AcceptEdits, "inherits on the same harness");
    assert_eq!(resolve(AcceptEdits, ClaudeCode, Codex, None).unwrap(), Supervised, "another harness drops to supervised");
    assert_eq!(resolve(FullAccess, ClaudeCode, Codex, None).unwrap(), FullAccess, "a full-access parent may hand it on");
    assert_eq!(resolve(AcceptEdits, ClaudeCode, Codex, Some(Supervised)).unwrap(), Supervised);
    assert_eq!(resolve(FullAccess, ClaudeCode, ClaudeCode, Some(AcceptEdits)).unwrap(), AcceptEdits);
    assert!(resolve(Supervised, ClaudeCode, ClaudeCode, Some(FullAccess)).is_err());
    assert!(resolve(AcceptEdits, ClaudeCode, Codex, Some(AcceptEdits)).is_err(), "no equivalent mapping across harnesses");
    assert!(resolve(AcceptEdits, ClaudeCode, ClaudeCode, Some(Auto)).is_err());
}

#[tokio::test]
async fn delegate_shared_creates_a_one_shot_child_with_only_the_brief() {
    let t = Delegating::new().await;
    let result = t
        .delegate(json!({"task": "Audit the parser for panics.\nList each one.", "role": "research", "owns": ["src/parser/**"], "title": "Parser audit"}))
        .await;
    assert_eq!(result["status"], "running");
    assert_eq!(result["workspace"], "shared");
    assert_eq!(result["title"], "Parser audit");
    assert!(result.get("branch").is_none());
    assert!(result["operation_id"].as_str().is_some());

    let child = t.delegation(&result["task_id"]);
    assert_eq!(child.id.to_string(), result["thread_id"].as_str().unwrap());
    assert_eq!(child.parent_thread_id, Some(t.parent.id));
    assert_eq!(child.cwd, t.parent.cwd, "a shared child works in the parent's checkout");
    assert!(child.worktree.is_none());
    assert_eq!(child.permission_mode, t.parent.permission_mode);
    assert_eq!(child.provider.kind, t.parent.provider.kind);
    let info = child.delegation.clone().unwrap();
    assert_eq!((info.depth, info.role, info.workspace), (1, DelegationRole::Research, DelegationWorkspace::Shared));
    assert_eq!(info.owns, vec!["src/parser/**".to_string()]);
    assert_eq!(info.status, DelegationStatus::Running);
    assert!(info.base_commit.is_none() && info.worktree_state.is_none());

    // Hidden by default like subagents, but listed under its parent.
    assert_eq!(t.fixture.store.delegation_children(t.parent.id).unwrap().len(), 1);
    assert_eq!(t.fixture.store.delegation_active_count(t.parent.id).unwrap(), 1);

    // The child's first turn carries one task message from the parent, and nothing else of the parent's conversation.
    let agent = t.agent("Audit the parser").await;
    let sent = agent.transcript().await;
    for expected in [
        "You are a delegated research agent working for thread \\\"Parent thread\\\".",
        "You share the parent's checkout and branch. Do not commit, stash, reset, checkout, rebase or switch branches; the parent integrates.",
        "You own: src/parser/**. Avoid editing other paths; other agents may own them.",
        "Your final message is returned to the parent as your result, so end with a concise summary of what you did, what changed, and anything unresolved.",
        "Task:\\nAudit the parser for panics.\\nList each one.",
    ] {
        assert!(sent.contains(expected), "brief is missing {expected:?}: {sent}");
    }
    assert!(!sent.contains("coordinate the work"), "the parent's history never reaches the child");
    let started = t
        .fixture
        .store
        .events_for_thread(child.id)
        .unwrap()
        .into_iter()
        .find_map(|event| match event.payload {
            EventPayload::TurnStarted { message_id, message } => Some((message_id, message)),
            _ => None,
        })
        .expect("the child's first turn started");
    let ContentPart::ThreadMessage { message_id, from_thread_id, from_title, purpose, reply_to, .. } = &started.1.parts[0] else {
        panic!("first part must be a thread message: {:?}", started.1.parts)
    };
    assert_eq!(started.1.parts.len(), 1);
    assert_eq!(
        (*message_id, *from_thread_id, from_title.as_str(), *purpose, *reply_to),
        (started.0, Some(t.parent.id), "Parent thread", ThreadMessagePurpose::Task, None)
    );
    let record = t.fixture.store.thread_message_get(started.0).unwrap().expect("a thread_messages row backs the brief");
    assert_eq!(
        (record.purpose, record.state, record.from_thread_id, record.to_thread_id),
        (ThreadMessagePurpose::Task, ThreadMessageState::Delivered, Some(t.parent.id), child.id)
    );
}

#[tokio::test]
async fn retrying_a_delegate_call_returns_the_same_child() {
    let t = Delegating::new().await;
    let args = json!({"task": "Index the repository", "request_key": "index-repo"});
    let first = t.delegate(args.clone()).await;
    let retry = t.delegate(args).await;
    assert_eq!(first["task_id"], retry["task_id"]);
    assert_eq!(first["thread_id"], retry["thread_id"]);
    assert_eq!(t.fixture.store.delegation_children(t.parent.id).unwrap().len(), 1);
    let _ = t.agent("Index the repository").await;
    assert_eq!(t.spawned.lock().unwrap().len(), 1, "a retry never starts a second agent");
    // Another request key is new work.
    let other = t.delegate(json!({"task": "Index the repository", "request_key": "index-repo-2"})).await;
    assert_ne!(first["task_id"], other["task_id"]);
    // Another thread cannot claim this operation.
    let child = t.delegation(&first["task_id"]);
    let operation = child.delegation.unwrap().operation_id;
    let stranger = t.fixture.thread(ThreadStatus::Idle);
    let (stranger_live, _, _) = t.fixture.park_recording(&stranger, Instant::now()).await;
    t.fixture.orchestrator.send(stranger.id, UserMessage::text("hi")).await.unwrap();
    stranger_live.turn_ready.notified().await;
    let error = t
        .fixture
        .tool(&stranger, &stranger_live, "steal", "kybern_agent_delegate", json!({"task": "x", "operation_id": operation}))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("another thread"), "{error}");
}

#[tokio::test]
async fn depth_and_active_children_limits_come_from_settings_and_explain_the_next_step() {
    let t = Delegating::new().await;
    let mut settings = t.fixture.orchestrator.inner.settings.get();
    settings.orchestration = OrchestrationSettings { max_active_children: 2, max_depth: 1 };
    t.fixture.orchestrator.inner.settings.set(settings.clone()).unwrap();

    let first = t.delegate(json!({"task": "one"})).await;
    t.delegate(json!({"task": "two"})).await;
    let error = t.tool("kybern_agent_delegate", json!({"task": "three"})).await.unwrap_err().to_string();
    assert!(error.contains("2 delegated agents running (max 2)") && error.contains("kybern_agent_cancel"), "{error}");

    // A child may not delegate when depth is capped at 1.
    let child = t.delegation(&first["task_id"]);
    let child_live = t.child_session(&child).await;
    let depth_error =
        t.fixture.tool(&child, &child_live, "nested", "kybern_agent_delegate", json!({"task": "nested"})).await.unwrap_err().to_string();
    assert!(depth_error.contains("depth limit reached (max 1)") && depth_error.contains("Settings"), "{depth_error}");

    // Raising the depth allows it and records depth 2.
    settings.orchestration.max_depth = 2;
    t.fixture.orchestrator.inner.settings.set(settings).unwrap();
    let nested = t.fixture.tool(&child, &child_live, "nested-2", "kybern_agent_delegate", json!({"task": "nested"})).await.unwrap();
    let grandchild =
        t.fixture.store.delegation_find_by_task(Uuid::parse_str(nested["task_id"].as_str().unwrap()).unwrap()).unwrap().unwrap();
    assert_eq!(grandchild.delegation.unwrap().depth, 2);
    assert_eq!(grandchild.parent_thread_id, Some(child.id));

    // Finished agents free their slot.
    t.agent("one").await.finish("done one").await;
    eventually(|| async { (t.fixture.store.delegation_active_count(t.parent.id).unwrap() == 1).then_some(()) }).await;
    t.delegate(json!({"task": "three"})).await;
}

#[tokio::test]
async fn delegation_permissions_are_a_subset_of_the_parents() {
    let t = Delegating::with_mode(PermissionMode::Supervised).await;
    let error = t.tool("kybern_agent_delegate", json!({"task": "x", "permission_mode": "full-access"})).await.unwrap_err();
    assert!(error.to_string().contains("conservative subset"), "{error}");
    let ok = t.delegate(json!({"task": "y", "permission_mode": "supervised"})).await;
    assert_eq!(t.delegation(&ok["task_id"]).permission_mode, PermissionMode::Supervised);

    let accept = Delegating::with_mode(PermissionMode::AcceptEdits).await;
    let same = accept.delegate(json!({"task": "same harness"})).await;
    assert_eq!(accept.delegation(&same["task_id"]).permission_mode, PermissionMode::AcceptEdits);
    let other = accept.delegate(json!({"task": "other harness", "provider": "codex"})).await;
    let other = accept.delegation(&other["task_id"]);
    assert_eq!((other.provider.kind, other.permission_mode), (ProviderKind::Codex, PermissionMode::Supervised));
    assert!(other.model.is_none(), "a model of another harness is never inherited");
}

#[tokio::test]
async fn delegate_worktree_is_seeded_from_uncommitted_state_and_reports_its_branch() {
    let t = Delegating::new().await;
    init_project_repo(&t.fixture.root);
    std::fs::write(t.fixture.root.join("wip.txt"), "uncommitted parent work\n").unwrap();
    std::fs::write(t.fixture.root.join("tracked.txt"), "one\ntwo\n").unwrap();

    let result = t.delegate(json!({"task": "Implement the feature", "workspace": "worktree", "role": "implementation"})).await;
    let child = t.delegation(&result["task_id"]);
    let info = child.delegation.clone().unwrap();
    assert_eq!(info.workspace, DelegationWorkspace::Worktree);
    assert_eq!(info.worktree_state, Some(WorktreeState::Active));
    let branch = format!("kybern/{}", child.id);
    assert_eq!(result["branch"], json!(branch));
    assert_eq!(info.branch.as_deref(), Some(branch.as_str()));
    let worktree = child.worktree.clone().expect("a worktree child has its own checkout");
    assert_eq!((worktree.branch.as_str(), child.cwd.as_str()), (branch.as_str(), worktree.path.as_str()));
    assert_ne!(child.cwd, t.parent.cwd);
    assert_eq!(std::fs::read_to_string(std::path::Path::new(&worktree.path).join("wip.txt")).unwrap(), "uncommitted parent work\n");
    assert_eq!(std::fs::read_to_string(std::path::Path::new(&worktree.path).join("tracked.txt")).unwrap(), "one\ntwo\n");
    assert_eq!(run_git(std::path::Path::new(&worktree.path), &["rev-parse", "HEAD"]), info.base_commit.clone().unwrap());
    // The parent's own checkout and index are untouched.
    assert!(run_git(&t.fixture.root, &["status", "--porcelain"]).contains("wip.txt"));

    let agent = t.agent("Implement the feature").await;
    assert_eq!(agent.cwd, PathBuf::from(&worktree.path));
    let sent = agent.transcript().await;
    assert!(sent.contains(&format!("You work in your own worktree on branch {branch}, seeded from the parent's current changes. Commit your work on this branch before you finish. Do not push.")), "{sent}");

    // The child commits; completion records the commit and diffstat against the seed.
    std::fs::write(std::path::Path::new(&worktree.path).join("feature.txt"), "a\nb\nc\n").unwrap();
    run_git(std::path::Path::new(&worktree.path), &["add", "."]);
    run_git(std::path::Path::new(&worktree.path), &["commit", "-q", "-m", "feature"]);
    agent.finish("Implemented it.").await;
    let done = eventually(|| async {
        let thread = t.delegation(&result["task_id"]);
        (thread.delegation.as_ref().unwrap().status != DelegationStatus::Running).then_some(thread)
    })
    .await;
    let info = done.delegation.unwrap();
    assert_eq!(info.status, DelegationStatus::Completed);
    assert_eq!(info.result.as_deref(), Some("Implemented it."));
    assert_eq!(info.head_commit.as_deref(), Some(run_git(std::path::Path::new(&worktree.path), &["rev-parse", "HEAD"]).as_str()));
    assert_eq!(info.diffstat, Some(DiffStat { files: 1, additions: 3, deletions: 0 }));
    assert_eq!(info.worktree_state, Some(WorktreeState::Active), "unmerged work is never removed");
}

#[tokio::test]
async fn worktree_result_warns_when_the_child_left_uncommitted_changes() {
    let t = Delegating::new().await;
    init_project_repo(&t.fixture.root);
    let result = t.delegate(json!({"task": "Implement the feature", "workspace": "worktree"})).await;
    let child = t.delegation(&result["task_id"]);
    let worktree = child.worktree.clone().expect("a worktree child has its own checkout");
    let agent = t.agent("Implement the feature").await;
    std::fs::write(std::path::Path::new(&worktree.path).join("left-over.txt"), "not committed\n").unwrap();
    agent.finish("All done.").await;
    let done = eventually(|| async {
        let thread = t.delegation(&result["task_id"]);
        (thread.delegation.as_ref().unwrap().status != DelegationStatus::Running).then_some(thread)
    })
    .await;
    let text = done.delegation.unwrap().result.unwrap();
    assert!(text.starts_with("All done."), "{text}");
    assert!(text.contains("uncommitted changes that are not on the branch"), "{text}");
}

#[tokio::test]
async fn worktree_delegation_needs_a_git_project() {
    let t = Delegating::new().await;
    let error = t.tool("kybern_agent_delegate", json!({"task": "x", "workspace": "worktree"})).await.unwrap_err();
    assert!(error.to_string().contains("needs a git repository") && error.to_string().contains("shared"), "{error}");
    assert!(t.fixture.store.delegation_children(t.parent.id).unwrap().is_empty());
    let error = t.tool("kybern_agent_delegate", json!({"task": "x", "owns": ["a/**"], "workspace": "worktree"})).await.unwrap_err();
    assert!(error.to_string().contains("owns only applies"), "{error}");
}

#[tokio::test]
async fn children_finishing_together_wake_a_running_parent_with_one_steered_batch() {
    let t = Delegating::new().await;
    let a = t.delegate(json!({"task": "task alpha", "role": "review"})).await;
    let b = t.delegate(json!({"task": "task beta"})).await;
    let (alpha, beta) = (t.agent("task alpha").await, t.agent("task beta").await);
    alpha.finish("alpha found two problems").await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    beta.finish("beta is fine").await;

    let steered = eventually(|| async {
        let messages = t.parent_messages.lock().await;
        messages.iter().find(|message| matches!(message.parts.as_slice(), [ContentPart::AgentResults { .. }])).cloned()
    })
    .await;
    let [ContentPart::AgentResults { items }] = steered.parts.as_slice() else { unreachable!() };
    assert_eq!(items.len(), 2, "one batched message for both children");
    let by_task = |id: &serde_json::Value| items.iter().find(|item| item.task_id.to_string() == id.as_str().unwrap()).unwrap().clone();
    let (item_a, item_b) = (by_task(&a["task_id"]), by_task(&b["task_id"]));
    assert_eq!(
        (item_a.status, item_a.role, item_a.result.as_deref()),
        (DelegationStatus::Completed, DelegationRole::Review, Some("alpha found two problems"))
    );
    assert_eq!(item_b.result.as_deref(), Some("beta is fine"));
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(t.queued_results().is_empty(), "a steered batch is not queued as well");
    assert_eq!(
        t.parent_messages
            .lock()
            .await
            .iter()
            .filter(|message| matches!(message.parts.as_slice(), [ContentPart::AgentResults { .. }]))
            .count(),
        1
    );
    let events = t.fixture.store.events_for_thread(t.parent.id).unwrap();
    assert_eq!(events.iter().filter(|event| matches!(&event.payload, EventPayload::MessageSteered { message, .. } if matches!(message.parts.as_slice(), [ContentPart::AgentResults { .. }]))).count(), 1);
    // The flattened text agents read.
    let text = steered.parts[0].orchestration_text().unwrap();
    assert!(text.starts_with("Results from 2 delegated agent(s):") && text.contains("delegate again with a full brief"), "{text}");
}

#[tokio::test]
async fn results_queue_for_an_idle_parent_and_late_results_merge_into_the_queued_message() {
    let t = Delegating::new().await;
    t.delegate(json!({"task": "first job"})).await;
    t.delegate(json!({"task": "second job"})).await;
    t.end_parent_turn().await;

    t.agent("first job").await.finish("first done").await;
    let queued = eventually(|| async { (!t.queued_results().is_empty()).then(|| t.queued_results()) }).await;
    assert_eq!((queued.len(), queued[0].len()), (1, 1));
    // A second result after the window replaces the queued message with a merged one.
    t.agent("second job").await.finish("second done").await;
    let merged = eventually(|| async { t.queued_results().first().filter(|items| items.len() == 2).cloned() }).await;
    assert_eq!(t.queued_results().len(), 1, "never a second queued results message");
    assert_eq!(merged.iter().map(|item| item.result.clone().unwrap()).collect::<Vec<_>>(), vec!["first done", "second done"]);
    let events = t.fixture.store.events_for_thread(t.parent.id).unwrap();
    assert_eq!(
        events.iter().filter(|event| matches!(event.payload, EventPayload::MessageRemoved { .. })).count(),
        1,
        "the earlier message was removed"
    );
}

#[tokio::test]
async fn failed_children_report_their_error_to_the_parent() {
    let t = Delegating::new().await;
    let result = t.delegate(json!({"task": "doomed job"})).await;
    t.end_parent_turn().await;
    let agent = t.agent("doomed job").await;
    agent.tx.send(DriverEvent::TurnFailed { error: "rate limited".into() }).await.unwrap();
    let items = eventually(|| async { t.queued_results().into_iter().next() }).await;
    assert_eq!((items[0].status, items[0].error.as_deref()), (DelegationStatus::Failed, Some("rate limited")));
    assert_eq!(t.delegation(&result["task_id"]).delegation.unwrap().status, DelegationStatus::Failed);
    assert_eq!(t.fixture.store.delegation_active_count(t.parent.id).unwrap(), 0);
}

#[tokio::test]
async fn wait_mode_returns_the_result_and_is_not_repeated_in_a_batch() {
    let t = Delegating::new().await;
    let call = t.tool("kybern_agent_delegate", json!({"task": "quick lookup", "mode": "wait", "timeout_ms": 5000}));
    let finishing = async {
        let agent = t.agent("quick lookup").await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        agent.finish("the answer is 42").await;
    };
    let (result, ()) = tokio::join!(call, finishing);
    let result = result.unwrap();
    assert_eq!((result["status"].as_str(), result["result"].as_str()), (Some("completed"), Some("the answer is 42")));
    assert!(result.get("wait_timed_out").is_none());
    t.end_parent_turn().await;
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert!(t.queued_results().is_empty(), "the result was already returned inline");
    let steered =
        t.parent_messages.lock().await.iter().any(|message| matches!(message.parts.as_slice(), [ContentPart::AgentResults { .. }]));
    assert!(!steered);
}

#[tokio::test]
async fn wait_timeout_leaves_the_child_running_and_its_result_still_arrives() {
    let t = Delegating::new().await;
    let result = t.delegate(json!({"task": "slow job", "mode": "wait", "timeout_ms": 120})).await;
    assert_eq!(result["wait_timed_out"], true);
    assert_eq!(result["status"], "running");
    assert_eq!(t.delegation(&result["task_id"]).delegation.unwrap().status, DelegationStatus::Running);

    let wait = t.tool("kybern_agent_wait", json!({"timeout_ms": 100})).await.unwrap();
    assert_eq!(wait["wait_timed_out"], true);
    assert_eq!(wait["agents"][0]["status"], "running");

    t.end_parent_turn().await;
    t.agent("slow job").await.finish("finally").await;
    let items = eventually(|| async { t.queued_results().into_iter().next() }).await;
    assert_eq!(items[0].result.as_deref(), Some("finally"));
    // Waiting after the fact returns immediately with the result (in the parent's next turn).
    t.fixture.orchestrator.send(t.parent.id, UserMessage::text("what happened?")).await.unwrap();
    t.live.turn_ready.notified().await;
    let wait = t.tool("kybern_agent_wait", json!({"task_ids": [result["task_id"]]})).await.unwrap();
    assert_eq!((wait["wait_timed_out"].as_bool(), wait["agents"][0]["result"].as_str()), (Some(false), Some("finally")));
    let status = t.tool("kybern_agent_status", json!({})).await.unwrap();
    assert_eq!(status["agents"][0]["status"], "completed");
}

#[tokio::test]
async fn cancel_stops_the_child_and_its_grandchild_and_drops_their_queues() {
    let t = Delegating::new().await;
    let result = t.delegate(json!({"task": "mid-level job"})).await;
    let child = t.delegation(&result["task_id"]);
    let child_live = t.child_session(&child).await;
    let nested = t.fixture.tool(&child, &child_live, "nested", "kybern_agent_delegate", json!({"task": "leaf job"})).await.unwrap();
    let mid_agent = t.agent("mid-level job").await;
    let leaf_agent = t.agent("leaf job").await;
    let grandchild = t.delegation(&nested["task_id"]);
    // Something is waiting in the grandchild's queue.
    t.fixture
        .orchestrator
        .enqueue(methods::QueuedMessage { id: Uuid::now_v7(), thread_id: grandchild.id, message: UserMessage::text("later") })
        .unwrap();

    let cancelled = t.tool("kybern_agent_cancel", json!({"task_id": result["task_id"]})).await.unwrap();
    assert_eq!(cancelled["status"], "cancelled");
    assert_eq!(t.delegation(&result["task_id"]).delegation.unwrap().status, DelegationStatus::Cancelled);
    assert_eq!(t.delegation(&nested["task_id"]).delegation.unwrap().status, DelegationStatus::Cancelled);
    assert_eq!((mid_agent.interrupts.load(Ordering::SeqCst), leaf_agent.interrupts.load(Ordering::SeqCst)), (1, 1));
    assert!(t.fixture.store.queue_list(Some(grandchild.id)).unwrap().is_empty());
    assert_eq!(t.fixture.store.delegation_active_count(t.parent.id).unwrap(), 0);

    // Idempotent, and the interrupted turns do not turn into results for the parent.
    let again = t.tool("kybern_agent_cancel", json!({"task_id": result["task_id"]})).await.unwrap();
    assert_eq!(again["status"], "cancelled");
    t.end_parent_turn().await;
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert!(
        t.queued_results().is_empty()
            && !t.parent_messages.lock().await.iter().any(|m| matches!(m.parts.as_slice(), [ContentPart::AgentResults { .. }]))
    );
}

#[tokio::test]
async fn stopping_the_parent_cascades_and_lineage_stop_cancels_only_below_the_child() {
    let t = Delegating::new().await;
    let a = t.delegate(json!({"task": "branch a"})).await;
    let b = t.delegate(json!({"task": "branch b"})).await;
    let (agent_a, agent_b) = (t.agent("branch a").await, t.agent("branch b").await);
    let child_a = t.delegation(&a["task_id"]);
    let live_a = t.child_session(&child_a).await;
    let grand = t.fixture.tool(&child_a, &live_a, "g", "kybern_agent_delegate", json!({"task": "grand a"})).await.unwrap();
    let grand_agent = t.agent("grand a").await;

    // Lineage Stop on a child (threads.interrupt on it) cancels it and what it launched, not its sibling.
    t.end_parent_turn().await;
    t.fixture.orchestrator.interrupt(child_a.id).await.unwrap();
    assert_eq!(t.delegation(&a["task_id"]).delegation.unwrap().status, DelegationStatus::Cancelled);
    assert_eq!(t.delegation(&grand["task_id"]).delegation.unwrap().status, DelegationStatus::Cancelled);
    assert_eq!(t.delegation(&b["task_id"]).delegation.unwrap().status, DelegationStatus::Running);
    assert_eq!(
        (
            agent_a.interrupts.load(Ordering::SeqCst),
            grand_agent.interrupts.load(Ordering::SeqCst),
            agent_b.interrupts.load(Ordering::SeqCst)
        ),
        (1, 1, 0)
    );
    // The user stopped a child, so its parent hears about it.
    let items = eventually(|| async { t.queued_results().into_iter().next() }).await;
    assert_eq!((items.len(), items[0].status), (1, DelegationStatus::Cancelled));

    // Stopping the parent stops what is left.
    t.fixture.orchestrator.interrupt(t.parent.id).await.ok();
    assert_eq!(t.delegation(&b["task_id"]).delegation.unwrap().status, DelegationStatus::Cancelled);
    assert_eq!(agent_b.interrupts.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn thread_interrupt_only_reaches_the_callers_delegated_descendants() {
    let t = Delegating::new().await;
    let result = t.delegate(json!({"task": "interruptible"})).await;
    let child = t.delegation(&result["task_id"]);
    let stopped = t.tool("kybern_thread_interrupt", json!({"thread_id": child.id})).await.unwrap();
    assert_eq!(stopped["status"], "cancelled");
    let stranger = t.fixture.thread(ThreadStatus::Idle);
    let error = t.tool("kybern_thread_interrupt", json!({"thread_id": stranger.id})).await.unwrap_err();
    assert!(error.to_string().contains("only works on threads you delegated work to"), "{error}");
    // A delegated child of someone else is off limits too.
    let mut foreign = t.fixture.thread(ThreadStatus::Running);
    foreign.parent_thread_id = Some(stranger.id);
    let mut info = child.delegation.clone().unwrap();
    info.task_id = Uuid::now_v7();
    info.operation_id = Uuid::now_v7();
    info.parent_thread_id = stranger.id;
    info.status = DelegationStatus::Running;
    foreign.delegation = Some(info);
    t.fixture.store.thread_upsert(&foreign).unwrap();
    let error = t.tool("kybern_thread_interrupt", json!({"thread_id": foreign.id})).await.unwrap_err();
    assert!(error.to_string().contains("only stop agents you delegated"), "{error}");
}

#[tokio::test]
async fn archiving_the_parent_archives_children_and_removes_only_safe_worktrees() {
    let t = Delegating::new().await;
    let mut settings = t.fixture.orchestrator.inner.settings.get();
    settings.orchestration.max_active_children = 8;
    t.fixture.orchestrator.inner.settings.set(settings).unwrap();
    init_project_repo(&t.fixture.root);
    let clean = t.delegate(json!({"task": "reads only", "workspace": "worktree", "role": "research"})).await;
    let dirty = t.delegate(json!({"task": "leaves a mess", "workspace": "worktree"})).await;
    let merged = t.delegate(json!({"task": "lands its work", "workspace": "worktree"})).await;
    let unmerged = t.delegate(json!({"task": "keeps its commit", "workspace": "worktree"})).await;
    let shared = t.delegate(json!({"task": "shared helper"})).await;
    let path = |result: &serde_json::Value| PathBuf::from(t.delegation(&result["task_id"]).worktree.unwrap().path);
    let branch = |result: &serde_json::Value| t.delegation(&result["task_id"]).delegation.unwrap().branch.unwrap();

    std::fs::write(path(&dirty).join("scratch.txt"), "uncommitted\n").unwrap();
    std::fs::write(path(&merged).join("landed.txt"), "landed\n").unwrap();
    run_git(&path(&merged), &["add", "."]);
    run_git(&path(&merged), &["commit", "-q", "-m", "landed"]);
    std::fs::write(path(&unmerged).join("pending.txt"), "pending\n").unwrap();
    run_git(&path(&unmerged), &["add", "."]);
    run_git(&path(&unmerged), &["commit", "-q", "-m", "pending"]);
    // The parent integrates one branch.
    run_git(&t.fixture.root, &["merge", "-q", "--no-ff", "-m", "merge landed", &branch(&merged)]);

    for (needle, text) in [("reads only", "ok"), ("leaves a mess", "ok"), ("lands its work", "ok"), ("keeps its commit", "ok")] {
        t.agent(needle).await.finish(text).await;
    }
    for result in [&clean, &dirty, &merged, &unmerged] {
        eventually(|| async { (t.delegation(&result["task_id"]).delegation.unwrap().status == DelegationStatus::Completed).then_some(()) })
            .await;
    }
    let shared_agent = t.agent("shared helper").await;

    t.fixture.orchestrator.archive_thread(t.parent.id).await.unwrap();

    let state = |result: &serde_json::Value| t.delegation(&result["task_id"]).delegation.unwrap().worktree_state;
    assert_eq!(state(&clean), Some(WorktreeState::Removed));
    assert!(!path(&clean).exists());
    assert_eq!(state(&merged), Some(WorktreeState::Removed));
    assert!(!path(&merged).exists());
    let branches = run_git(&t.fixture.root, &["branch", "--format=%(refname:short)"]);
    assert!(!branches.contains(&branch(&merged)), "a merged branch is deleted: {branches}");
    assert!(!branches.contains(&branch(&clean)), "an empty branch is deleted: {branches}");
    assert_eq!(state(&dirty), Some(WorktreeState::Kept));
    assert!(path(&dirty).join("scratch.txt").exists());
    assert_eq!(state(&unmerged), Some(WorktreeState::Kept));
    assert!(branches.contains(&branch(&unmerged)) && branches.contains(&branch(&dirty)), "unmerged branches are never deleted: {branches}");
    for result in [&clean, &dirty, &merged, &unmerged, &shared] {
        assert_eq!(t.delegation(&result["task_id"]).status, ThreadStatus::Archived);
    }
    assert_eq!(t.fixture.store.thread_get(t.parent.id).unwrap().unwrap().status, ThreadStatus::Archived);
    assert_eq!(shared_agent.interrupts.load(Ordering::SeqCst), 1, "a running child is stopped before it is archived");
    assert_eq!(t.delegation(&shared["task_id"]).delegation.unwrap().status, DelegationStatus::Cancelled);
    assert!(t.delegation(&shared["task_id"]).delegation.unwrap().worktree_state.is_none());

    // A kept worktree is removed on request: not without force, then force discards it but keeps unmerged branches.
    let dirty_thread = t.delegation(&dirty["task_id"]);
    let error = t.fixture.orchestrator.delegation_worktree_remove(dirty_thread.id, false).await.unwrap_err();
    assert!(error.to_string().contains("uncommitted changes"), "{error}");
    let removed = t.fixture.orchestrator.delegation_worktree_remove(dirty_thread.id, true).await.unwrap();
    assert_eq!(removed.delegation.unwrap().worktree_state, Some(WorktreeState::Removed));
    assert!(!path(&dirty).exists());
    assert!(
        !run_git(&t.fixture.root, &["branch", "--format=%(refname:short)"]).contains(&branch(&dirty)),
        "a branch with no commits of its own goes with its worktree"
    );
    let unmerged_thread = t.delegation(&unmerged["task_id"]);
    let error = t.fixture.orchestrator.delegation_worktree_remove(unmerged_thread.id, false).await.unwrap_err();
    assert!(error.to_string().contains("not merged"), "{error}");
    t.fixture.orchestrator.delegation_worktree_remove(unmerged_thread.id, true).await.unwrap();
    assert!(!path(&unmerged).exists());
    assert!(
        run_git(&t.fixture.root, &["branch", "--format=%(refname:short)"]).contains(&branch(&unmerged)),
        "force never deletes an unmerged branch"
    );
    let error = t.fixture.orchestrator.delegation_worktree_remove(t.parent.id, false).await.unwrap_err();
    assert!(error.to_string().contains("not a delegated agent"), "{error}");
}

#[tokio::test]
async fn a_finished_parent_turn_cleans_up_children_whose_branch_was_merged() {
    let t = Delegating::new().await;
    init_project_repo(&t.fixture.root);
    let result = t.delegate(json!({"task": "ship a file", "workspace": "worktree"})).await;
    let child = t.delegation(&result["task_id"]);
    let dir = PathBuf::from(child.worktree.clone().unwrap().path);
    let branch = child.delegation.clone().unwrap().branch.unwrap();
    std::fs::write(dir.join("shipped.txt"), "shipped\n").unwrap();
    run_git(&dir, &["add", "."]);
    run_git(&dir, &["commit", "-q", "-m", "ship"]);
    t.agent("ship a file").await.finish("committed").await;
    eventually(|| async { (t.delegation(&result["task_id"]).delegation.unwrap().status == DelegationStatus::Completed).then_some(()) })
        .await;
    t.end_parent_turn().await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(dir.exists(), "unmerged work survives the parent's turn");
    assert_eq!(t.delegation(&result["task_id"]).delegation.unwrap().worktree_state, Some(WorktreeState::Active));

    // The parent merges and its next turn ends: now the worktree and branch go.
    run_git(&t.fixture.root, &["merge", "-q", "--no-ff", "-m", "merge ship", &branch]);
    t.fixture.orchestrator.send(t.parent.id, UserMessage::text("merged it")).await.unwrap();
    eventually(|| async {
        t.fixture
            .orchestrator
            .inner
            .sessions
            .lock()
            .await
            .get(&t.parent.id)
            .and_then(|live| live.turn.try_lock().ok().map(|turn| turn.is_some()).filter(|active| *active))
    })
    .await;
    t.end_parent_turn().await;
    eventually(|| async {
        (t.delegation(&result["task_id"]).delegation.unwrap().worktree_state == Some(WorktreeState::Removed)).then_some(())
    })
    .await;
    assert!(!dir.exists());
    assert!(!run_git(&t.fixture.root, &["branch", "--format=%(refname:short)"]).contains(&branch));
    // Following up with a child whose worktree is gone explains what to do.
    let error = t.fixture.orchestrator.send(child.id, UserMessage::text("one more thing")).await.unwrap_err();
    assert!(error.to_string().contains("worktree was removed") && error.to_string().contains("Delegate"), "{error}");
}

#[tokio::test]
async fn a_restart_interrupts_running_delegations_and_tells_the_parent() {
    let t = Delegating::new().await;
    let result = t.delegate(json!({"task": "long job"})).await;
    let child = t.delegation(&result["task_id"]);
    let agent = t.agent("long job").await;
    agent.finish("partial thought").await; // completes the turn quickly, so reopen it as running below
    eventually(|| async { (t.delegation(&result["task_id"]).delegation.unwrap().status == DelegationStatus::Completed).then_some(()) })
        .await;
    // Put the child back mid-turn, as a restart would find it.
    let mut stored = t.fixture.store.thread_get(child.id).unwrap().unwrap();
    stored.status = ThreadStatus::Running;
    let mut info = stored.delegation.clone().unwrap();
    info.status = DelegationStatus::Running;
    info.result = None;
    info.completed_at = None;
    stored.delegation = Some(info);
    t.fixture.store.thread_upsert(&stored).unwrap();
    t.end_parent_turn().await;
    // Drop whatever the first completion queued for the parent so only the recovery is observed.
    for queued in t.fixture.store.queue_list(Some(t.parent.id)).unwrap() {
        t.fixture.orchestrator.remove_queued(t.parent.id, queued.id).unwrap();
    }

    t.fixture.orchestrator.recover_after_restart().await.unwrap();

    let recovered = t.fixture.store.thread_get(child.id).unwrap().unwrap();
    assert_eq!(recovered.status, ThreadStatus::Idle, "interrupted threads go idle, not failed");
    let info = recovered.delegation.unwrap();
    assert_eq!((info.status, info.error.as_deref()), (DelegationStatus::Interrupted, Some("interrupted by a Kybern restart")));
    let events = t.fixture.store.events_for_thread(child.id).unwrap();
    assert!(events.iter().any(|event| matches!(event.payload, EventPayload::TurnCompleted { stop_reason: StopReason::Interrupted, .. })));
    assert!(events.iter().any(|event| matches!(&event.payload, EventPayload::ProviderNotice { text, .. } if text.contains("Kybern restarted while this turn was running"))));
    assert!(!events.iter().any(|event| matches!(event.payload, EventPayload::TurnFailed { .. })));
    let items = eventually(|| async { t.queued_results().into_iter().next() }).await;
    assert_eq!((items[0].status, items[0].error.as_deref()), (DelegationStatus::Interrupted, Some("interrupted by a Kybern restart")));
}

#[tokio::test]
async fn a_stale_thread_write_cannot_roll_a_delegation_back() {
    let t = Delegating::new().await;
    let result = t.delegate(json!({"task": "racy job"})).await;
    let stale = t.delegation(&result["task_id"]);
    t.agent("racy job").await.finish("done").await;
    eventually(|| async { (t.delegation(&result["task_id"]).delegation.unwrap().status == DelegationStatus::Completed).then_some(()) })
        .await;
    let mut rename = stale.clone();
    rename.title = "Renamed".into();
    t.fixture.orchestrator.update_thread(rename).unwrap();
    let after = t.delegation(&result["task_id"]);
    assert_eq!(after.title, "Renamed");
    assert_eq!(after.delegation.unwrap().status, DelegationStatus::Completed);
}

#[tokio::test]
async fn capabilities_report_harnesses_limits_and_counts() {
    let t = Delegating::new().await;
    t.delegate(json!({"task": "counted"})).await;
    let caps = t.tool("kybern_agent_capabilities", json!({})).await.unwrap();
    assert_eq!(caps["limits"]["max_active_children"], 4);
    assert_eq!(caps["limits"]["active_children"], 1);
    assert_eq!(caps["limits"]["caller_depth"], 0);
    assert_eq!(caps["limits"]["can_delegate"], true);
    let harnesses = caps["harnesses"].as_array().unwrap();
    let claude = harnesses.iter().find(|h| h["provider"] == "claude-code").expect("claude-code listed");
    assert_eq!(claude["supports_steer"], true);
    assert_eq!(harnesses.iter().find(|h| h["provider"] == "opencode").map_or(false, |h| h["supports_steer"] == true), false);
    assert_eq!(caps["you"]["provider"], "claude-code");
}

#[tokio::test]
async fn collaboration_tools_are_offered_only_to_coordinators_and_their_workers() {
    let (fixture, bridges) = capture_fixture(ProviderKind::ClaudeCode);
    let ordinary = fixture.thread_with_provider(ThreadStatus::Idle, ProviderKind::ClaudeCode);
    let live = fixture.orchestrator.spawn_session(&ordinary, None).await.unwrap();
    fixture.orchestrator.revoke_native_session(&live);
    let bridge = bridges.lock().unwrap().last().cloned().flatten().expect("bridge");
    for name in [
        "kybern_agent_capabilities",
        "kybern_agent_delegate",
        "kybern_agent_status",
        "kybern_agent_cancel",
        "kybern_agent_wait",
        "kybern_thread_interrupt",
        "kybern_thread_send",
        "kybern_thread_read",
    ] {
        assert!(bridge.has_tool(name), "an ordinary thread gets {name}");
    }
    for name in [
        "kybern_collaboration_spawn",
        "kybern_collaboration_send",
        "kybern_collaboration_read",
        "kybern_collaboration_wait",
        "kybern_collaboration_report",
        "kybern_collaboration_cancel",
        "kybern_collaboration_context_read",
        "kybern_collaboration_context_put",
    ] {
        assert!(!bridge.has_tool(name), "an ordinary thread must not see {name}");
    }

    let coordinator = fixture
        .orchestrator
        .project_coordinator_get_or_create(methods::CollaborationCoordinatorGetOrCreateParams {
            operation_id: Uuid::now_v7(),
            project_id: fixture.project.id,
            provider: ProviderInstance::default_for(ProviderKind::ClaudeCode),
            model: None,
            effort: None,
            permission_mode: Some(PermissionMode::Supervised),
            coordinator_mode: Some(CoordinatorMode::Ordinary),
            initial_goal: Some("Coordinate".into()),
        })
        .await
        .unwrap();
    let live = fixture.orchestrator.spawn_session(&coordinator.thread, None).await.unwrap();
    fixture.orchestrator.revoke_native_session(&live);
    let bridge = bridges.lock().unwrap().last().cloned().flatten().expect("bridge");
    assert!(bridge.has_tool("kybern_collaboration_spawn") && bridge.has_tool("kybern_agent_delegate"));

    // A worker in the coordinator's group sees them too; a member of an ordinary group does not.
    let worker = fixture.thread_with_provider(ThreadStatus::Idle, ProviderKind::ClaudeCode);
    fixture
        .store
        .collaboration_member_put(&GroupMember {
            group_id: coordinator.group.id,
            thread_id: worker.id,
            role: GroupMemberRole::Worker,
            active: true,
            joined_at: chrono::Utc::now(),
        })
        .unwrap();
    assert!(fixture.orchestrator.collaboration_tools_enabled(&worker).unwrap());
    assert!(fixture.orchestrator.collaboration_tools_enabled(&coordinator.thread).unwrap());
    let loner = fixture.thread_with_provider(ThreadStatus::Idle, ProviderKind::ClaudeCode);
    let ordinary_group = fixture
        .orchestrator
        .collaboration_group_create(methods::CollaborationGroupsCreateParams {
            operation_id: Uuid::now_v7(),
            project_id: loner.project_id,
            coordinator_thread_id: loner.id,
            objective: "Ad hoc".into(),
            success_criteria: vec![],
            coordinator_mode: Some(CoordinatorMode::Ordinary),
            policy: None,
        })
        .unwrap();
    assert!(fixture.store.collaboration_group_for_thread(loner.id).unwrap() == Some(ordinary_group.id));
    assert!(!fixture.orchestrator.collaboration_tools_enabled(&loner).unwrap());

    // Dispatch refuses them for an ordinary thread, with a pointer to the right tool.
    let (live, _) = fixture.active_app_tool_session(&ordinary).await;
    for name in ["kybern_collaboration_spawn", "kybern_collaboration_read", "kybern_collaboration_context_put"] {
        let error = fixture
            .orchestrator
            .execute_native_app_tool_call(ordinary.id, live.session_instance_id, "refused", name, json!({}))
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("only for project coordinators") && error.contains("kybern_agent_delegate"), "{name}: {error}");
    }
}

#[test]
fn delegation_tools_are_declared_and_bridge_sized() {
    let definitions = crate::app_tools::native_tool_definitions();
    for name in super::delegation::TOOL_NAMES {
        let tool = definitions.iter().find(|tool| tool.name == name).unwrap_or_else(|| panic!("{name} is declared"));
        assert!(tool.name.bytes().all(|byte| byte.is_ascii_lowercase() || byte == b'_'), "{name}");
    }
    let delegate = definitions.iter().find(|tool| tool.name == "kybern_agent_delegate").unwrap();
    for phrase in ["end your turn instead of polling", "delegate again with the full brief", "worktree", "shared"] {
        assert!(delegate.description.contains(phrase), "{phrase}");
    }
    assert!(delegate.input_schema["properties"].get("request_key").is_some(), "retryable like the other mutating tools");
    assert_eq!(delegate.input_schema["required"], json!(["task"]));
    assert!(definitions.len() + crate::computer::ComputerUse::tool_definitions().len() <= 64, "native bridges carry at most 64 tools");
    let source = include_str!("../../../kybern-drivers/src/pi/extension.ts");
    for name in super::delegation::TOOL_NAMES {
        assert!(source.contains(&format!("\"{name}\"")), "{name} must be allow-listed in extension.ts");
    }
}
