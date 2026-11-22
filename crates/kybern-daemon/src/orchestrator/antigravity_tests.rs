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

#[derive(Clone)]
struct AgyRecord {
    resume_session_id: Option<String>,
    messages: Arc<std::sync::Mutex<Vec<String>>>,
}

struct ScriptedAntigravity {
    spawns: Arc<std::sync::Mutex<Vec<AgyRecord>>>,
    /// Events emitted automatically when `send_message` is called, one script per call.
    scripts: Arc<std::sync::Mutex<std::collections::VecDeque<Vec<DriverEvent>>>>,
}

impl ScriptedAntigravity {
    fn new(scripts: Vec<Vec<DriverEvent>>) -> Self {
        Self {
            spawns: Arc::new(std::sync::Mutex::new(Vec::new())),
            scripts: Arc::new(std::sync::Mutex::new(scripts.into())),
        }
    }
}

struct ScriptedAgySession {
    messages: Arc<std::sync::Mutex<Vec<String>>>,
    tx: tokio::sync::mpsc::Sender<DriverEvent>,
    scripts: Arc<std::sync::Mutex<std::collections::VecDeque<Vec<DriverEvent>>>>,
}

#[async_trait::async_trait]
impl kybern_drivers::AgentSession for ScriptedAgySession {
    async fn send_message(&self, _id: &str, message: &UserMessage) -> kybern_drivers::Result<()> {
        self.messages.lock().unwrap().push(message.plain_text());
        let batch = self.scripts.lock().unwrap().pop_front().unwrap_or_default();
        let tx = self.tx.clone();
        tokio::spawn(async move {
            for event in batch {
                let _ = tx.send(event).await;
            }
        });
        Ok(())
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
        let _ = self.tx.send(DriverEvent::Exited { code: Some(0), error: None }).await;
        Ok(())
    }
}

#[async_trait::async_trait]
impl kybern_drivers::AgentDriver for ScriptedAntigravity {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Antigravity
    }
    fn supports_fork(&self) -> bool {
        false
    }
    async fn probe(&self, _: Option<&std::path::PathBuf>) -> ProviderStatus {
        ProviderStatus {
            kind: ProviderKind::Antigravity,
            display_name: "Antigravity".into(),
            available: true,
            binary_path: None,
            version: Some("1.5.14".into()),
            unavailable_reason: None,
            supported_permission_modes: vec![PermissionMode::FullAccess],
            supports_fork: false,
            supports_model_switch: true,
            supports_effort_switch: true,
            supported_efforts: vec![],
            models: vec![],
            instances: vec!["default".into()],
        }
    }
    async fn spawn(&self, config: kybern_drivers::SessionConfig) -> kybern_drivers::Result<kybern_drivers::SpawnedSession> {
        let (tx, events) = tokio::sync::mpsc::channel(64);
        let messages = Arc::new(std::sync::Mutex::new(Vec::new()));
        self.spawns.lock().unwrap().push(AgyRecord {
            resume_session_id: config.resume_session_id,
            messages: messages.clone(),
        });
        Ok(kybern_drivers::SpawnedSession {
            session: Box::new(ScriptedAgySession { messages, tx, scripts: self.scripts.clone() }),
            events,
        })
    }
}

async fn wait_for_status(store: &kybern_store::Store, thread_id: ThreadId, expected: ThreadStatus) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if store.thread_get(thread_id).unwrap().is_some_and(|t| t.status == expected) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("thread did not reach {expected:?}: {:?}", store.thread_get(thread_id).unwrap().map(|t| t.status)));
}

#[tokio::test]
async fn antigravity_thinking_signature_failure_retries_once_on_a_fresh_conversation_with_context() {
    let raw_sig_err = r#"Error 400, Message: {"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0.thinking.signature: Field required"}}, Status: INVALID_ARGUMENT"#;
    let sig_problem = kybern_protocol::rpc::Problem::new(kybern_protocol::rpc::ProblemKind::Internal, raw_sig_err)
        .with_subject("antigravity");

    let driver = Arc::new(ScriptedAntigravity::new(vec![
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
    ]));

    let mut drivers = DriverRegistry::default();
    drivers.register(driver.clone());
    let fixture = Fixture::with_drivers_and_gateway(drivers, None);
    std::fs::create_dir_all(&fixture.root).unwrap();
    let mut thread = fixture.thread_with_provider(ThreadStatus::Idle, ProviderKind::Antigravity);
    thread.permission_mode = PermissionMode::FullAccess;
    thread.provider_session_id = None;
    fixture.store.thread_upsert(&thread).unwrap();

    // Turn 1 establishes the conversation.
    fixture.orchestrator.send(thread.id, UserMessage::text("earlier question")).await.unwrap();
    wait_for_status(&fixture.store, thread.id, ThreadStatus::Idle).await;
    assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().provider_session_id.as_deref(), Some("conv-poisoned"));

    // Turn 2 hits the thinking-signature error and recovers automatically on a fresh conversation.
    fixture.orchestrator.send(thread.id, UserMessage::text("follow-up question")).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let current = fixture.store.thread_get(thread.id).unwrap().unwrap();
            if current.status == ThreadStatus::Idle && current.provider_session_id.as_deref() == Some("conv-fresh") {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("recovered onto conv-fresh");

    let spawns = driver.spawns.lock().unwrap().clone();
    assert_eq!(spawns.len(), 2, "second spawn was a fresh conversation");
    assert_eq!(spawns[1].resume_session_id, None, "poisoned conversation id must be dropped");
    let retried_prompt = spawns[1].messages.lock().unwrap()[0].clone();
    assert!(retried_prompt.contains("earlier question"), "missing prior user turn: {retried_prompt}");
    assert!(retried_prompt.contains("earlier answer"), "missing prior assistant turn: {retried_prompt}");
    assert!(retried_prompt.contains("follow-up question"), "missing current user turn: {retried_prompt}");

    // Turn 3 fails twice: only one automatic retry occurs, then the turn fails cleanly.
    fixture.orchestrator.send(thread.id, UserMessage::text("third question")).await.unwrap();
    wait_for_status(&fixture.store, thread.id, ThreadStatus::Failed).await;
    assert_eq!(driver.spawns.lock().unwrap().len(), 3, "only one retry spawn for the double failure");
}

#[tokio::test]
async fn antigravity_revert_rewinds_by_starting_a_fresh_conversation_seeded_with_kept_transcript() {
    let driver = Arc::new(ScriptedAntigravity::new(vec![
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

    let wait_checkpoint = |turn_id: TurnId| {
        let store = fixture.store.clone();
        async move {
            tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    if store.checkpoint_get(turn_id).unwrap().is_some_and(|c| c.after.is_some()) {
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .expect("checkpoint recorded");
        }
    };

    // Turn 1
    let (t1, _) = fixture.orchestrator.send(thread.id, UserMessage::text("keep this question")).await.unwrap();
    wait_for_status(&fixture.store, thread.id, ThreadStatus::Idle).await;
    wait_checkpoint(t1).await;

    // Turn 2
    let (t2, _) = fixture.orchestrator.send(thread.id, UserMessage::text("drop this question")).await.unwrap();
    wait_for_status(&fixture.store, thread.id, ThreadStatus::Idle).await;
    wait_checkpoint(t2).await;

    // Rewind to before Turn 2.
    let (_, rewound) = fixture.orchestrator.revert(thread.id, t2).await.unwrap();
    assert!(rewound, "Antigravity rewind must report conversation_rewound=true");
    assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().provider_session_id, None);

    // Turn 3 starts fresh with Turn 1's transcript and none of Turn 2.
    let (t3, _) = fixture.orchestrator.send(thread.id, UserMessage::text("edited replacement")).await.unwrap();
    wait_for_status(&fixture.store, thread.id, ThreadStatus::Idle).await;
    wait_checkpoint(t3).await;

    let spawns = driver.spawns.lock().unwrap().clone();
    assert_eq!(spawns.len(), 2);
    assert_eq!(spawns[1].resume_session_id, None);
    let seeded = spawns[1].messages.lock().unwrap()[0].clone();
    assert!(seeded.contains("keep this question") && seeded.contains("keep this answer"), "{seeded}");
    assert!(!seeded.contains("drop this question") && !seeded.contains("drop this answer"), "rewound turn leaked: {seeded}");
    assert!(seeded.contains("edited replacement"), "{seeded}");

    // Turn 4, then a second rewind to before Turn 4: Turn 5 must keep Turn 1 + Turn 3, and omit Turn 2 + Turn 4.
    let (t4, _) = fixture.orchestrator.send(thread.id, UserMessage::text("drop second branch question")).await.unwrap();
    wait_for_status(&fixture.store, thread.id, ThreadStatus::Idle).await;
    wait_checkpoint(t4).await;
    let (_, rewound2) = fixture.orchestrator.revert(thread.id, t4).await.unwrap();
    assert!(rewound2);

    fixture.orchestrator.send(thread.id, UserMessage::text("final replacement")).await.unwrap();
    wait_for_status(&fixture.store, thread.id, ThreadStatus::Idle).await;

    let spawns = driver.spawns.lock().unwrap().clone();
    assert_eq!(spawns.len(), 3);
    assert_eq!(spawns[2].resume_session_id, None);
    let seeded2 = spawns[2].messages.lock().unwrap()[0].clone();
    assert!(seeded2.contains("keep this question") && seeded2.contains("keep this answer"), "{seeded2}");
    assert!(seeded2.contains("edited replacement") && seeded2.contains("second branch answer"), "{seeded2}");
    assert!(!seeded2.contains("drop this question") && !seeded2.contains("drop this answer"), "{seeded2}");
    assert!(!seeded2.contains("drop second branch question") && !seeded2.contains("drop second branch tail"), "{seeded2}");
    assert!(seeded2.contains("final replacement"), "{seeded2}");
}
