// Full access permission tests. Included into `orchestrator::tests` so they
// can use its fixture and test sessions.

/// A driver that records each launch's config and hands back a test session.
struct LaunchRecordingDriver {
    kind: ProviderKind,
    configs: Arc<std::sync::Mutex<Vec<kybern_drivers::SessionConfig>>>,
    /// Keeps each launched session's event stream open.
    senders: std::sync::Mutex<Vec<tokio::sync::mpsc::Sender<DriverEvent>>>,
}

#[async_trait::async_trait]
impl kybern_drivers::AgentDriver for LaunchRecordingDriver {
    fn kind(&self) -> ProviderKind {
        self.kind
    }

    async fn probe(&self, _binary: Option<&PathBuf>) -> ProviderStatus {
        ProviderStatus {
            kind: self.kind,
            display_name: "Recording".into(),
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
        self.configs.lock().unwrap().push(config);
        let (tx, events) = tokio::sync::mpsc::channel(8);
        self.senders.lock().unwrap().push(tx);
        Ok(kybern_drivers::SpawnedSession { session: Box::new(TestSession::default()), events })
    }
}

fn recording_fixture(kind: ProviderKind) -> (Fixture, Arc<std::sync::Mutex<Vec<kybern_drivers::SessionConfig>>>) {
    let configs = Arc::new(std::sync::Mutex::new(Vec::new()));
    let mut drivers = DriverRegistry::default();
    drivers.register(Arc::new(LaunchRecordingDriver { kind, configs: configs.clone(), senders: Default::default() }));
    (Fixture::with_drivers(drivers), configs)
}

fn permission_request(id: &str, tool_name: &str) -> DriverEvent {
    DriverEvent::PermissionRequest {
        request_id: id.into(),
        tool_call_id: Some(format!("call-{id}")),
        tool_name: tool_name.into(),
        input: json!({"command": "rm -f $P/$d/*.png"}),
        summary: format!("{tool_name}: Delete raw frames"),
        suggestions: vec![],
    }
}

fn set_mode(thread: &Thread, mode: PermissionMode) -> methods::ThreadsUpdateParams {
    methods::ThreadsUpdateParams { thread_id: thread.id, title: None, pinned: None, permission_mode: Some(mode), model: None, effort: None }
}

/// A thread in `mode` with an active turn on a session whose permission
/// responses the test reads.
async fn full_access_turn(
    fixture: &Fixture,
    provider: ProviderKind,
    mode: PermissionMode,
) -> (Thread, Arc<LiveSession>, Arc<Mutex<Vec<ApprovalDecision>>>) {
    let mut thread = fixture.thread_with_provider(ThreadStatus::Idle, provider);
    thread.permission_mode = mode;
    fixture.store.thread_upsert(&thread).unwrap();
    let session = TestSession::default();
    let responses = session.permission_responses.clone();
    let live = fixture.active_session(&thread, session).await;
    (thread, live, responses)
}

#[tokio::test]
async fn full_access_allows_harness_permissions_without_asking_and_records_it() {
    for provider in ProviderKind::ALL {
        let fixture = Fixture::new();
        let (thread, live, responses) = full_access_turn(&fixture, provider, PermissionMode::FullAccess).await;
        fixture.orchestrator.handle_driver_event(thread.id, &live, permission_request("p1", "Bash")).await.unwrap();

        assert_eq!(*responses.lock().await, vec![ApprovalDecision::AllowOnce], "{provider}");
        assert!(live.pending.lock().await.is_empty());
        assert!(fixture.store.approvals_pending(Some(thread.id)).unwrap().is_empty());
        assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().status, ThreadStatus::Running);
        let events = fixture.store.events_for_thread(thread.id).unwrap();
        assert!(!events.iter().any(|event| matches!(event.payload, EventPayload::ApprovalRequested { .. })));
        let transcript = kybern_store::project_transcript(&events);
        assert!(transcript.iter().any(|entry| matches!(
            entry,
            TranscriptEntry::Approval { approval, decision: Some(ApprovalDecision::AllowOnce), auto: true, .. }
                if approval.tool_name == "Bash" && approval.tool_call_id.as_deref() == Some("call-p1")
        )));
    }
}

#[tokio::test]
async fn full_access_still_asks_questions_forms_and_plans() {
    let fixture = Fixture::new();
    let (thread, live, responses) = full_access_turn(&fixture, ProviderKind::ClaudeCode, PermissionMode::FullAccess).await;
    let asks =
        ["AskUserQuestion", "mcp_elicitation", "request_user_input", "opencode_question", "ui_select", "ui_confirm", "ExitPlanMode", SECRET_REQUEST_TOOL, LOGIN_REQUEST_TOOL, PROMPT_REQUEST_TOOL, PERMISSION_REQUEST_TOOL];
    for (index, tool) in asks.iter().enumerate() {
        fixture.orchestrator.handle_driver_event(thread.id, &live, permission_request(&format!("q{index}"), tool)).await.unwrap();
    }
    assert!(responses.lock().await.is_empty(), "no question is answered for the user");
    assert_eq!(live.pending.lock().await.len(), asks.len());
    assert_eq!(fixture.store.approvals_pending(Some(thread.id)).unwrap().len(), asks.len());
    assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().status, ThreadStatus::AwaitingApproval);
    assert!(
        !fixture
            .store
            .events_for_thread(thread.id)
            .unwrap()
            .iter()
            .any(|event| matches!(event.payload, EventPayload::ApprovalAutoAllowed { .. }))
    );
}

#[tokio::test]
async fn stricter_modes_still_ask_for_permissions() {
    for mode in [PermissionMode::Supervised, PermissionMode::AcceptEdits, PermissionMode::Auto] {
        let fixture = Fixture::new();
        let (thread, live, responses) = full_access_turn(&fixture, ProviderKind::Codex, mode).await;
        fixture.orchestrator.handle_driver_event(thread.id, &live, permission_request("p1", "shell")).await.unwrap();
        assert!(responses.lock().await.is_empty(), "{mode:?}");
        assert_eq!(live.pending.lock().await.len(), 1);
        assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().status, ThreadStatus::AwaitingApproval);
    }
}

#[tokio::test]
async fn full_access_allows_requests_from_background_work_after_the_turn() {
    let fixture = Fixture::new();
    let (thread, live, responses) = full_access_turn(&fixture, ProviderKind::ClaudeCode, PermissionMode::FullAccess).await;
    let turn_id = live.turn.lock().await.as_ref().unwrap().id;
    fixture.orchestrator.handle_driver_event(thread.id, &live, completed_response(StopReason::Completed)).await.unwrap();
    *live.turn.lock().await = None;
    *live.last_turn_id.lock().await = Some(turn_id);
    fixture.orchestrator.handle_driver_event(thread.id, &live, permission_request("late", "Bash")).await.unwrap();
    assert_eq!(*responses.lock().await, vec![ApprovalDecision::AllowOnce]);
    let events = fixture.store.events_for_thread(thread.id).unwrap();
    assert!(events.iter().any(|event| event.turn_id == Some(turn_id) && matches!(event.payload, EventPayload::ApprovalAutoAllowed { .. })));
}

#[tokio::test]
async fn switching_to_full_access_mid_turn_allows_waiting_and_later_permissions() {
    let fixture = Fixture::new();
    let (thread, live, responses) = full_access_turn(&fixture, ProviderKind::ClaudeCode, PermissionMode::Supervised).await;
    fixture.orchestrator.handle_driver_event(thread.id, &live, permission_request("before", "Bash")).await.unwrap();
    fixture.orchestrator.handle_driver_event(thread.id, &live, permission_request("question", "AskUserQuestion")).await.unwrap();
    assert!(responses.lock().await.is_empty());

    fixture.orchestrator.update_session_fields(set_mode(&thread, PermissionMode::FullAccess)).await.unwrap();
    // The running process keeps its launch mode until the turn ends; Kybern
    // allows the waiting command now and the question keeps waiting.
    let state = fixture.orchestrator.thread_target(thread.id).unwrap();
    assert_eq!(state.pending_permission_mode, Some(PermissionMode::FullAccess));
    assert_eq!(*responses.lock().await, vec![ApprovalDecision::AllowOnce]);
    let waiting = fixture.store.approvals_pending(Some(thread.id)).unwrap();
    assert_eq!(waiting.iter().map(|approval| approval.tool_name.as_str()).collect::<Vec<_>>(), vec!["AskUserQuestion"]);

    fixture.orchestrator.handle_driver_event(thread.id, &live, permission_request("after", "Write")).await.unwrap();
    assert_eq!(*responses.lock().await, vec![ApprovalDecision::AllowOnce, ApprovalDecision::AllowOnce]);
    assert_eq!(fixture.store.approvals_pending(Some(thread.id)).unwrap().len(), 1);
}

#[tokio::test]
async fn a_stricter_mode_applied_after_a_stale_full_access_choice_asks_again() {
    let fixture = Fixture::new();
    let (thread, live, responses) = full_access_turn(&fixture, ProviderKind::Codex, PermissionMode::Supervised).await;
    fixture.orchestrator.update_session_fields(set_mode(&thread, PermissionMode::FullAccess)).await.unwrap();
    assert_eq!(fixture.orchestrator.thread_target(thread.id).unwrap().pending_permission_mode, Some(PermissionMode::FullAccess));
    // The turn ends without applying the waiting choice (as a failed turn
    // does); the user then applies Supervised explicitly.
    let mut idle = fixture.store.thread_get(thread.id).unwrap().unwrap();
    idle.status = ThreadStatus::Idle;
    fixture.store.thread_upsert(&idle).unwrap();
    fixture.orchestrator.update_session_fields(set_mode(&thread, PermissionMode::Supervised)).await.unwrap();
    assert_eq!(fixture.orchestrator.thread_target(thread.id).unwrap().pending_permission_mode, None);

    fixture.orchestrator.handle_driver_event(thread.id, &live, permission_request("p1", "shell")).await.unwrap();
    assert!(responses.lock().await.is_empty(), "Supervised asks again");
    assert_eq!(live.pending.lock().await.len(), 1);
}

#[tokio::test]
async fn full_access_for_another_harness_leaves_waiting_requests_alone() {
    let fixture = Fixture::new();
    let (thread, live, responses) = full_access_turn(&fixture, ProviderKind::ClaudeCode, PermissionMode::Supervised).await;
    fixture.orchestrator.handle_driver_event(thread.id, &live, permission_request("before", "Bash")).await.unwrap();
    let mut target = fixture.orchestrator.thread_target(thread.id).unwrap().target;
    target.provider = ProviderInstance::default_for(ProviderKind::Codex);
    fixture
        .orchestrator
        .set_thread_target(methods::ThreadTargetParams { thread_id: thread.id, target, inherit_account: true })
        .await
        .unwrap();
    fixture.orchestrator.update_session_fields(set_mode(&thread, PermissionMode::FullAccess)).await.unwrap();
    assert!(responses.lock().await.is_empty(), "Claude stays in Supervised");
    assert_eq!(live.pending.lock().await.len(), 1);
}

#[tokio::test]
async fn switching_an_idle_session_to_full_access_resumes_it_with_bypass() {
    for provider in [ProviderKind::ClaudeCode, ProviderKind::Omp] {
        let (fixture, configs) = recording_fixture(provider);
        let thread = fixture.thread_with_provider(ThreadStatus::Idle, provider);
        let (live, closes) = fixture.park(&thread, Instant::now()).await;
        if provider == ProviderKind::Omp {
            // Oh My Pi fixes its approval mode when the agent starts.
            fixture.orchestrator.inner.sessions.lock().await.remove(&thread.id);
            let mut live = Arc::try_unwrap(live).ok().unwrap();
            live.session = Box::new(TestSession { closes: closes.clone(), reject_permission: true, ..Default::default() });
            fixture.orchestrator.inner.sessions.lock().await.insert(thread.id, Arc::new(live));
        }
        let updated = fixture.orchestrator.update_session_fields(set_mode(&thread, PermissionMode::FullAccess)).await.unwrap();

        assert_eq!(updated.permission_mode, PermissionMode::FullAccess, "{provider}");
        assert_eq!(closes.load(Ordering::SeqCst), 1, "{provider}: the old process is closed");
        let configs = configs.lock().unwrap();
        assert_eq!(configs.len(), 1, "{provider}: one relaunch");
        assert_eq!(configs[0].permission_mode, PermissionMode::FullAccess);
        assert_eq!(configs[0].resume_session_id.as_deref(), Some("provider-session"), "{provider}: the conversation continues");
        assert!(!configs[0].fork);
    }
}

#[tokio::test]
async fn opencode_switches_to_full_access_without_a_relaunch_and_kybern_allows_its_requests() {
    let (fixture, configs) = recording_fixture(ProviderKind::Opencode);
    let thread = fixture.thread_with_provider(ThreadStatus::Idle, ProviderKind::Opencode);
    let (live, _) = fixture.park(&thread, Instant::now()).await;
    fixture.orchestrator.inner.sessions.lock().await.remove(&thread.id);
    let mut live = Arc::try_unwrap(live).ok().unwrap();
    let responses = Arc::new(Mutex::new(Vec::new()));
    live.session = Box::new(TestSession { reject_permission: true, permission_responses: responses.clone(), ..Default::default() });
    let live = Arc::new(live);
    fixture.orchestrator.inner.sessions.lock().await.insert(thread.id, live.clone());

    let updated = fixture.orchestrator.update_session_fields(set_mode(&thread, PermissionMode::FullAccess)).await.unwrap();
    assert_eq!(updated.permission_mode, PermissionMode::FullAccess);
    assert!(configs.lock().unwrap().is_empty(), "a resumed OpenCode session keeps its launch rules, so it is not relaunched");
    // Moving back to a stricter mode still needs a new session.
    assert!(fixture.orchestrator.update_session_fields(set_mode(&thread, PermissionMode::Supervised)).await.is_err());

    fixture.orchestrator.send(thread.id, UserMessage::text("clean up")).await.unwrap();
    live.turn_ready.notified().await;
    fixture.orchestrator.handle_driver_event(thread.id, &live, permission_request("p1", "bash")).await.unwrap();
    assert_eq!(*responses.lock().await, vec![ApprovalDecision::AllowOnce]);
}
