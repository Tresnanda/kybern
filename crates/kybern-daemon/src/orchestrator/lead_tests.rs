// Coordinator (lead thread) tests. Included into `orchestrator::tests` so they can use
// its fixture, bridge capture and the scripted driver of the delegation tests.

use methods::{CoordinatorOpenParams, CoordinatorSwitchHarnessParams, NoteScope, NotesCreateParams, NotesUpdateParams, ProjectNoteRole};

fn open_params(project: &Project, kind: ProviderKind, brief: Option<&str>) -> CoordinatorOpenParams {
    CoordinatorOpenParams {
        project_id: project.id,
        provider: ProviderInstance::default_for(kind),
        model: None,
        effort: None,
        permission_mode: None,
        opening_message: None,
        initial_brief: brief.map(str::to_owned),
        thread_id: None,
        message_id: None,
    }
}

fn user_note(fixture: &Fixture, title: &str, body: &str, role: Option<ProjectNoteRole>) -> methods::Note {
    fixture
        .orchestrator
        .note_create(NotesCreateParams {
            scope: NoteScope::Project,
            project_id: Some(fixture.project.id),
            title: Some(title.into()),
            body: Some(body.into()),
            project_role: role,
            category: None,
        })
        .unwrap()
}

/// A bridge-capturing fixture where Claude Code and Codex both exist.
fn lead_capture_fixture() -> (Fixture, Arc<std::sync::Mutex<Vec<Option<kybern_drivers::NativeToolBridge>>>>) {
    let bridges = Arc::new(std::sync::Mutex::new(Vec::new()));
    let mut drivers = DriverRegistry::default();
    for kind in [ProviderKind::ClaudeCode, ProviderKind::Codex, ProviderKind::Cursor] {
        drivers.register(Arc::new(BridgeCapture { kind, bridges: bridges.clone() }));
    }
    let fixture = Fixture::with_drivers_and_gateway(drivers, Some(crate::native_tools_mcp::NativeToolsGateway::default()));
    std::fs::create_dir_all(&fixture.root).unwrap();
    (fixture, bridges)
}

async fn spawn_bridge(
    fixture: &Fixture,
    bridges: &Arc<std::sync::Mutex<Vec<Option<kybern_drivers::NativeToolBridge>>>>,
    thread: &Thread,
) -> kybern_drivers::NativeToolBridge {
    let live = fixture.orchestrator.spawn_session(thread, None).await.unwrap();
    fixture.orchestrator.revoke_native_session(&live);
    fixture.orchestrator.inner.sessions.lock().await.remove(&thread.id);
    bridges.lock().unwrap().last().cloned().flatten().expect("a bridge")
}

#[tokio::test]
async fn opening_the_coordinator_is_idempotent_keeps_the_brief_and_archiving_frees_the_slot() {
    let fixture = Fixture::new();
    std::fs::create_dir_all(&fixture.root).unwrap();
    assert!(fixture.orchestrator.coordinator_get(fixture.project.id).unwrap().is_none());

    // The user's own brief exists, so opening starts no setup interview.
    user_note(&fixture, "Project brief", "Ship the importer.", Some(ProjectNoteRole::Brief));
    let first = fixture.orchestrator.coordinator_open(open_params(&fixture.project, ProviderKind::ClaudeCode, None)).await.unwrap();
    assert!(first.created);
    assert_eq!(first.thread.coordinator_project_id, Some(fixture.project.id));
    assert_eq!(first.thread.parent_thread_id, None);
    assert_eq!(fixture.store.thread_get(first.thread.id).unwrap().unwrap().coordinator_project_id, Some(fixture.project.id));
    let brief = fixture.store.note_for_project_role(fixture.project.id, ProjectNoteRole::Brief).unwrap().expect("the brief note");
    assert_eq!((brief.body.as_str(), brief.summary.pinned, brief.summary.created_by_thread), ("Ship the importer.", true, None));
    assert!(fixture.store.events_for_thread(first.thread.id).unwrap().iter().all(|event| !matches!(event.payload, EventPayload::TurnStarted { .. })));

    // A retry, or a second client, gets the same thread; an existing brief is never replaced.
    let again = fixture.orchestrator.coordinator_open(open_params(&fixture.project, ProviderKind::Codex, Some("Something else"))).await.unwrap();
    assert!(!again.created);
    assert_eq!(again.thread.id, first.thread.id);
    assert_eq!(again.thread.provider.kind, ProviderKind::ClaudeCode, "open never changes a Coordinator's harness");
    assert_eq!(fixture.store.note_for_project_role(fixture.project.id, ProjectNoteRole::Brief).unwrap().unwrap().body, "Ship the importer.");
    assert_eq!(fixture.orchestrator.coordinator_get(fixture.project.id).unwrap().unwrap().id, first.thread.id);

    // Archiving frees the slot for a new Coordinator.
    fixture.orchestrator.archive_thread(first.thread.id).await.unwrap();
    let archived = fixture.store.thread_get(first.thread.id).unwrap().unwrap();
    assert_eq!((archived.status, archived.coordinator_project_id), (ThreadStatus::Archived, None));
    assert!(fixture.orchestrator.coordinator_get(fixture.project.id).unwrap().is_none());
    // A late write from a stale copy, marker included, does not take the slot back.
    fixture.orchestrator.update_thread(first.thread.clone()).unwrap();
    assert!(fixture.orchestrator.coordinator_get(fixture.project.id).unwrap().is_none());
    let replacement = fixture.orchestrator.coordinator_open(open_params(&fixture.project, ProviderKind::Codex, None)).await.unwrap();
    assert!(replacement.created && replacement.thread.id != first.thread.id);
    assert_eq!(replacement.thread.provider.kind, ProviderKind::Codex);

    let error = fixture
        .orchestrator
        .coordinator_open(CoordinatorOpenParams { project_id: FREE_CHAT_PROJECT_ID, ..open_params(&fixture.project, ProviderKind::Codex, None) })
        .await
        .unwrap_err();
    assert!(error.to_string().contains("no Coordinator"), "{error}");
}

#[tokio::test]
async fn a_coordinator_session_gets_the_lead_role_brief_notes_index_and_read_only_restrictions() {
    let (fixture, bridges) = lead_capture_fixture();
    user_note(&fixture, "Project brief", "Always propose first.\nKeep commits small.", Some(ProjectNoteRole::Brief));
    user_note(&fixture, "Release checklist", "# Steps\nTag, then publish.", None);
    let lead = fixture.orchestrator.coordinator_open(open_params(&fixture.project, ProviderKind::ClaudeCode, None)).await.unwrap().thread;
    // A setup note the Coordinator saved earlier, written the way its tool writes it.
    fixture.store.note_create_project_role(fixture.project.id, ProjectNoteRole::Setup, "How to build", "pnpm install && pnpm test", Some(lead.id)).unwrap();

    let bridge = spawn_bridge(&fixture, &bridges, &lead).await;
    let instructions = bridge.coordinator_instructions.clone().expect("the lead carries instructions");
    assert!(instructions.starts_with(LEAD_ROLE_FOR_TESTS), "the lead role comes first and is byte-stable");
    assert!(instructions.contains("Always propose first.\nKeep commits small."), "{instructions}");
    assert!(instructions.contains("Setup note: How to build: pnpm install && pnpm test"), "{instructions}");
    assert!(instructions.contains("Release checklist: Steps"), "{instructions}");
    assert!(!instructions.contains("Project brief: "), "the brief is inlined, not listed as a note");
    assert!(instructions.ends_with("do not mock, substitute or guess."));
    let guide = bridge.guide().expect("the guide");
    assert_eq!(bridge.provider_instructions().unwrap(), format!("{guide}\n{instructions}"));

    // Same instructions on a respawn, so the provider's cached prefix survives.
    let again = spawn_bridge(&fixture, &bridges, &lead).await;
    assert_eq!(again.coordinator_instructions.as_deref(), Some(instructions.as_str()));

    // Read-only restrictions: enforced on Claude, with read-only built-ins kept.
    assert!(bridge.restrictions.require_enforcement && bridge.restrictions.allow_read_only_builtins);
    for allowed in ["kybern_agent_delegate", "kybern_agent_wait", "kybern_thread_send", "kybern_read_file", "kybern_note_create", "kybern_html_publish"] {
        assert!(bridge.has_tool(allowed), "{allowed}");
    }
    for denied in ["kybern_computer_act", "kybern_computer_apps"] {
        assert!(!bridge.has_tool(denied), "{denied}");
    }
    assert!(!bridge.tools().any(|tool| tool.name.starts_with("kybern_collaboration_")));

    // Codex and Cursor cannot enforce: same tools and role, no enforcement flag.
    for kind in [ProviderKind::Codex, ProviderKind::Cursor] {
        let mut unenforced = lead.clone();
        unenforced.provider = ProviderInstance::default_for(kind);
        let bridge = spawn_bridge(&fixture, &bridges, &unenforced).await;
        assert!(!bridge.restrictions.require_enforcement, "{kind:?}");
        assert_eq!(bridge.coordinator_instructions.as_deref(), Some(instructions.as_str()), "{kind:?}");
        assert!(bridge.has_tool("kybern_agent_delegate") && !bridge.has_tool("kybern_computer_act"), "{kind:?}");
    }
    assert!(!super::lead::lead_restrictions_enforced(ProviderKind::Codex) && !super::lead::lead_restrictions_enforced(ProviderKind::Cursor));
    assert!(super::lead::lead_restrictions_enforced(ProviderKind::Omp) && super::lead::lead_restrictions_enforced(ProviderKind::Pi));
}

const LEAD_ROLE_FOR_TESTS: &str = super::lead::LEAD_ROLE;

#[tokio::test]
async fn the_lead_role_is_short_and_covers_its_rules_including_verify_memory_and_change_reports() {
    let role = super::lead::LEAD_ROLE;
    assert!(role.len() < 2800, "the role is part of the cached prefix: {} bytes", role.len());
    for rule in ["1. ", "2. ", "3. ", "4. ", "5. ", "6. ", "7. ", "8. ", "9. ", "10. "] {
        assert!(role.contains(rule), "{rule}");
    }
    for phrase in ["kybern_agent_delegate", "kybern_thread_send", "Never edit files", "setup note", "do not mock, substitute or guess", "working policy"] {
        // The ninth rule names the policy through the brief.
        let present = role.contains(phrase) || (phrase == "working policy" && role.contains("policy written in the project brief"));
        assert!(present, "{phrase}");
    }
    // Verify before claiming: check the code, read-only children cite path@sha, memory is not evidence.
    for phrase in ["6. Verify before claiming", "check the current code", "read-only child", "path@sha", "Never rely only on memory notes, a handoff or earlier results"] {
        assert!(role.contains(phrase), "{phrase}");
    }
    // Memory: dated claims with a category, commits for code, supersedes, nothing the code already shows.
    for phrase in ["7. Memory", "dated claims with a category", "As of `abc1234`", "Cite commits", "supersedes", "do not record what the code or git already shows"] {
        assert!(role.contains(phrase), "{phrase}");
    }
    // Change reports are acted on before answering.
    assert!(role.contains("\"Code changed since your last turn\"") && role.contains("update your understanding before you answer"));
    // The old advice, "consider whether a note should change", is gone.
    assert!(!role.contains("consider whether a memory note"));
}

#[tokio::test]
async fn children_of_the_lead_and_every_thread_with_the_switch_on_get_the_project_context() {
    let (fixture, bridges) = lead_capture_fixture();
    user_note(&fixture, "Project brief", "Never touch the vendored folder.", Some(ProjectNoteRole::Brief));
    user_note(&fixture, "Conventions", "Use tabs.", None);
    let lead = fixture.orchestrator.coordinator_open(open_params(&fixture.project, ProviderKind::ClaudeCode, None)).await.unwrap().thread;
    let delegated = |parent: &Thread| {
        let mut child = fixture.thread(ThreadStatus::Idle);
        child.parent_thread_id = Some(parent.id);
        child.delegation = Some(DelegationInfo {
            task_id: Uuid::now_v7(),
            operation_id: Uuid::now_v7(),
            parent_thread_id: parent.id,
            depth: 1,
            role: DelegationRole::default(),
            workspace: DelegationWorkspace::Shared,
            default_override: None,
            owns: vec![],
            status: DelegationStatus::Running,
            result: None,
            error: None,
            files_touched: vec![],
            conflicts: vec![],
            base_commit: None,
            branch: None,
            head_commit: None,
            diffstat: None,
            worktree_state: None,
            started_at: chrono::Utc::now(),
            completed_at: None,
            parent_notified: true,
        });
        fixture.store.thread_upsert(&child).unwrap();
        child
    };
    let child = delegated(&lead);
    let grandchild = delegated(&child);
    let stranger = fixture.thread(ThreadStatus::Idle);
    let strangers_child = delegated(&stranger);

    for (name, thread) in [("child", &child), ("grandchild", &grandchild)] {
        let bridge = spawn_bridge(&fixture, &bridges, thread).await;
        let text = bridge.coordinator_instructions.clone().unwrap_or_else(|| panic!("{name} gets the project context"));
        assert!(text.contains("Never touch the vendored folder.") && text.contains("Conventions: Use tabs."), "{name}: {text}");
        assert!(text.contains("do not mock, substitute or guess"), "{name}");
        assert!(!text.contains("You are this project's Coordinator"), "{name} is not told it is the lead");
        assert!(!bridge.restrictions.require_enforcement && bridge.restrictions.allowed_tools.is_empty(), "{name} keeps all of its tools");
    }
    for (name, thread) in [("ordinary thread", &stranger), ("child of an ordinary thread", &strangers_child)] {
        let bridge = spawn_bridge(&fixture, &bridges, thread).await;
        assert!(bridge.coordinator_instructions.is_none(), "{name} gets nothing by default");
    }

    // The per-project switch gives every thread the brief and the index.
    let rpc = |on| methods::ProjectsUpdateParams {
        project_id: fixture.project.id,
        name: None,
        worktrees_default: None,
        task_prefix: None,
        brief_in_all_threads: Some(on),
        coordinator: None,
        space_id: None,
        members: None,
        worktree_copy: None,
        instructions_offer_dismissed: None,
    };
    let mut project = fixture.store.project_get(fixture.project.id).unwrap().unwrap();
    project.brief_in_all_threads = rpc(true).brief_in_all_threads.unwrap();
    fixture.store.project_update(&project).unwrap();
    for thread in [&stranger, &strangers_child] {
        let bridge = spawn_bridge(&fixture, &bridges, thread).await;
        let text = bridge.coordinator_instructions.expect("the switch reaches every thread");
        assert!(text.contains("Never touch the vendored folder.") && !text.contains("Coordinator"), "{text}");
    }
}

#[tokio::test]
async fn a_changed_brief_is_prepended_once_to_the_leads_next_message_in_the_providers_copy_only() {
    let spawned = Arc::new(std::sync::Mutex::new(Vec::new()));
    let mut drivers = DriverRegistry::default();
    drivers.register(Arc::new(ScriptedDriver { kind: ProviderKind::ClaudeCode, spawned: spawned.clone() }));
    let fixture = Fixture::with_drivers(drivers);
    std::fs::create_dir_all(&fixture.root).unwrap();
    let brief = user_note(&fixture, "Project brief", "Version one.", Some(ProjectNoteRole::Brief));
    let lead = fixture.orchestrator.coordinator_open(open_params(&fixture.project, ProviderKind::ClaudeCode, None)).await.unwrap().thread;

    fixture.orchestrator.send(lead.id, UserMessage::text("first request")).await.unwrap();
    let agent = eventually(|| async { spawned.lock().unwrap().first().cloned() }).await;
    eventually(|| async { (!agent.messages.lock().await.is_empty()).then_some(()) }).await;
    let sent = agent.transcript().await;
    assert!(sent.contains("first request") && !sent.contains("Project brief updated"), "{sent}");
    agent.finish("done").await;
    eventually(|| async { (fixture.store.thread_get(lead.id).unwrap().unwrap().status == ThreadStatus::Idle).then_some(()) }).await;

    // The user edits the brief; the lead's running session learns of it on the next message.
    fixture
        .orchestrator
        .note_update(NotesUpdateParams {
            id: Some(brief.summary.id),
            thread_id: None,
            expected_revision: brief.summary.revision,
            title: None,
            body: Some("Version two: propose before editing.".into()),
            category: None,
            clear_category: false,
        })
        .unwrap();
    fixture.orchestrator.send(lead.id, UserMessage::text("second request")).await.unwrap();
    eventually(|| async { (agent.messages.lock().await.len() == 2).then_some(()) }).await;
    let second = agent.messages.lock().await[1].clone();
    let ContentPart::Text { text } = &second.parts[0] else { panic!("the update leads the message: {second:?}") };
    assert!(text.starts_with("Project brief updated:\nVersion two: propose before editing."), "{text}");
    assert!(matches!(&second.parts[1], ContentPart::Text { text } if text == "second request"));
    // The saved conversation keeps only what the user typed.
    let stored = serde_json::to_string(&fixture.store.events_for_thread(lead.id).unwrap()).unwrap();
    assert!(stored.contains("second request") && !stored.contains("Project brief updated"), "the update is not part of the user's message");

    agent.finish("done").await;
    eventually(|| async { (fixture.store.thread_get(lead.id).unwrap().unwrap().status == ThreadStatus::Idle).then_some(()) }).await;
    fixture.orchestrator.send(lead.id, UserMessage::text("third request")).await.unwrap();
    eventually(|| async { (agent.messages.lock().await.len() == 3).then_some(()) }).await;
    let third = agent.messages.lock().await[2].clone();
    assert_eq!(third.parts.len(), 1, "an update is sent once: {third:?}");
}

#[tokio::test]
async fn a_coordinator_cannot_call_tools_outside_its_allow_list_even_by_name() {
    let fixture = Fixture::new();
    std::fs::create_dir_all(&fixture.root).unwrap();
    user_note(&fixture, "Project brief", "Be careful.", Some(ProjectNoteRole::Brief));
    let mut lead = fixture.orchestrator.coordinator_open(open_params(&fixture.project, ProviderKind::ClaudeCode, None)).await.unwrap().thread;
    lead.permission_mode = PermissionMode::FullAccess;
    fixture.store.thread_upsert(&lead).unwrap();
    let (live, _) = fixture.active_app_tool_session(&lead).await;
    let error = fixture.tool(&lead, &live, "c1", "kybern_computer_act", json!({})).await.unwrap_err().to_string();
    assert!(error.contains("unavailable to a project Coordinator") && error.contains("kybern_agent_delegate"), "{error}");
    let collaboration = fixture.tool(&lead, &live, "c2", "kybern_collaboration_spawn", json!({})).await.unwrap_err().to_string();
    assert!(collaboration.contains("unavailable"), "{collaboration}");
    fixture.tool(&lead, &live, "c3", "kybern_notes_search", json!({})).await.expect("notes tools stay available");
}

#[tokio::test]
async fn the_brief_is_the_users_the_setup_note_is_the_coordinators_and_memory_notes_keep_the_old_rules() {
    let fixture = Fixture::new();
    std::fs::create_dir_all(&fixture.root).unwrap();
    let brief = user_note(&fixture, "Project brief", "Be careful.", Some(ProjectNoteRole::Brief));
    let mut lead = fixture.orchestrator.coordinator_open(open_params(&fixture.project, ProviderKind::ClaudeCode, None)).await.unwrap().thread;
    lead.permission_mode = PermissionMode::FullAccess;
    fixture.store.thread_upsert(&lead).unwrap();
    let (lead_live, _) = fixture.active_app_tool_session(&lead).await;
    let (worker, worker_live) = fixture.tool_thread(PermissionMode::FullAccess).await;

    // Nobody but the user changes the brief; the refusal tells agents to suggest it in chat.
    for (thread, live, name) in [(&lead, &lead_live, "lead"), (&worker, &worker_live, "worker")] {
        let update = fixture
            .tool(thread, live, &format!("u-{name}"), "kybern_note_update", json!({"note_id": brief.summary.id, "body": "x", "expected_revision": 1}))
            .await
            .unwrap_err()
            .to_string();
        let advice = if name == "lead" { "kybern_coordinator_propose_brief" } else { "suggest the change in chat" };
        assert!(update.contains("project brief") && update.to_lowercase().contains(advice), "{name}: {update}");
        let append = fixture
            .tool(thread, live, &format!("a-{name}"), "kybern_note_append", json!({"note_id": brief.summary.id, "text": "x"}))
            .await
            .unwrap_err()
            .to_string();
        assert!(append.contains("project brief"), "{name}: {append}");
        let read = fixture.tool(thread, live, &format!("r-{name}"), "kybern_note_read", json!({"note_id": brief.summary.id})).await.unwrap();
        assert_eq!(read["project_role"], "brief", "{name} can read it");
    }
    assert!(fixture.tool(&lead, &lead_live, "b1", "kybern_note_create", json!({"title": "Brief", "body": "x", "project_role": "brief"})).await.is_err());
    assert_eq!(fixture.store.note_get(brief.summary.id).unwrap().unwrap().body, "Be careful.");

    // The setup note: only the Coordinator creates or changes it, and there is only one.
    let refused = fixture
        .tool(&worker, &worker_live, "s0", "kybern_note_create", json!({"title": "Setup", "body": "x", "project_role": "setup"}))
        .await
        .unwrap_err()
        .to_string();
    assert!(refused.contains("Only the project's Coordinator"), "{refused}");
    let created = fixture
        .tool(&lead, &lead_live, "s1", "kybern_note_create", json!({"title": "How to build", "body": "pnpm install", "project_role": "setup"}))
        .await
        .unwrap();
    assert_eq!(created["project_role"], "setup");
    let setup = fixture.store.note_for_project_role(fixture.project.id, ProjectNoteRole::Setup).unwrap().unwrap();
    assert!(setup.summary.pinned && setup.summary.created_by_thread == Some(lead.id) && setup.summary.scope == NoteScope::Project);
    let twice = fixture
        .tool(&lead, &lead_live, "s2", "kybern_note_create", json!({"title": "Again", "body": "x", "project_role": "setup"}))
        .await
        .unwrap_err()
        .to_string();
    assert!(twice.contains("already has a setup note"), "{twice}");
    let updated = fixture
        .tool(&lead, &lead_live, "s3", "kybern_note_update", json!({"note_id": setup.summary.id, "body": "pnpm install && pnpm test", "expected_revision": 1}))
        .await
        .unwrap();
    assert_eq!(updated["revision"], 2);
    for (name, args) in [
        ("kybern_note_update", json!({"note_id": setup.summary.id, "body": "x", "expected_revision": 2})),
        ("kybern_note_append", json!({"note_id": setup.summary.id, "text": "x"})),
    ] {
        let error = fixture.tool(&worker, &worker_live, name, name, args).await.unwrap_err().to_string();
        assert!(error.contains("only its Coordinator"), "{name}: {error}");
    }
    let read = fixture.tool(&worker, &worker_live, "sr", "kybern_note_read", json!({"note_id": setup.summary.id})).await.unwrap();
    assert!(read["body"].as_str().unwrap().contains("pnpm test"));

    // Memory notes: an agent edits its own and only appends to the user's.
    let memory = fixture.tool(&lead, &lead_live, "m1", "kybern_note_create", json!({"title": "Learned", "body": "Tests need Node 22."})).await.unwrap();
    assert!(memory["project_role"].is_null());
    let theirs = user_note(&fixture, "User memo", "Mine.", None);
    assert!(fixture.tool(&lead, &lead_live, "m2", "kybern_note_update", json!({"note_id": theirs.summary.id, "body": "x", "expected_revision": 1})).await.is_err());
    fixture.tool(&lead, &lead_live, "m3", "kybern_note_append", json!({"note_id": theirs.summary.id, "text": "Also this."})).await.unwrap();
}

#[tokio::test]
async fn switching_the_coordinators_harness_keeps_the_thread_restarts_the_session_and_needs_an_idle_lead() {
    let (fixture, bridges) = lead_capture_fixture();
    // These sessions never answer, so the switch goes on without a handoff.
    fixture.orchestrator.set_handoff_timeout(Duration::from_millis(100));
    user_note(&fixture, "Project brief", "Plan first.", Some(ProjectNoteRole::Brief));
    let lead = fixture.orchestrator.coordinator_open(open_params(&fixture.project, ProviderKind::ClaudeCode, None)).await.unwrap().thread;
    let first = fixture.orchestrator.spawn_session(&lead, None).await.unwrap();
    let before = bridges.lock().unwrap().last().cloned().flatten().unwrap();
    assert!(before.restrictions.require_enforcement);
    assert!(
        before.coordinator_instructions.as_deref().unwrap().contains("There is no setup note yet."),
        "the lead is told when it still has to learn the project"
    );

    // A running Coordinator is not switched.
    let mut running = fixture.store.thread_get(lead.id).unwrap().unwrap();
    running.status = ThreadStatus::Running;
    fixture.store.thread_upsert(&running).unwrap();
    let switch = |kind| {
        fixture.orchestrator.coordinator_switch_harness(CoordinatorSwitchHarnessParams {
            project_id: fixture.project.id,
            provider: ProviderInstance::default_for(kind),
            model: None,
            effort: None,
            permission_mode: None,
        })
    };
    let error = switch(ProviderKind::Codex).await.unwrap_err().to_string();
    assert!(error.contains("must be idle"), "{error}");
    fixture.store.thread_upsert(&Thread { status: ThreadStatus::Idle, ..running }).unwrap();

    let moved = switch(ProviderKind::Codex).await.unwrap();
    assert_eq!((moved.id, moved.provider.kind, moved.provider_session_id.clone()), (lead.id, ProviderKind::Codex, None));
    assert_eq!(moved.coordinator_project_id, Some(fixture.project.id));
    assert!(first.is_released(), "the old session was closed");
    assert!(!fixture.has_session(&lead).await);
    assert!(matches!(
        fixture.store.events_for_thread(lead.id).unwrap().last().map(|event| &event.payload),
        Some(EventPayload::ContextRotated { reason: RotationReason::HarnessSwitch, .. })
    ));

    // The new session carries the same lead instructions, unenforced on Codex.
    let after = spawn_bridge(&fixture, &bridges, &moved).await;
    assert_eq!(after.coordinator_instructions, before.coordinator_instructions);
    assert!(!after.restrictions.require_enforcement);
    let back = switch(ProviderKind::ClaudeCode).await.unwrap();
    assert_eq!(back.provider.kind, ProviderKind::ClaudeCode);

    let nobody = fixture.orchestrator.coordinator_switch_harness(CoordinatorSwitchHarnessParams {
        project_id: Uuid::now_v7(),
        provider: ProviderInstance::default_for(ProviderKind::Codex),
        model: None,
        effort: None,
        permission_mode: None,
    });
    assert!(nobody.await.unwrap_err().to_string().contains("Open the project's Coordinator"));
}

#[tokio::test]
async fn the_coordinator_has_its_own_child_limit_and_other_threads_keep_theirs() {
    let t = Delegating::new().await;
    let mut settings = t.fixture.orchestrator.inner.settings.get();
    settings.orchestration = OrchestrationSettings { max_active_children: 3, lead_max_children: 1, max_depth: 2, ..Default::default() };
    t.fixture.orchestrator.inner.settings.set(settings.clone()).unwrap();

    // The parent becomes its project's Coordinator.
    t.fixture.store.thread_set_relationships(t.parent.id, None, Some(t.fixture.project.id)).unwrap();
    t.delegate(json!({"task": "one"})).await;
    let error = t.tool("kybern_agent_delegate", json!({"task": "two"})).await.unwrap_err().to_string();
    assert!(error.contains("1 delegated agents running (max 1)"), "{error}");
    let capabilities = t.tool("kybern_agent_capabilities", json!({})).await.unwrap();
    assert_eq!(capabilities["limits"]["max_active_children"], 1);

    // Raising the lead limit lifts it; the ordinary limit is a separate setting.
    settings.orchestration.lead_max_children = 2;
    t.fixture.orchestrator.inner.settings.set(settings).unwrap();
    t.delegate(json!({"task": "two"})).await;
    let error = t.tool("kybern_agent_delegate", json!({"task": "three"})).await.unwrap_err().to_string();
    assert!(error.contains("(max 2)"), "{error}");
}

#[tokio::test]
async fn opening_the_coordinator_with_a_client_id_uses_it_and_a_repeat_reports_the_creation() {
    let fixture = Fixture::new();
    std::fs::create_dir_all(&fixture.root).unwrap();
    let (thread_id, message_id) = (Uuid::now_v7(), Uuid::now_v7());
    let params = CoordinatorOpenParams {
        opening_message: Some("Ship the importer.".into()),
        thread_id: Some(thread_id),
        message_id: Some(message_id),
        ..open_params(&fixture.project, ProviderKind::Codex, None)
    };
    let first = fixture.orchestrator.coordinator_open(params.clone()).await.unwrap();
    assert!(first.created);
    assert_eq!(first.thread.id, thread_id);
    let turn_started = |id| {
        fixture.store.events_for_thread(id).unwrap().iter().filter(|event| matches!(&event.payload, EventPayload::TurnStarted { message_id: sent, .. } if *sent == message_id)).count()
    };
    assert_eq!(turn_started(thread_id), 1, "the opening message carries the client's id");

    // A repeat gets the same thread, reported as created so its opening message is not sent again.
    let repeat = fixture.orchestrator.coordinator_open(params).await.unwrap();
    assert!(repeat.created && repeat.thread.id == thread_id);
    assert_eq!(turn_started(thread_id), 1);

    // Another client with its own id gets the existing Coordinator, not a second one.
    let other = fixture
        .orchestrator
        .coordinator_open(CoordinatorOpenParams { thread_id: Some(Uuid::now_v7()), ..open_params(&fixture.project, ProviderKind::Codex, None) })
        .await
        .unwrap();
    assert!(!other.created && other.thread.id == thread_id);
}
