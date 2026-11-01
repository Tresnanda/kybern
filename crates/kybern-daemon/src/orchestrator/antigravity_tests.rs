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
    provider.accounts.insert("second".into(), ProviderAccount { name: "Second".into(), directory: "/tmp/second".into(), ..Default::default() });
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
