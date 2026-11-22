// Antigravity rules at every path that sets a thread's mode or provider, and its
// tool-free session. Included into `orchestrator::tests` for its fixture.

const ONLY_FULL_ACCESS: &str = "Antigravity only runs in Full access. Choose Full access, or pick another agent.";

fn antigravity_create(project: &Project, mode: Option<PermissionMode>) -> methods::ThreadsCreateParams {
    methods::ThreadsCreateParams {
        pin_account: false,
        project_id: Some(project.id),
        provider: ProviderInstance::default_for(ProviderKind::Antigravity),
        model: None,
        effort: None,
        permission_mode: mode,
        use_worktree: Some(false),
        base_branch: None,
        title: None,
        message: None,
        thread_id: None,
        message_id: None,
        members: None,
        base_branches: None,
    }
}

#[tokio::test]
async fn antigravity_threads_are_created_and_changed_only_in_full_access() {
    let fixture = Fixture::new();
    std::fs::create_dir_all(&fixture.root).unwrap();
    for mode in [PermissionMode::Supervised, PermissionMode::AcceptEdits, PermissionMode::Auto] {
        let error = fixture.orchestrator.create_thread(antigravity_create(&fixture.project, Some(mode))).await.unwrap_err();
        assert_eq!(error.to_string(), ONLY_FULL_ACCESS, "{mode:?}");
    }
    let thread = fixture.orchestrator.create_thread(antigravity_create(&fixture.project, Some(PermissionMode::FullAccess))).await.unwrap();
    assert_eq!((thread.provider.kind, thread.permission_mode), (ProviderKind::Antigravity, PermissionMode::FullAccess));

    // threads.update and the session-field path refuse every other mode and keep the thread as it was.
    for mode in [PermissionMode::Supervised, PermissionMode::AcceptEdits, PermissionMode::Auto] {
        let error = fixture.orchestrator.update_thread_fields(set_mode(&thread, mode)).unwrap_err();
        assert_eq!(error.to_string(), ONLY_FULL_ACCESS, "{mode:?}");
        let error = fixture.orchestrator.update_session_fields(set_mode(&thread, mode)).await.unwrap_err();
        assert_eq!(error.to_string(), ONLY_FULL_ACCESS, "{mode:?}");
    }
    assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().permission_mode, PermissionMode::FullAccess);
    fixture.orchestrator.update_thread_fields(set_mode(&thread, PermissionMode::FullAccess)).unwrap();
}

#[tokio::test]
async fn switching_a_thread_to_antigravity_never_grants_it_full_access() {
    let fixture = Fixture::new();
    let thread = fixture.thread(ThreadStatus::Idle);
    assert_eq!(thread.permission_mode, PermissionMode::Supervised);
    let target = SessionTarget { provider: ProviderInstance::default_for(ProviderKind::Antigravity), model: None, effort: None };
    // Selecting a target only records the choice; the next message is admitted against the thread's mode.
    let mut thread = thread;
    let error = fixture.orchestrator.admit_target(&mut thread, target.clone()).unwrap_err();
    assert_eq!(error.to_string(), ONLY_FULL_ACCESS);
    assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().provider.kind, ProviderKind::ClaudeCode);
    // The queue and steer admission use the same check.
    let mut receiving = thread.clone();
    receiving.provider = target.provider.clone();
    assert_eq!(super::accounts::validate_permission(&receiving, PermissionMode::Supervised).unwrap_err().to_string(), ONLY_FULL_ACCESS);
    super::accounts::validate_permission(&receiving, PermissionMode::FullAccess).unwrap();
    // Full access first, then the switch is admitted.
    thread.permission_mode = PermissionMode::FullAccess;
    fixture.orchestrator.admit_target(&mut thread, target).unwrap();
    assert_eq!(thread.provider.kind, ProviderKind::Antigravity);
}

#[test]
fn delegation_to_antigravity_needs_a_full_access_parent_and_never_narrows() {
    use super::antigravity_rules::require_full_access;
    let child = |parent: PermissionMode, requested: Option<PermissionMode>| {
        let mode = super::delegation::resolve_child_permission(parent, ProviderKind::ClaudeCode, ProviderKind::Antigravity, requested)?;
        require_full_access(ProviderKind::Antigravity, mode).map(|()| mode)
    };
    assert_eq!(child(PermissionMode::FullAccess, None).unwrap(), PermissionMode::FullAccess);
    for parent in [PermissionMode::Supervised, PermissionMode::AcceptEdits, PermissionMode::Auto] {
        assert_eq!(child(parent, None).unwrap_err().to_string(), ONLY_FULL_ACCESS, "{parent:?}");
    }
    // A Full access parent that asks for a stricter child is refused, not widened.
    assert_eq!(child(PermissionMode::FullAccess, Some(PermissionMode::Supervised)).unwrap_err().to_string(), ONLY_FULL_ACCESS);
}

#[tokio::test]
async fn antigravity_cannot_lead_a_project() {
    let fixture = Fixture::new();
    std::fs::create_dir_all(&fixture.root).unwrap();
    let lead_error = "Antigravity can't lead a project: Kybern can't limit its tools. Choose Claude Code or Codex for the lead.";
    let error = fixture.orchestrator.coordinator_open(open_params(&fixture.project, ProviderKind::Antigravity, None)).await.unwrap_err();
    assert_eq!(error.to_string(), lead_error);
    assert!(fixture.orchestrator.coordinator_get(fixture.project.id).unwrap().is_none());
    // Switching an existing Coordinator's harness to Antigravity is refused too.
    fixture.orchestrator.coordinator_open(open_params(&fixture.project, ProviderKind::ClaudeCode, None)).await.unwrap();
    let error = fixture
        .orchestrator
        .coordinator_switch_harness(CoordinatorSwitchHarnessParams {
            project_id: fixture.project.id,
            provider: ProviderInstance::default_for(ProviderKind::Antigravity),
            model: None,
            effort: None,
            permission_mode: Some(PermissionMode::FullAccess),
        })
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), lead_error);
    // And a Coordinator thread itself cannot be rewritten onto Antigravity.
    let mut lead = fixture.orchestrator.coordinator_get(fixture.project.id).unwrap().unwrap();
    lead.provider = ProviderInstance::default_for(ProviderKind::Antigravity);
    lead.permission_mode = PermissionMode::FullAccess;
    assert_eq!(fixture.orchestrator.update_thread(lead).unwrap_err().to_string(), lead_error);
}

/// `agy` has no per-session MCP configuration, so its session gets a bridge with
/// no tools and no endpoint, and a guide that describes none.
#[tokio::test]
async fn antigravity_sessions_get_a_tool_free_guide_and_no_gateway_session() {
    let bridges = Arc::new(std::sync::Mutex::new(Vec::new()));
    let mut drivers = DriverRegistry::default();
    drivers.register(Arc::new(BridgeCapture { kind: ProviderKind::Antigravity, bridges: bridges.clone() }));
    let fixture = Fixture::with_drivers_and_gateway(drivers, Some(crate::native_tools_mcp::NativeToolsGateway::default()));
    std::fs::create_dir_all(&fixture.root).unwrap();
    let mut thread = fixture.thread_with_provider(ThreadStatus::Idle, ProviderKind::Antigravity);
    thread.permission_mode = PermissionMode::FullAccess;
    thread.provider_session_id = None;
    fixture.store.thread_upsert(&thread).unwrap();
    let bridge = spawn_bridge(&fixture, &bridges, &thread).await;
    assert!(bridge.tools.is_empty() && bridge.endpoint.is_none() && bridge.authorization.is_none());
    let guide = bridge.guide.clone().expect("the guide is on by default");
    assert!(guide.starts_with("# Working in Kybern"));
    assert!(!guide.contains("kybern_"), "the guide advertises no tool: {guide}");
    assert_eq!(bridge.provider_instructions().as_deref(), Some(guide.as_str()));
    assert!(bridge.validate().is_ok());

    // With "Tell agents about Kybern" off, nothing is sent.
    let mut settings = fixture.orchestrator.inner.settings.get();
    settings.tell_agents_about_kybern = false;
    fixture.orchestrator.inner.settings.set(settings).unwrap();
    let mut second = fixture.thread_with_provider(ThreadStatus::Idle, ProviderKind::Antigravity);
    second.permission_mode = PermissionMode::FullAccess;
    second.provider_session_id = None;
    fixture.store.thread_upsert(&second).unwrap();
    fixture.orchestrator.spawn_session(&second, None).await.unwrap();
    assert!(bridges.lock().unwrap().last().unwrap().is_none());
}

#[test]
fn antigravity_has_one_account_per_machine() {
    let mut provider = ProviderSettings::default();
    provider.accounts.insert("second".into(), ProviderAccount { name: "Second".into(), directory: std::env::temp_dir().join("second").to_string_lossy().into_owned(), ..Default::default() });
    let error = crate::provider_accounts::environment(&provider, ProviderKind::Antigravity, "second").unwrap_err();
    assert!(error.to_string().contains("one account per machine"), "{error}");
    // The default account is the machine's own login, with the key variable it may carry.
    provider.env.insert("GEMINI_API_KEY".into(), "key".into());
    assert_eq!(crate::provider_accounts::environment(&provider, ProviderKind::Antigravity, "default").unwrap()["GEMINI_API_KEY"], "key");
    assert_eq!(crate::provider_accounts::credential_keys(ProviderKind::Antigravity), ["GEMINI_API_KEY"]);
    let mut settings = Settings::default();
    settings.providers.insert(ProviderKind::Antigravity, provider);
    assert!(crate::provider_accounts::validate(&settings).is_err(), "a named Antigravity account can't be saved");
}

type RecordedSends = Arc<std::sync::Mutex<Vec<(Option<String>, String)>>>;

#[derive(Clone)]
struct AgyRecord {
    resume_session_id: Option<String>,
    /// `(conversation_used_for_send, plain_text_prompt)` for every `send_message` on this session.
    sends: RecordedSends,
}

impl AgyRecord {
    fn messages(&self) -> Vec<String> {
        self.sends.lock().unwrap().iter().map(|(_, text)| text.clone()).collect()
    }
}

#[derive(Clone)]
struct Barrier {
    entered: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
}

impl Barrier {
    fn new() -> Self {
        Self { entered: Arc::new(tokio::sync::Notify::new()), release: Arc::new(tokio::sync::Notify::new()) }
    }
}

enum ScriptStep {
    Events(Vec<DriverEvent>),
    SendError(String),
}

struct ScriptedAgyDriver {
    kind: ProviderKind,
    supports_fork: bool,
    spawns: Arc<std::sync::Mutex<Vec<AgyRecord>>>,
    scripts: Arc<std::sync::Mutex<std::collections::VecDeque<ScriptStep>>>,
    /// Optional barrier triggered on `close()` of the Nth (0-indexed) spawned session.
    close_barriers: Arc<std::sync::Mutex<HashMap<usize, Barrier>>>,
    /// Optional barrier triggered on `spawn()` of the Nth (0-indexed) spawned session.
    spawn_barriers: Arc<std::sync::Mutex<HashMap<usize, Barrier>>>,
    /// Notified whenever `send_message` is invoked on any spawned session.
    send_notify: Arc<tokio::sync::Notify>,
}

impl ScriptedAgyDriver {
    fn antigravity(scripts: Vec<Vec<DriverEvent>>) -> Self {
        Self::new(ProviderKind::Antigravity, false, scripts.into_iter().map(ScriptStep::Events).collect())
    }

    fn new(kind: ProviderKind, supports_fork: bool, scripts: Vec<ScriptStep>) -> Self {
        Self {
            kind,
            supports_fork,
            spawns: Arc::new(std::sync::Mutex::new(Vec::new())),
            scripts: Arc::new(std::sync::Mutex::new(scripts.into())),
            close_barriers: Arc::new(std::sync::Mutex::new(HashMap::new())),
            spawn_barriers: Arc::new(std::sync::Mutex::new(HashMap::new())),
            send_notify: Arc::new(tokio::sync::Notify::new()),
        }
    }

    fn pause_close(&self, spawn_index: usize) -> Barrier {
        let barrier = Barrier::new();
        self.close_barriers.lock().unwrap().insert(spawn_index, barrier.clone());
        barrier
    }

    fn pause_spawn(&self, spawn_index: usize) -> Barrier {
        let barrier = Barrier::new();
        self.spawn_barriers.lock().unwrap().insert(spawn_index, barrier.clone());
        barrier
    }
}

struct ScriptedAgySession {
    kind: ProviderKind,
    /// Models Antigravity's `State.conversation`, which drops to `None` on a thinking-signature error.
    conversation: Arc<std::sync::Mutex<Option<String>>>,
    sends: RecordedSends,
    tx: tokio::sync::mpsc::Sender<DriverEvent>,
    scripts: Arc<std::sync::Mutex<std::collections::VecDeque<ScriptStep>>>,
    close_barrier: Option<Barrier>,
    send_notify: Arc<tokio::sync::Notify>,
}

#[async_trait::async_trait]
impl kybern_drivers::AgentSession for ScriptedAgySession {
    async fn send_message(&self, _id: &str, message: &UserMessage) -> kybern_drivers::Result<()> {
        let used_conversation = self.conversation.lock().unwrap().clone();
        self.sends.lock().unwrap().push((used_conversation, message.plain_text()));
        self.send_notify.notify_waiters();
        let step = self.scripts.lock().unwrap().pop_front().unwrap_or(ScriptStep::Events(Vec::new()));
        match step {
            ScriptStep::SendError(text) => Err(kybern_drivers::DriverError::Protocol(text)),
            ScriptStep::Events(batch) => {
                let tx = self.tx.clone();
                let conversation = self.conversation.clone();
                let kind = self.kind;
                tokio::spawn(async move {
                    for event in batch {
                        match &event {
                            DriverEvent::SessionBound { session_id, .. } => {
                                *conversation.lock().unwrap() = Some(session_id.clone());
                            }
                            DriverEvent::TurnFailed { error, problem } if kind == ProviderKind::Antigravity => {
                                let poisoned = problem
                                    .as_ref()
                                    .and_then(|p| p.detail.as_deref())
                                    .is_some_and(kybern_drivers::antigravity::is_invalid_thinking_signature)
                                    || kybern_drivers::antigravity::is_invalid_thinking_signature(error);
                                if poisoned {
                                    // Models `antigravity.rs`: the driver clears `state.conversation`
                                    // before delivering `TurnFailed`.
                                    *conversation.lock().unwrap() = None;
                                }
                            }
                            _ => {}
                        }
                        let _ = tx.send(event).await;
                    }
                });
                Ok(())
            }
        }
    }
    async fn interrupt(&self) -> kybern_drivers::Result<()> {
        Ok(())
    }
    async fn set_permission_mode(&self, _: PermissionMode) -> kybern_drivers::Result<()> {
        Ok(())
    }
    async fn set_model(&self, _: &str) -> kybern_drivers::Result<()> {
        Ok(())
    }
    async fn set_effort(&self, _: &str) -> kybern_drivers::Result<()> {
        Ok(())
    }
    async fn respond_permission(&self, _: &str, _: &ApprovalDecision) -> kybern_drivers::Result<()> {
        Ok(())
    }
    async fn close(&self) -> kybern_drivers::Result<()> {
        if let Some(barrier) = &self.close_barrier {
            barrier.entered.notify_one();
            barrier.release.notified().await;
        }
        let _ = self.tx.send(DriverEvent::Exited { code: Some(0), error: None }).await;
        Ok(())
    }
}

#[async_trait::async_trait]
impl kybern_drivers::AgentDriver for ScriptedAgyDriver {
    fn kind(&self) -> ProviderKind {
        self.kind
    }
    fn supports_fork(&self) -> bool {
        self.supports_fork
    }
    async fn probe(&self, _: Option<&std::path::PathBuf>) -> ProviderStatus {
        ProviderStatus {
            kind: self.kind,
            display_name: self.kind.display_name().into(),
            available: true,
            binary_path: None,
            version: Some("1.5.14".into()),
            unavailable_reason: None,
            supported_permission_modes: if self.kind == ProviderKind::Antigravity {
                vec![PermissionMode::FullAccess]
            } else {
                PermissionMode::ALL.to_vec()
            },
            supports_fork: self.supports_fork,
            supports_model_switch: true,
            supports_effort_switch: true,
            supported_efforts: vec![],
            models: vec![],
            instances: vec!["default".into()],
        }
    }
    async fn spawn(&self, config: kybern_drivers::SessionConfig) -> kybern_drivers::Result<kybern_drivers::SpawnedSession> {
        let spawn_index = self.spawns.lock().unwrap().len();
        let spawn_barrier = self.spawn_barriers.lock().unwrap().remove(&spawn_index);
        if let Some(barrier) = spawn_barrier {
            barrier.entered.notify_one();
            barrier.release.notified().await;
        }
        let (tx, events) = tokio::sync::mpsc::channel(64);
        let sends = Arc::new(std::sync::Mutex::new(Vec::new()));
        let conversation = Arc::new(std::sync::Mutex::new(config.resume_session_id.clone()));
        let close_barrier = self.close_barriers.lock().unwrap().remove(&spawn_index);
        self.spawns.lock().unwrap().push(AgyRecord {
            resume_session_id: config.resume_session_id,
            sends: sends.clone(),
        });
        Ok(kybern_drivers::SpawnedSession {
            session: Box::new(ScriptedAgySession {
                kind: self.kind,
                conversation,
                sends,
                tx,
                scripts: self.scripts.clone(),
                close_barrier,
                send_notify: self.send_notify.clone(),
            }),
            events,
        })
    }
}

async fn wait_for_thread_event(
    events: &mut crate::bounded_broadcast::Receiver<ThreadEvent>,
    thread_id: ThreadId,
    mut predicate: impl FnMut(&ThreadEvent) -> bool,
) -> ThreadEvent {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match events.recv().await {
                Ok(event) if event.thread_id == thread_id && predicate(&event) => return event,
                Ok(_) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => panic!("orchestrator event bus closed"),
            }
        }
    })
    .await
    .expect("timed out waiting for thread event")
}

async fn wait_for_thread_status(
    events: &mut crate::bounded_broadcast::Receiver<ThreadEvent>,
    thread_id: ThreadId,
    expected: ThreadStatus,
) -> Thread {
    let event = wait_for_thread_event(events, thread_id, |event| {
        matches!(&event.payload, EventPayload::ThreadUpdated { thread } if thread.status == expected)
    })
    .await;
    match event.payload {
        EventPayload::ThreadUpdated { thread } => thread,
        _ => unreachable!(),
    }
}

async fn wait_for_turn_settled(
    events: &mut crate::bounded_broadcast::Receiver<ThreadEvent>,
    thread_id: ThreadId,
    turn_id: TurnId,
    expected: ThreadStatus,
) -> Thread {
    wait_for_thread_event(events, thread_id, |event| {
        event.turn_id == Some(turn_id)
            && matches!(event.payload, EventPayload::TurnCompleted { .. } | EventPayload::TurnFailed { .. })
    })
    .await;
    wait_for_thread_status(events, thread_id, expected).await
}

async fn wait_for_after_checkpoint(fixture: &Fixture, thread_id: ThreadId, turn_id: TurnId) {
    // `checkpoint_after_turn` acquires `checkpoint_lock` before `TurnCompleted` / `ThreadUpdated`,
    // so acquiring and dropping the lock waits directly for the background snapshot to finish.
    drop(fixture.orchestrator.checkpoint_lock(thread_id).lock_owned().await);
    assert!(
        fixture.store.checkpoint_get(turn_id).unwrap().is_some_and(|c| c.after.is_some()),
        "checkpoint after snapshot recorded for {turn_id}"
    );
}

#[tokio::test]
async fn antigravity_thinking_signature_failure_retries_once_on_a_fresh_conversation_with_context() {
    let raw_sig_err = r#"Error 400, Message: {"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0.thinking.signature: Field required"}}, Status: INVALID_ARGUMENT"#;
    let sig_problem = kybern_protocol::rpc::Problem::new(kybern_protocol::rpc::ProblemKind::Internal, raw_sig_err)
        .with_subject("antigravity");

    let driver = Arc::new(ScriptedAgyDriver::antigravity(vec![
        // Turn 1 succeeds and binds the conversation id.
        vec![
            DriverEvent::SessionBound { session_id: "conv-poisoned".into(), model: None },
            DriverEvent::MessageCompleted {
                message_id: "m1".into(),
                origin: EventOrigin::Root,
                text: "earlier answer".into(),
                thinking: None,
            },
            completed_response(StopReason::Completed),
        ],
        // Turn 2 fails on the poisoned conversation with a missing thinking signature.
        vec![DriverEvent::TurnFailed {
            error: "Antigravity's saved conversation can no longer be sent to the model.".into(),
            problem: Some(sig_problem.clone()),
        }],
        // Automatic retry on a fresh conversation succeeds.
        vec![
            DriverEvent::SessionBound { session_id: "conv-fresh".into(), model: None },
            DriverEvent::MessageCompleted {
                message_id: "m2".into(),
                origin: EventOrigin::Root,
                text: "recovered answer".into(),
                thinking: None,
            },
            completed_response(StopReason::Completed),
        ],
        // Turn 3 fails twice in a row: must stop after one retry instead of looping.
        vec![DriverEvent::TurnFailed { error: raw_sig_err.into(), problem: Some(sig_problem.clone()) }],
        vec![
            DriverEvent::SessionBound { session_id: "conv-also-bad".into(), model: None },
            DriverEvent::TurnFailed { error: raw_sig_err.into(), problem: Some(sig_problem) },
        ],
        // Turn 4 (after daemon declined a second automatic retry): the driver dropped its
        // conversation id, and the daemon preserved a portable handoff so Turn 4 keeps context.
        vec![
            DriverEvent::SessionBound { session_id: "conv-after-decline".into(), model: None },
            DriverEvent::MessageCompleted {
                message_id: "m4".into(),
                origin: EventOrigin::Root,
                text: "kept context answer".into(),
                thinking: None,
            },
            completed_response(StopReason::Completed),
        ],
    ]));

    let mut drivers = DriverRegistry::default();
    drivers.register(driver.clone());
    let fixture = Fixture::with_drivers_and_gateway(drivers, None);
    std::fs::create_dir_all(&fixture.root).unwrap();
    let mut thread = fixture.thread_with_provider(ThreadStatus::Idle, ProviderKind::Antigravity);
    thread.permission_mode = PermissionMode::FullAccess;
    thread.provider_session_id = None;
    fixture.store.thread_upsert(&thread).unwrap();

    let mut events = fixture.orchestrator.inner.events.subscribe();

    // Turn 1 establishes the conversation.
    fixture.orchestrator.send(thread.id, UserMessage::text("earlier question")).await.unwrap();
    let after_t1 = wait_for_thread_status(&mut events, thread.id, ThreadStatus::Idle).await;
    assert_eq!(after_t1.provider_session_id.as_deref(), Some("conv-poisoned"));

    // Turn 2 hits the thinking-signature error and recovers automatically on a fresh conversation.
    fixture.orchestrator.send(thread.id, UserMessage::text("follow-up question")).await.unwrap();
    let after_t2 = wait_for_thread_event(&mut events, thread.id, |event| {
        matches!(
            &event.payload,
            EventPayload::ThreadUpdated { thread }
                if thread.status == ThreadStatus::Idle && thread.provider_session_id.as_deref() == Some("conv-fresh")
        )
    })
    .await;
    assert!(matches!(after_t2.payload, EventPayload::ThreadUpdated { .. }));

    let spawns = driver.spawns.lock().unwrap().clone();
    assert_eq!(spawns.len(), 2, "second spawn was a fresh conversation");
    assert_eq!(spawns[1].resume_session_id, None, "poisoned conversation id must be dropped");
    let retried_prompt = spawns[1].messages()[0].clone();
    assert!(retried_prompt.contains("earlier question"), "missing prior user turn: {retried_prompt}");
    assert!(retried_prompt.contains("earlier answer"), "missing prior assistant turn: {retried_prompt}");
    assert_eq!(
        retried_prompt.matches("follow-up question").count(),
        1,
        "failed turn's own prompt must appear exactly once in the seed: {retried_prompt}"
    );

    // Turn 3 fails twice: only one automatic retry occurs, then the turn fails cleanly.
    fixture.orchestrator.send(thread.id, UserMessage::text("third question")).await.unwrap();
    let after_t3 = wait_for_thread_status(&mut events, thread.id, ThreadStatus::Failed).await;
    assert_eq!(driver.spawns.lock().unwrap().len(), 3, "only one retry spawn for the double failure");
    assert_eq!(after_t3.provider_session_id, None, "declined recovery must still clear provider_session_id");
    assert!(
        fixture.store.meta_get(&format!("handoff:{}", thread.id)).unwrap().is_some_and(|v| !v.is_empty()),
        "declined recovery must keep a portable handoff for the next message"
    );

    // Turn 4 runs on the existing session (whose driver dropped `state.conversation` to `None`)
    // and receives the portable handoff so earlier turns are not silently lost.
    fixture.orchestrator.send(thread.id, UserMessage::text("fourth question")).await.unwrap();
    let after_t4 = wait_for_thread_status(&mut events, thread.id, ThreadStatus::Idle).await;
    assert_eq!(after_t4.provider_session_id.as_deref(), Some("conv-after-decline"));
    let spawns = driver.spawns.lock().unwrap().clone();
    let sends_on_session = spawns[2].sends.lock().unwrap().clone();
    let (used_conv, fourth_prompt) = sends_on_session.last().unwrap();
    assert_eq!(*used_conv, None, "driver started a fresh conversation after dropping poisoned id");
    assert!(fourth_prompt.contains("earlier question") && fourth_prompt.contains("earlier answer"), "{fourth_prompt}");
    assert!(fourth_prompt.contains("follow-up question") && fourth_prompt.contains("recovered answer"), "{fourth_prompt}");
    assert!(fourth_prompt.contains("fourth question"), "{fourth_prompt}");
}

#[tokio::test]
async fn antigravity_declined_recovery_when_session_is_released_preserves_handoff() {
    let raw_sig_err = r#"Error 400, Message: {"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0.thinking.signature: Field required"}}, Status: INVALID_ARGUMENT"#;
    let sig_problem = kybern_protocol::rpc::Problem::new(kybern_protocol::rpc::ProblemKind::Internal, raw_sig_err)
        .with_subject("antigravity");

    let driver = Arc::new(ScriptedAgyDriver::antigravity(vec![
        // Turn 1 succeeds and binds `conv-1`.
        vec![
            DriverEvent::SessionBound { session_id: "conv-1".into(), model: None },
            DriverEvent::MessageCompleted {
                message_id: "m1".into(),
                origin: EventOrigin::Root,
                text: "saved answer".into(),
                thinking: None,
            },
            completed_response(StopReason::Completed),
        ],
        // Turn 2: does not emit yet; we mark `live` released and inject `TurnFailed` directly.
        vec![],
        // Turn 3 after decline must start fresh with Turn 1's context.
        vec![
            DriverEvent::SessionBound { session_id: "conv-2".into(), model: None },
            DriverEvent::MessageCompleted {
                message_id: "m3".into(),
                origin: EventOrigin::Root,
                text: "after release".into(),
                thinking: None,
            },
            completed_response(StopReason::Completed),
        ],
    ]));

    let mut drivers = DriverRegistry::default();
    drivers.register(driver.clone());
    let fixture = Fixture::with_drivers_and_gateway(drivers, None);
    std::fs::create_dir_all(&fixture.root).unwrap();
    let mut thread = fixture.thread_with_provider(ThreadStatus::Idle, ProviderKind::Antigravity);
    thread.permission_mode = PermissionMode::FullAccess;
    thread.provider_session_id = None;
    fixture.store.thread_upsert(&thread).unwrap();

    let mut events = fixture.orchestrator.inner.events.subscribe();

    let (t1, _) = fixture.orchestrator.send(thread.id, UserMessage::text("saved question")).await.unwrap();
    wait_for_turn_settled(&mut events, thread.id, t1, ThreadStatus::Idle).await;

    let sent_turn2 = driver.send_notify.notified();
    fixture.orchestrator.send(thread.id, UserMessage::text("turn on released session")).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), sent_turn2).await.expect("turn 2 started and sent to session");
    let live = fixture.orchestrator.inner.sessions.lock().await.get(&thread.id).cloned().unwrap();
    live.mark_released();
    fixture
        .orchestrator
        .process_driver_event(
            thread.id,
            &live,
            DriverEvent::TurnFailed { error: raw_sig_err.into(), problem: Some(sig_problem) },
            false,
        )
        .await
        .unwrap();

    // Recovery was declined (still only 1 spawn), yet provider_session_id was cleared and handoff set.
    assert_eq!(driver.spawns.lock().unwrap().len(), 1);
    assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().provider_session_id, None);
    assert!(fixture.store.meta_get(&format!("handoff:{}", thread.id)).unwrap().is_some_and(|v| !v.is_empty()));

    // Remove the released session as session retirement would, then send Turn 3.
    fixture.orchestrator.inner.sessions.lock().await.remove(&thread.id);
    let (t3, _) = fixture.orchestrator.send(thread.id, UserMessage::text("next prompt")).await.unwrap();
    wait_for_turn_settled(&mut events, thread.id, t3, ThreadStatus::Idle).await;
    let spawns = driver.spawns.lock().unwrap().clone();
    assert_eq!(spawns.len(), 2);
    assert_eq!(spawns[1].resume_session_id, None);
    let seeded = spawns[1].messages()[0].clone();
    assert!(seeded.contains("saved question") && seeded.contains("saved answer"), "{seeded}");
    assert!(seeded.contains("next prompt"), "{seeded}");
}

#[tokio::test]
async fn stop_during_antigravity_thinking_signature_retry_cancels_resend() {
    let raw_sig_err = r#"Error 400, Message: {"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0.thinking.signature: Field required"}}, Status: INVALID_ARGUMENT"#;
    let sig_problem = kybern_protocol::rpc::Problem::new(kybern_protocol::rpc::ProblemKind::Internal, raw_sig_err)
        .with_subject("antigravity");

    // Window 1: Stop arrives while closing the poisoned session (removed from `sessions`, before `start_turn_erased`).
    {
        let driver = Arc::new(ScriptedAgyDriver::antigravity(vec![
            vec![
                DriverEvent::SessionBound { session_id: "conv-poisoned".into(), model: None },
                DriverEvent::MessageCompleted {
                    message_id: "m1".into(),
                    origin: EventOrigin::Root,
                    text: "ok".into(),
                    thinking: None,
                },
                completed_response(StopReason::Completed),
            ],
            vec![DriverEvent::TurnFailed { error: raw_sig_err.into(), problem: Some(sig_problem.clone()) }],
        ]));
        let close_barrier = driver.pause_close(0);

        let mut drivers = DriverRegistry::default();
        drivers.register(driver.clone());
        let fixture = Fixture::with_drivers_and_gateway(drivers, None);
        std::fs::create_dir_all(&fixture.root).unwrap();
        let mut thread = fixture.thread_with_provider(ThreadStatus::Idle, ProviderKind::Antigravity);
        thread.permission_mode = PermissionMode::FullAccess;
        thread.provider_session_id = None;
        fixture.store.thread_upsert(&thread).unwrap();

        let mut events = fixture.orchestrator.inner.events.subscribe();
        fixture.orchestrator.send(thread.id, UserMessage::text("turn 1")).await.unwrap();
        wait_for_thread_status(&mut events, thread.id, ThreadStatus::Idle).await;

        fixture.orchestrator.send(thread.id, UserMessage::text("turn 2")).await.unwrap();
        tokio::time::timeout(Duration::from_secs(10), close_barrier.entered.notified()).await.expect("recovery entered close()");
        // The poisoned session is already removed from `sessions`; Stop must still succeed cleanly.
        assert!(fixture.orchestrator.inner.sessions.lock().await.get(&thread.id).is_none());

        let stopped_notify = fixture
            .orchestrator
            .inner
            .antigravity_recoveries
            .lock()
            .unwrap()
            .get(&thread.id)
            .expect("recovery entry registered")
            .stopped_notify
            .clone();
        let stopped_wait = stopped_notify.notified();
        let orch = fixture.orchestrator.clone();
        let stop_task = tokio::spawn(async move { orch.stop_thread(thread.id, "test stop during close").await });
        tokio::time::timeout(Duration::from_secs(10), stopped_wait).await.expect("stop registered on recovery");
        close_barrier.release.notify_one();
        stop_task.await.unwrap().expect("Stop during retry close must not fail with no live session");

        let ended = wait_for_thread_event(&mut events, thread.id, |event| {
            matches!(event.payload, EventPayload::TurnCompleted { stop_reason: StopReason::Interrupted, .. })
        })
        .await;
        assert!(matches!(ended.payload, EventPayload::TurnCompleted { stop_reason: StopReason::Interrupted, .. }));
        assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().status, ThreadStatus::Idle);
        assert_eq!(driver.spawns.lock().unwrap().len(), 1, "stopped retry must not spawn a fresh session");
    }

    // Window 2: Stop arrives during `ensure_session` (before `ActiveTurn` exists or `send_message` runs).
    {
        let driver = Arc::new(ScriptedAgyDriver::antigravity(vec![
            vec![
                DriverEvent::SessionBound { session_id: "conv-poisoned".into(), model: None },
                DriverEvent::MessageCompleted {
                    message_id: "m1".into(),
                    origin: EventOrigin::Root,
                    text: "ok".into(),
                    thinking: None,
                },
                completed_response(StopReason::Completed),
            ],
            vec![DriverEvent::TurnFailed { error: raw_sig_err.into(), problem: Some(sig_problem) }],
        ]));
        let spawn_barrier = driver.pause_spawn(1);

        let mut drivers = DriverRegistry::default();
        drivers.register(driver.clone());
        let fixture = Fixture::with_drivers_and_gateway(drivers, None);
        std::fs::create_dir_all(&fixture.root).unwrap();
        let mut thread = fixture.thread_with_provider(ThreadStatus::Idle, ProviderKind::Antigravity);
        thread.permission_mode = PermissionMode::FullAccess;
        thread.provider_session_id = None;
        fixture.store.thread_upsert(&thread).unwrap();

        let mut events = fixture.orchestrator.inner.events.subscribe();
        fixture.orchestrator.send(thread.id, UserMessage::text("turn 1")).await.unwrap();
        wait_for_thread_status(&mut events, thread.id, ThreadStatus::Idle).await;

        fixture.orchestrator.send(thread.id, UserMessage::text("turn 2")).await.unwrap();
        tokio::time::timeout(Duration::from_secs(10), spawn_barrier.entered.notified()).await.expect("recovery entered second spawn()");

        let stopped_notify = fixture
            .orchestrator
            .inner
            .antigravity_recoveries
            .lock()
            .unwrap()
            .get(&thread.id)
            .expect("recovery entry registered")
            .stopped_notify
            .clone();
        let stopped_wait = stopped_notify.notified();
        let orch = fixture.orchestrator.clone();
        let stop_task = tokio::spawn(async move { orch.stop_thread(thread.id, "test stop during spawn").await });
        tokio::time::timeout(Duration::from_secs(10), stopped_wait).await.expect("stop registered during ensure_session");
        spawn_barrier.release.notify_one();
        stop_task.await.unwrap().expect("Stop during ensure_session must succeed");

        wait_for_thread_event(&mut events, thread.id, |event| {
            matches!(event.payload, EventPayload::TurnCompleted { stop_reason: StopReason::Interrupted, .. })
        })
        .await;
        assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().status, ThreadStatus::Idle);
        let spawns = driver.spawns.lock().unwrap().clone();
        assert_eq!(spawns.len(), 2);
        assert!(spawns[1].messages().is_empty(), "stopped retry must not resend after ensure_session");
    }
}

#[tokio::test]
async fn edit_from_here_after_failed_harness_switch_preserves_handoff_for_non_antigravity() {
    let claude = Arc::new(ScriptedAgyDriver::new(
        ProviderKind::ClaudeCode,
        true,
        vec![
            ScriptStep::Events(vec![
                DriverEvent::SessionBound { session_id: "claude-1".into(), model: None },
                DriverEvent::MessageCompleted {
                    message_id: "c1".into(),
                    origin: EventOrigin::Root,
                    text: "claude answer one".into(),
                    thinking: None,
                },
                completed_response(StopReason::Completed),
            ]),
            ScriptStep::Events(vec![
                DriverEvent::MessageCompleted {
                    message_id: "c2".into(),
                    origin: EventOrigin::Root,
                    text: "claude answer two".into(),
                    thinking: None,
                },
                completed_response(StopReason::Completed),
            ]),
        ],
    ));
    let codex = Arc::new(ScriptedAgyDriver::new(
        ProviderKind::Codex,
        true,
        vec![
            // First send after switching to Codex fails before binding a session id, leaving the
            // handoff pending and `provider_session_id = None`.
            ScriptStep::SendError("temporary codex failure".into()),
            // Edited resend after "Edit from here" on turn 3 succeeds.
            ScriptStep::Events(vec![
                DriverEvent::SessionBound { session_id: "codex-1".into(), model: None },
                DriverEvent::MessageCompleted {
                    message_id: "x3".into(),
                    origin: EventOrigin::Root,
                    text: "codex answer".into(),
                    thinking: None,
                },
                completed_response(StopReason::Completed),
            ]),
            // After rewinding to turn 1 (`idx == 0`), a fresh send carries no prior context.
            ScriptStep::Events(vec![
                DriverEvent::SessionBound { session_id: "codex-2".into(), model: None },
                DriverEvent::MessageCompleted {
                    message_id: "x1".into(),
                    origin: EventOrigin::Root,
                    text: "fresh start".into(),
                    thinking: None,
                },
                completed_response(StopReason::Completed),
            ]),
        ],
    ));

    let mut drivers = DriverRegistry::default();
    drivers.register(claude.clone());
    drivers.register(codex.clone());
    let fixture = Fixture::with_drivers_and_gateway(drivers, None);
    std::fs::create_dir_all(&fixture.root).unwrap();
    let git = |args: &[&str]| {
        assert!(std::process::Command::new("git").arg("-C").arg(&fixture.root).args(args).status().unwrap().success());
    };
    git(&["init", "-q"]);
    git(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);

    let mut thread = fixture.thread_with_provider(ThreadStatus::Idle, ProviderKind::ClaudeCode);
    thread.provider_session_id = None;
    fixture.store.thread_upsert(&thread).unwrap();

    let mut events = fixture.orchestrator.inner.events.subscribe();

    // Turns 1 and 2 on Claude Code.
    let (t1, _) = fixture.orchestrator.send(thread.id, UserMessage::text("first claude prompt")).await.unwrap();
    wait_for_turn_settled(&mut events, thread.id, t1, ThreadStatus::Idle).await;
    wait_for_after_checkpoint(&fixture, thread.id, t1).await;

    let (t2, _) = fixture.orchestrator.send(thread.id, UserMessage::text("second claude prompt")).await.unwrap();
    wait_for_turn_settled(&mut events, thread.id, t2, ThreadStatus::Idle).await;
    wait_for_after_checkpoint(&fixture, thread.id, t2).await;

    // Switch target to Codex and send turn 3, which fails during `send_message`.
    fixture
        .orchestrator
        .set_thread_target(methods::ThreadTargetParams {
            thread_id: thread.id,
            target: SessionTarget { provider: ProviderInstance::default_for(ProviderKind::Codex), model: None, effort: None },
            inherit_account: true,
        })
        .await
        .unwrap();
    let (t3, _) = fixture.orchestrator.send(thread.id, UserMessage::text("failed codex turn")).await.unwrap();
    wait_for_turn_settled(&mut events, thread.id, t3, ThreadStatus::Failed).await;
    assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().provider_session_id, None);
    assert!(fixture.store.meta_get(&format!("handoff:{}", thread.id)).unwrap().is_some_and(|v| !v.is_empty()));

    // "Edit from here" on turn 3 (`idx > 0` with `provider_session_id == None`) must keep a handoff
    // covering turns 1 and 2 instead of clearing it to "".
    let (_, rewound) = fixture.orchestrator.revert(thread.id, t3).await.unwrap();
    assert!(rewound);
    assert!(
        fixture.store.meta_get(&format!("handoff:{}", thread.id)).unwrap().is_some_and(|v| !v.is_empty()),
        "Edit from here on turn 3 must not wipe the pending handoff"
    );

    // Sending the edited turn 3 on Codex delivers turns 1 & 2 as portable context, without the failed turn 3.
    let (t3_edited, _) = fixture.orchestrator.send(thread.id, UserMessage::text("edited codex prompt")).await.unwrap();
    wait_for_turn_settled(&mut events, thread.id, t3_edited, ThreadStatus::Idle).await;
    let codex_spawns = codex.spawns.lock().unwrap().clone();
    let edited_prompt = codex_spawns.last().unwrap().messages().last().unwrap().clone();
    assert!(edited_prompt.contains("first claude prompt") && edited_prompt.contains("claude answer one"), "{edited_prompt}");
    assert!(edited_prompt.contains("second claude prompt") && edited_prompt.contains("claude answer two"), "{edited_prompt}");
    assert!(!edited_prompt.contains("failed codex turn"), "reverted turn leaked: {edited_prompt}");
    assert!(edited_prompt.contains("edited codex prompt"), "{edited_prompt}");

    // Rewinding to turn 1 (`idx == 0`) DOES clear the handoff.
    let (_, rewound_first) = fixture.orchestrator.revert(thread.id, t1).await.unwrap();
    assert!(rewound_first);
    assert_eq!(fixture.store.meta_get(&format!("handoff:{}", thread.id)).unwrap().as_deref(), Some(""));
}

#[tokio::test]
async fn antigravity_revert_rewinds_by_starting_a_fresh_conversation_seeded_with_kept_transcript() {
    let driver = Arc::new(ScriptedAgyDriver::antigravity(vec![
        // Turn 1
        vec![
            DriverEvent::SessionBound { session_id: "conv-1".into(), model: None },
            DriverEvent::MessageCompleted {
                message_id: "m1".into(),
                origin: EventOrigin::Root,
                text: "keep this answer".into(),
                thinking: None,
            },
            completed_response(StopReason::Completed),
        ],
        // Turn 2 (will be rewound)
        vec![
            DriverEvent::MessageCompleted {
                message_id: "m2".into(),
                origin: EventOrigin::Root,
                text: "drop this answer".into(),
                thinking: None,
            },
            completed_response(StopReason::Completed),
        ],
        // Turn 3 (after first rewind)
        vec![
            DriverEvent::SessionBound { session_id: "conv-2".into(), model: None },
            DriverEvent::MessageCompleted {
                message_id: "m3".into(),
                origin: EventOrigin::Root,
                text: "second branch answer".into(),
                thinking: None,
            },
            completed_response(StopReason::Completed),
        ],
        // Turn 4 (will also be rewound)
        vec![
            DriverEvent::MessageCompleted {
                message_id: "m4".into(),
                origin: EventOrigin::Root,
                text: "drop second branch tail".into(),
                thinking: None,
            },
            completed_response(StopReason::Completed),
        ],
        // Turn 5 (after second rewind)
        vec![
            DriverEvent::SessionBound { session_id: "conv-3".into(), model: None },
            DriverEvent::MessageCompleted {
                message_id: "m5".into(),
                origin: EventOrigin::Root,
                text: "final answer".into(),
                thinking: None,
            },
            completed_response(StopReason::Completed),
        ],
    ]));

    let mut drivers = DriverRegistry::default();
    drivers.register(driver.clone());
    let fixture = Fixture::with_drivers_and_gateway(drivers, None);
    std::fs::create_dir_all(&fixture.root).unwrap();
    let git = |args: &[&str]| {
        assert!(std::process::Command::new("git").arg("-C").arg(&fixture.root).args(args).status().unwrap().success());
    };
    git(&["init", "-q"]);
    git(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);

    let mut thread = fixture.thread_with_provider(ThreadStatus::Idle, ProviderKind::Antigravity);
    thread.permission_mode = PermissionMode::FullAccess;
    thread.provider_session_id = None;
    fixture.store.thread_upsert(&thread).unwrap();

    let mut events = fixture.orchestrator.inner.events.subscribe();

    // Turn 1
    let (t1, _) = fixture.orchestrator.send(thread.id, UserMessage::text("keep this question")).await.unwrap();
    wait_for_turn_settled(&mut events, thread.id, t1, ThreadStatus::Idle).await;
    wait_for_after_checkpoint(&fixture, thread.id, t1).await;

    // Turn 2
    let (t2, _) = fixture.orchestrator.send(thread.id, UserMessage::text("drop this question")).await.unwrap();
    wait_for_turn_settled(&mut events, thread.id, t2, ThreadStatus::Idle).await;
    wait_for_after_checkpoint(&fixture, thread.id, t2).await;

    // Rewind to before Turn 2.
    let (_, rewound) = fixture.orchestrator.revert(thread.id, t2).await.unwrap();
    assert!(rewound, "Antigravity rewind must report conversation_rewound=true");
    assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().provider_session_id, None);

    // Turn 3 starts fresh with Turn 1's transcript and none of Turn 2.
    let (t3, _) = fixture.orchestrator.send(thread.id, UserMessage::text("edited replacement")).await.unwrap();
    wait_for_turn_settled(&mut events, thread.id, t3, ThreadStatus::Idle).await;
    wait_for_after_checkpoint(&fixture, thread.id, t3).await;

    let spawns = driver.spawns.lock().unwrap().clone();
    assert_eq!(spawns.len(), 2);
    assert_eq!(spawns[1].resume_session_id, None);
    let seeded = spawns[1].messages()[0].clone();
    assert!(seeded.contains("keep this question") && seeded.contains("keep this answer"), "{seeded}");
    assert!(!seeded.contains("drop this question") && !seeded.contains("drop this answer"), "rewound turn leaked: {seeded}");
    assert!(seeded.contains("edited replacement"), "{seeded}");

    // Turn 4, then a second rewind to before Turn 4: Turn 5 must keep Turn 1 + Turn 3, and omit Turn 2 + Turn 4.
    let (t4, _) = fixture.orchestrator.send(thread.id, UserMessage::text("drop second branch question")).await.unwrap();
    wait_for_turn_settled(&mut events, thread.id, t4, ThreadStatus::Idle).await;
    wait_for_after_checkpoint(&fixture, thread.id, t4).await;
    let (_, rewound2) = fixture.orchestrator.revert(thread.id, t4).await.unwrap();
    assert!(rewound2);

    let (t5, _) = fixture.orchestrator.send(thread.id, UserMessage::text("final replacement")).await.unwrap();
    wait_for_turn_settled(&mut events, thread.id, t5, ThreadStatus::Idle).await;

    let spawns = driver.spawns.lock().unwrap().clone();
    assert_eq!(spawns.len(), 3);
    assert_eq!(spawns[2].resume_session_id, None);
    let seeded2 = spawns[2].messages()[0].clone();
    assert!(seeded2.contains("keep this question") && seeded2.contains("keep this answer"), "{seeded2}");
    assert!(seeded2.contains("edited replacement") && seeded2.contains("second branch answer"), "{seeded2}");
    assert!(!seeded2.contains("drop this question") && !seeded2.contains("drop this answer"), "{seeded2}");
    assert!(!seeded2.contains("drop second branch question") && !seeded2.contains("drop second branch tail"), "{seeded2}");
    assert!(seeded2.contains("final replacement"), "{seeded2}");
}
