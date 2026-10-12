// Coordinator setup interview, proposal cards and enforced defaults. Included into
// `orchestrator::tests` after `lead_tests.rs`, so it shares its helpers and fixtures.

fn scripted_lead_fixture() -> (Fixture, Arc<std::sync::Mutex<Vec<ScriptedChild>>>) {
    let spawned = Arc::new(std::sync::Mutex::new(Vec::new()));
    let mut drivers = DriverRegistry::default();
    drivers.register(Arc::new(ScriptedDriver { kind: ProviderKind::ClaudeCode, spawned: spawned.clone() }));
    let fixture = Fixture::with_drivers(drivers);
    std::fs::create_dir_all(&fixture.root).unwrap();
    (fixture, spawned)
}

/// The messages the user's turns started with, as stored.
fn started_messages(fixture: &Fixture, thread_id: ThreadId) -> Vec<UserMessage> {
    fixture
        .store
        .events_for_thread(thread_id)
        .unwrap()
        .into_iter()
        .filter_map(|event| match event.payload {
            EventPayload::TurnStarted { message, .. } => Some(message),
            _ => None,
        })
        .collect()
}

async fn sent_to(agent: &ScriptedChild, count: usize) -> Vec<UserMessage> {
    eventually(|| async {
        let messages = agent.messages.lock().await.clone();
        (messages.len() >= count).then_some(messages)
    })
    .await
}

fn setup_row() -> ContentPart {
    ContentPart::SystemRow { kind: SystemRowKind::CoordinatorSetup, text: "Setup started".into() }
}

async fn end_turn(fixture: &Fixture, thread_id: ThreadId) {
    let live = fixture.orchestrator.inner.sessions.lock().await.get(&thread_id).cloned().expect("a live session");
    fixture.orchestrator.process_driver_event(thread_id, &live, completed_response(StopReason::Completed), false).await.unwrap();
    eventually(|| async { (fixture.store.thread_get(thread_id).unwrap().unwrap().status == ThreadStatus::Idle).then_some(()) }).await;
}

#[tokio::test]
async fn a_new_coordinator_without_a_brief_starts_the_setup_and_the_opening_message_is_never_the_brief() {
    let (fixture, spawned) = scripted_lead_fixture();
    let mut params = open_params(&fixture.project, ProviderKind::ClaudeCode, None);
    params.opening_message = Some("  A CSV importer for shop exports.  ".into());
    let opened = fixture.orchestrator.coordinator_open(params).await.unwrap();
    assert!(opened.created);

    // Clients see a "Setup started" row, then the user's own words.
    let stored = started_messages(&fixture, opened.thread.id);
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].parts, vec![setup_row(), ContentPart::Text { text: "A CSV importer for shop exports.".into() }]);

    // The provider gets the script and the opening answer, and no row.
    let agent = eventually(|| async { spawned.lock().unwrap().first().cloned() }).await;
    let sent = sent_to(&agent, 1).await;
    assert!(sent[0].parts.iter().all(|part| !matches!(part, ContentPart::SystemRow { .. })));
    let text = sent[0].plain_text();
    assert!(text.starts_with(super::lead::SETUP_SCRIPT), "{text}");
    assert!(text.contains("A CSV importer for shop exports.") && !text.contains("Setup started"), "{text}");
    assert!(!text.contains("already has a brief"));
    assert!(super::lead::SETUP_SCRIPT.len() < 2500, "the script is concise: {} bytes", super::lead::SETUP_SCRIPT.len());
    for needed in ["AskUserQuestion", "recommended answer", "3 rounds", "kybern_coordinator_propose_brief", "kybern_coordinator_propose_settings", "project_role"] {
        assert!(super::lead::SETUP_SCRIPT.contains(needed), "{needed}");
    }

    // Nothing wrote the brief: only the proposal card or the user does.
    assert!(fixture.store.note_for_project_role(fixture.project.id, ProjectNoteRole::Brief).unwrap().is_none());
    // The saved conversation never holds the script.
    let events = serde_json::to_string(&fixture.store.events_for_thread(opened.thread.id).unwrap()).unwrap();
    assert!(!events.contains("setup interview"), "the script is the provider's copy only");
}

#[tokio::test]
async fn the_older_initial_brief_field_is_treated_as_the_opening_message() {
    let (fixture, spawned) = scripted_lead_fixture();
    let opened = fixture.orchestrator.coordinator_open(open_params(&fixture.project, ProviderKind::ClaudeCode, Some("Ship it."))).await.unwrap();
    let stored = started_messages(&fixture, opened.thread.id);
    assert_eq!(stored[0].parts, vec![setup_row(), ContentPart::Text { text: "Ship it.".into() }]);
    assert!(fixture.store.note_for_project_role(fixture.project.id, ProjectNoteRole::Brief).unwrap().is_none());
    let agent = eventually(|| async { spawned.lock().unwrap().first().cloned() }).await;
    assert!(sent_to(&agent, 1).await[0].plain_text().contains("Ship it."));
}

#[tokio::test]
async fn no_setup_starts_when_the_project_already_has_a_brief() {
    let (fixture, spawned) = scripted_lead_fixture();
    user_note(&fixture, "Project brief", "Be careful.", Some(ProjectNoteRole::Brief));

    // Without an opening message nothing starts at all.
    let quiet = fixture.orchestrator.coordinator_open(open_params(&fixture.project, ProviderKind::ClaudeCode, None)).await.unwrap();
    assert!(started_messages(&fixture, quiet.thread.id).is_empty());
    assert!(spawned.lock().unwrap().is_empty());
    fixture.orchestrator.archive_thread(quiet.thread.id).await.unwrap();

    // With one, it is an ordinary message: no row, no script.
    let mut params = open_params(&fixture.project, ProviderKind::ClaudeCode, None);
    params.opening_message = Some("Add a retry to the importer.".into());
    let opened = fixture.orchestrator.coordinator_open(params).await.unwrap();
    assert_eq!(started_messages(&fixture, opened.thread.id), vec![UserMessage::text("Add a retry to the importer.")]);
    let agent = eventually(|| async { spawned.lock().unwrap().first().cloned() }).await;
    let text = sent_to(&agent, 1).await[0].plain_text();
    assert_eq!(text, "Add a retry to the importer.");
    assert_eq!(fixture.store.note_for_project_role(fixture.project.id, ProjectNoteRole::Brief).unwrap().unwrap().body, "Be careful.");

    // Opening again returns the same Coordinator and starts nothing new.
    let mut again = open_params(&fixture.project, ProviderKind::ClaudeCode, None);
    again.opening_message = Some("Ignored.".into());
    let second = fixture.orchestrator.coordinator_open(again).await.unwrap();
    assert!(!second.created);
    assert_eq!(started_messages(&fixture, opened.thread.id).len(), 1);
}

#[tokio::test]
async fn redo_setup_restarts_the_interview_on_an_idle_coordinator_only() {
    let (fixture, spawned) = scripted_lead_fixture();
    let nobody = fixture.orchestrator.coordinator_setup(methods::CoordinatorSetupParams { project_id: fixture.project.id }).await;
    assert!(nobody.unwrap_err().to_string().contains("Open the project's Coordinator"));

    let opened = fixture.orchestrator.coordinator_open(open_params(&fixture.project, ProviderKind::ClaudeCode, None)).await.unwrap();
    let agent = eventually(|| async { spawned.lock().unwrap().first().cloned() }).await;
    let first = sent_to(&agent, 1).await;
    assert!(first[0].plain_text().contains("The user has not said anything yet."));

    // The first interview is still running a turn.
    let busy = fixture.orchestrator.coordinator_setup(methods::CoordinatorSetupParams { project_id: fixture.project.id }).await;
    assert_eq!(busy.unwrap_err().to_string(), "Wait for the Coordinator to finish, then try again.");
    assert_eq!(started_messages(&fixture, opened.thread.id).len(), 1);

    end_turn(&fixture, opened.thread.id).await;
    let thread = fixture.orchestrator.coordinator_setup(methods::CoordinatorSetupParams { project_id: fixture.project.id }).await.unwrap();
    assert_eq!(thread.id, opened.thread.id);
    let stored = started_messages(&fixture, opened.thread.id);
    assert_eq!(stored.len(), 2);
    assert_eq!(stored[1].parts, vec![setup_row()], "Redo setup is a row alone");
    let second = sent_to(&agent, 2).await;
    assert!(second[1].plain_text().starts_with(super::lead::SETUP_SCRIPT));
    assert!(!second[1].plain_text().contains("already has a brief"));

    // Once the user has a brief, the interview refines it instead of starting over.
    end_turn(&fixture, opened.thread.id).await;
    user_note(&fixture, "Project brief", "Be careful.", Some(ProjectNoteRole::Brief));
    fixture.orchestrator.coordinator_setup(methods::CoordinatorSetupParams { project_id: fixture.project.id }).await.unwrap();
    let third = sent_to(&agent, 3).await;
    assert!(third[2].plain_text().contains("already has a brief"), "{}", third[2].plain_text());
}

/// Start a native tool call as a harness would.
fn start_tool_call(
    fixture: &Fixture,
    thread: &Thread,
    live: &LiveSession,
    call: &'static str,
    name: &'static str,
    args: serde_json::Value,
) -> tokio::task::JoinHandle<anyhow::Result<serde_json::Value>> {
    let (orchestrator, thread_id, session) = (fixture.orchestrator.clone(), thread.id, live.session_instance_id);
    tokio::spawn(async move { orchestrator.execute_native_app_tool_call(thread_id, session, call, name, args).await })
}

/// A Coordinator thread with an active turn, without the setup turn `coordinator.open` would start.
async fn lead_tool_thread(fixture: &Fixture) -> (Thread, Arc<LiveSession>) {
    let thread = fixture.thread(ThreadStatus::Idle);
    fixture.store.thread_set_relationships(thread.id, None, Some(fixture.project.id)).unwrap();
    let thread = fixture.store.thread_get(thread.id).unwrap().unwrap();
    let (live, _) = fixture.active_app_tool_session(&thread).await;
    (thread, live)
}

#[tokio::test]
async fn the_brief_card_saves_the_users_final_wording_as_their_own_brief() {
    let fixture = Fixture::new();
    std::fs::create_dir_all(&fixture.root).unwrap();
    let (lead, live) = lead_tool_thread(&fixture).await;
    *live.brief_revision.lock().await = Some(0);

    let call = start_tool_call(&fixture, &lead, &live, "b1", "kybern_coordinator_propose_brief", json!({ "text": "Draft: ship the importer." }));
    let card = secret_card(&live).await;
    let (request, _) = fixture.store.approval_get(card).unwrap().unwrap();
    assert_eq!(request.tool_name, COORDINATOR_BRIEF_TOOL);
    assert!(request.is_user_input());
    assert_eq!(request.summary, "Save this as the project brief?");
    assert_eq!(
        serde_json::from_value::<BriefProposalInput>(request.input.clone()).unwrap(),
        BriefProposalInput { text: "Draft: ship the importer.".into(), replaces: false }
    );

    // Only a non-empty wording of up to 16 KiB is an answer.
    for bad in [
        ApprovalDecision::AllowOnce,
        ApprovalDecision::Submit { response: json!({}) },
        ApprovalDecision::Submit { response: json!({ "text": "   " }) },
        ApprovalDecision::Submit { response: json!({ "text": "x".repeat(MAX_BRIEF_BYTES + 1) }) },
    ] {
        assert!(fixture.orchestrator.respond_approval(card, bad).await.is_err());
    }
    assert!(!call.is_finished());
    assert!(
        fixture.store.note_for_project_role(fixture.project.id, ProjectNoteRole::Brief).unwrap().is_none(),
        "nothing is saved before the user answers"
    );

    fixture
        .orchestrator
        .respond_approval(card, ApprovalDecision::Submit { response: json!({ "text": "  Ship the importer, and propose first.  " }) })
        .await
        .unwrap();
    let result = call.await.unwrap().unwrap();
    assert_eq!(result, json!({ "status": "saved", "text": "Ship the importer, and propose first.", "edited": true }));
    let brief = fixture.store.note_for_project_role(fixture.project.id, ProjectNoteRole::Brief).unwrap().expect("the brief");
    assert_eq!(brief.body, "Ship the importer, and propose first.");
    assert!(brief.summary.pinned && brief.summary.created_by_thread.is_none(), "the brief is the user's own");
    assert_eq!(*live.brief_revision.lock().await, Some(brief.summary.revision), "the lead is not told about its own save");
    assert_eq!(fixture.store.thread_get(lead.id).unwrap().unwrap().status, ThreadStatus::Running);

    // A second proposal replaces it; declining changes nothing.
    let again = start_tool_call(&fixture, &lead, &live, "b2", "kybern_coordinator_propose_brief", json!({ "text": "Second draft." }));
    let card = secret_card(&live).await;
    assert_eq!(fixture.store.approval_get(card).unwrap().unwrap().0.input["replaces"], json!(true));
    fixture.orchestrator.respond_approval(card, ApprovalDecision::Deny { reason: None }).await.unwrap();
    let declined = again.await.unwrap().unwrap();
    assert_eq!(declined["status"], "declined");
    assert_eq!(
        fixture.store.note_for_project_role(fixture.project.id, ProjectNoteRole::Brief).unwrap().unwrap().body,
        "Ship the importer, and propose first."
    );

    // The same proposal again in the same turn is not asked twice: the user's no stands.
    let repeated = fixture.tool(&lead, &live, "b2-repeat", "kybern_coordinator_propose_brief", json!({ "text": "Second draft." })).await.unwrap();
    assert_eq!(repeated["status"], "declined");

    let accepted = start_tool_call(&fixture, &lead, &live, "b3", "kybern_coordinator_propose_brief", json!({ "text": "Third draft." }));
    let card = secret_card(&live).await;
    fixture.orchestrator.respond_approval(card, ApprovalDecision::Submit { response: json!({ "text": "Third draft." }) }).await.unwrap();
    assert_eq!(accepted.await.unwrap().unwrap(), json!({ "status": "saved", "text": "Third draft.", "edited": false }));
    let brief = fixture.store.note_for_project_role(fixture.project.id, ProjectNoteRole::Brief).unwrap().unwrap();
    assert_eq!((brief.body.as_str(), brief.summary.revision), ("Third draft.", 2));

    // Bad proposals fail before any card, and only a Coordinator has the tool.
    for text in ["   ".to_string(), "y".repeat(MAX_BRIEF_BYTES + 1)] {
        let error = fixture.tool(&lead, &live, "bad", "kybern_coordinator_propose_brief", json!({ "text": text })).await.unwrap_err().to_string();
        assert!(error.contains("brief"), "{error}");
    }
    let (worker, worker_live) = fixture.tool_thread(PermissionMode::FullAccess).await;
    let refused = fixture.tool(&worker, &worker_live, "w", "kybern_coordinator_propose_brief", json!({ "text": "x" })).await.unwrap_err().to_string();
    assert!(refused.contains("only for a project's Coordinator"), "{refused}");
}

#[tokio::test]
async fn a_retried_proposal_keeps_waiting_on_the_same_card_and_the_answer_is_spent_once() {
    let fixture = Fixture::new();
    std::fs::create_dir_all(&fixture.root).unwrap();
    let (lead, live) = lead_tool_thread(&fixture).await;
    let first = start_tool_call(&fixture, &lead, &live, "r1", "kybern_coordinator_propose_brief", json!({ "text": "Same text." }));
    let card = secret_card(&live).await;
    let second = start_tool_call(&fixture, &lead, &live, "r2", "kybern_coordinator_propose_brief", json!({ "text": "Same text." }));
    tokio::task::yield_now().await;
    assert_eq!(fixture.store.approvals_pending(Some(lead.id)).unwrap().len(), 1, "one card for identical proposals");
    fixture.orchestrator.respond_approval(card, ApprovalDecision::Submit { response: json!({ "text": "Same text." }) }).await.unwrap();
    // The first call takes the answer; the second asks again with its own card, which the test declines.
    let card_two = loop {
        if let Some(id) = live.daemon_approvals.lock().await.iter().find(|(_, entry)| entry.decision.borrow().is_none()).map(|(id, _)| *id) {
            break id;
        }
        if first.is_finished() && second.is_finished() {
            break card;
        }
        tokio::task::yield_now().await;
    };
    if card_two != card {
        fixture.orchestrator.respond_approval(card_two, ApprovalDecision::Deny { reason: None }).await.unwrap();
    }
    let results = [first.await.unwrap().unwrap(), second.await.unwrap().unwrap()];
    assert_eq!(results.iter().filter(|result| result["status"] == "saved").count(), 1, "the answer is spent once: {results:?}");
}

fn settings_args(extra: serde_json::Value) -> serde_json::Value {
    json!({ "changes": extra, "reason": "You said to move fast." })
}

async fn lead_delegating() -> Delegating {
    let t = Delegating::new().await;
    t.fixture.store.thread_set_relationships(t.parent.id, None, Some(t.fixture.project.id)).unwrap();
    t
}

fn start_lead_tool(
    t: &Delegating,
    call: &'static str,
    name: &'static str,
    args: serde_json::Value,
) -> tokio::task::JoinHandle<anyhow::Result<serde_json::Value>> {
    start_tool_call(&t.fixture, &t.parent, &t.live, call, name, args)
}

fn project_overrides(fixture: &Fixture) -> Option<CoordinatorOverrides> {
    fixture.store.project_get(fixture.project.id).unwrap().unwrap().coordinator
}

#[tokio::test]
async fn the_settings_card_lists_old_and_new_and_applies_only_the_rows_the_user_keeps() {
    let t = lead_delegating().await;
    let changes = json!({
        "lead_autonomy": "act",
        "lead_workspace": "worktree",
        "lead_push_without_asking": false,
        "role_defaults": { "research": { "provider": "claude-code", "model": "sonnet" } }
    });
    let call = start_lead_tool(&t, "s1", "kybern_coordinator_propose_settings", settings_args(changes));
    let card = secret_card(&t.live).await;
    let (request, _) = t.fixture.store.approval_get(card).unwrap().unwrap();
    assert_eq!(request.tool_name, COORDINATOR_SETTINGS_TOOL);
    assert!(request.is_user_input());
    assert_eq!(request.summary, "Apply these Coordinator settings?");
    let input: SettingsProposalInput = serde_json::from_value(request.input.clone()).unwrap();
    assert_eq!(input.reason, "You said to move fast.");
    let paths: Vec<&str> = input.changes.iter().map(|change| change.path.as_str()).collect();
    assert_eq!(paths, ["lead_autonomy", "lead_workspace", "role_defaults.research"], "a field that already has that value is not a row");
    assert_eq!((&input.changes[0].old, &input.changes[0].new), (&json!("propose_large"), &json!("act")));
    assert_eq!((&input.changes[1].old, &input.changes[1].new), (&json!("shared"), &json!("worktree")));
    assert_eq!(input.changes[2].old, json!(null));
    assert_eq!(input.changes[2].new, json!({ "provider": { "kind": "claude-code", "instance": "default" }, "model": "sonnet" }));

    // Only ticked rows from the card are an answer.
    for bad in [
        ApprovalDecision::AllowOnce,
        ApprovalDecision::Submit { response: json!({}) },
        ApprovalDecision::Submit { response: json!({ "accepted": [] }) },
        ApprovalDecision::Submit { response: json!({ "accepted": ["lead_push_without_asking"] }) },
        ApprovalDecision::Submit { response: json!({ "accepted": ["lead_autonomy", "lead_max_children"] }) },
    ] {
        assert!(t.fixture.orchestrator.respond_approval(card, bad).await.is_err());
    }
    assert!(project_overrides(&t.fixture).is_none(), "nothing applies before the answer");

    t.fixture
        .orchestrator
        .respond_approval(card, ApprovalDecision::Submit { response: json!({ "accepted": ["lead_autonomy", "role_defaults.research"] }) })
        .await
        .unwrap();
    let result = call.await.unwrap().unwrap();
    assert_eq!(result["status"], "applied");
    assert_eq!(result["applied"], json!(["lead_autonomy", "role_defaults.research"]));
    assert_eq!(result["skipped"], json!(["lead_workspace"]));
    let saved = project_overrides(&t.fixture).expect("the project override");
    assert_eq!(saved.lead_autonomy, Some(LeadAutonomy::Act));
    assert_eq!(saved.lead_workspace, None, "the unticked row was not applied");
    assert_eq!(saved.role_defaults.get(&DelegationRole::Research), Some(&role_default(ProviderKind::ClaudeCode, "sonnet")));
    // The global settings are untouched.
    assert_eq!(t.fixture.orchestrator.inner.settings.get().orchestration.lead_autonomy, LeadAutonomy::ProposeLarge);

    // Proposing what is already in force asks nobody.
    let same = t.tool("kybern_coordinator_propose_settings", settings_args(json!({ "lead_autonomy": "act" }))).await.unwrap();
    assert_eq!(same["status"], "unchanged");
    assert!(t.fixture.store.approvals_pending(Some(t.parent.id)).unwrap().is_empty());

    // Declining leaves the override as it is.
    let declined = start_lead_tool(&t, "s2", "kybern_coordinator_propose_settings", settings_args(json!({ "lead_max_children": 3 })));
    let card = secret_card(&t.live).await;
    t.fixture.orchestrator.respond_approval(card, ApprovalDecision::Deny { reason: None }).await.unwrap();
    assert_eq!(declined.await.unwrap().unwrap()["status"], "declined");
    assert_eq!(project_overrides(&t.fixture), Some(saved));
}

#[tokio::test]
async fn settings_proposals_reject_what_cannot_be_applied_before_asking() {
    let t = lead_delegating().await;
    for (changes, expected) in [
        (json!({ "role_defaults": { "general": { "provider": "codex" } } }), "general role"),
        (json!({ "role_defaults": { "research": { "model": "sonnet" } } }), "without a provider"),
        (json!({ "role_defaults": { "research": {} } }), "is empty"),
        (json!({ "lead_max_children": 99 }), "between 1 and 16"),
        (json!({ "lead_autonomy": "reckless" }), "unknown variant"),
        (json!({ "something_else": true }), "unknown field"),
    ] {
        let error = t.tool("kybern_coordinator_propose_settings", settings_args(changes.clone())).await.unwrap_err().to_string();
        assert!(error.contains(expected), "{changes}: {error}");
    }
    let no_reason =
        t.tool("kybern_coordinator_propose_settings", json!({ "changes": { "lead_autonomy": "act" }, "reason": "  " })).await.unwrap_err().to_string();
    assert!(no_reason.contains("why"), "{no_reason}");
    assert!(t.fixture.store.approvals_pending(Some(t.parent.id)).unwrap().is_empty(), "no card for an invalid proposal");
    assert!(project_overrides(&t.fixture).is_none());
}

fn role_default(kind: ProviderKind, model: &str) -> RoleDefault {
    RoleDefault { provider: Some(ProviderInstance::default_for(kind)), model: Some(model.into()), effort: None }
}

fn set_global_role_defaults(t: &Delegating, defaults: &[(DelegationRole, RoleDefault)]) {
    let mut settings = t.fixture.orchestrator.inner.settings.get();
    settings.orchestration.role_defaults = defaults.iter().cloned().collect();
    t.fixture.orchestrator.inner.settings.set(settings).unwrap();
}

#[tokio::test]
async fn a_coordinator_child_gets_its_roles_default_and_overriding_it_needs_a_recorded_reason() {
    let t = lead_delegating().await;
    set_global_role_defaults(&t, &[(DelegationRole::Research, role_default(ProviderKind::Codex, "fast-model"))]);

    // Omitted harness and model: the default for the role.
    let defaulted = t.delegate(json!({ "task": "map the importer", "role": "research" })).await;
    let child = t.delegation(&defaulted["task_id"]);
    assert_eq!((child.provider.kind, child.model.as_deref()), (ProviderKind::Codex, Some("fast-model")));
    assert_eq!(child.delegation.as_ref().unwrap().default_override, None);

    // A role without a default follows the Coordinator, as before.
    let plain = t.delegate(json!({ "task": "write the parser", "role": "implementation" })).await;
    assert_eq!(t.delegation(&plain["task_id"]).provider.kind, ProviderKind::ClaudeCode);

    // Asking for exactly the default needs no reason.
    t.delegate(json!({ "task": "same thing", "role": "research", "provider": "codex", "model": "fast-model" })).await;

    // Another harness or another model needs one, and the error says what to do.
    for args in [
        json!({ "task": "use claude", "role": "research", "provider": "claude-code", "model": "opus" }),
        json!({ "task": "other model", "role": "research", "model": "slow-model" }),
    ] {
        let error = t.tool("kybern_agent_delegate", args).await.unwrap_err().to_string();
        assert!(error.contains("override_reason") && error.contains("codex / fast-model"), "{error}");
    }
    let overridden = t
        .delegate(json!({
            "task": "use claude", "role": "research", "provider": "claude-code", "model": "opus",
            "override_reason": "  Needs deeper reasoning.  "
        }))
        .await;
    let child = t.delegation(&overridden["task_id"]);
    assert_eq!((child.provider.kind, child.model.as_deref()), (ProviderKind::ClaudeCode, Some("opus")));
    assert_eq!(
        child.delegation.as_ref().unwrap().default_override,
        Some(DefaultOverride {
            provider: ProviderInstance::default_for(ProviderKind::Codex),
            model: Some("fast-model".into()),
            reason: "Needs deeper reasoning.".into()
        })
    );
    // A different model on the default harness is an override too, and the model stays the Coordinator's pick.
    let model_only = t.delegate(json!({ "task": "other model", "role": "research", "model": "slow-model", "override_reason": "Large codebase." })).await;
    let child = t.delegation(&model_only["task_id"]);
    assert_eq!((child.provider.kind, child.model.as_deref()), (ProviderKind::Codex, Some("slow-model")));
    assert_eq!(child.delegation.as_ref().unwrap().default_override.as_ref().unwrap().reason, "Large codebase.");
}

#[tokio::test]
async fn a_project_override_beats_the_global_default_and_ordinary_threads_ignore_defaults() {
    let t = lead_delegating().await;
    set_global_role_defaults(&t, &[(DelegationRole::Review, role_default(ProviderKind::Codex, "global-review"))]);
    let mut project = t.fixture.store.project_get(t.fixture.project.id).unwrap().unwrap();
    project.coordinator = Some(CoordinatorOverrides {
        role_defaults: [(DelegationRole::Review, role_default(ProviderKind::ClaudeCode, "project-review"))].into_iter().collect(),
        lead_workspace: Some(DelegationWorkspace::Worktree),
        ..Default::default()
    });
    t.fixture.store.project_update(&project).unwrap();

    let review = t.delegate(json!({ "task": "review the diff", "role": "review" })).await;
    let child = t.delegation(&review["task_id"]);
    assert_eq!((child.provider.kind, child.model.as_deref()), (ProviderKind::ClaudeCode, Some("project-review")));

    // The workspace default is the project's, and falls back to shared where there is no repository to branch from.
    assert_eq!(child.delegation.as_ref().unwrap().workspace, DelegationWorkspace::Shared);
    let explicit = t.tool("kybern_agent_delegate", json!({ "task": "own tree", "workspace": "worktree" })).await.unwrap_err().to_string();
    assert!(explicit.contains("needs a git repository"), "an explicit request is still refused: {explicit}");

    // Remove the project override: the global default comes back.
    project.coordinator = None;
    t.fixture.store.project_update(&project).unwrap();
    let back = t.delegate(json!({ "task": "review again", "role": "review" })).await;
    assert_eq!(t.delegation(&back["task_id"]).model.as_deref(), Some("global-review"));

    // A thread that is not a Coordinator never gets role defaults.
    t.fixture.store.thread_set_relationships(t.parent.id, None, None).unwrap();
    let ordinary = t.delegate(json!({ "task": "review once more", "role": "review" })).await;
    assert_eq!(t.delegation(&ordinary["task_id"]).provider.kind, ProviderKind::ClaudeCode);
    assert_eq!(t.delegation(&ordinary["task_id"]).delegation.as_ref().unwrap().default_override, None);
}

#[tokio::test]
async fn the_leads_capabilities_show_its_defaults_and_its_child_limit_follows_the_project() {
    let t = lead_delegating().await;
    set_global_role_defaults(&t, &[(DelegationRole::Test, role_default(ProviderKind::Codex, "tester"))]);
    let capabilities = t.tool("kybern_agent_capabilities", json!({})).await.unwrap();
    assert_eq!(capabilities["coordinator"]["role_defaults"]["test"]["model"], "tester");
    assert_eq!(capabilities["coordinator"]["autonomy"], "propose_large");
    assert_eq!(capabilities["coordinator"]["workspace"], "shared");

    let mut project = t.fixture.store.project_get(t.fixture.project.id).unwrap().unwrap();
    project.coordinator = Some(CoordinatorOverrides { lead_max_children: Some(1), ..Default::default() });
    t.fixture.store.project_update(&project).unwrap();
    t.delegate(json!({ "task": "one" })).await;
    let error = t.tool("kybern_agent_delegate", json!({ "task": "two" })).await.unwrap_err().to_string();
    assert!(error.contains("(max 1)"), "the project's limit applies: {error}");
}

#[tokio::test]
async fn the_lead_instructions_state_the_effective_autonomy_workspace_and_vcs_rule_and_only_a_lead_gets_the_proposal_tools() {
    let (fixture, bridges) = lead_capture_fixture();
    user_note(&fixture, "Project brief", "Be careful.", Some(ProjectNoteRole::Brief));
    let mut settings = fixture.orchestrator.inner.settings.get();
    settings.orchestration.lead_autonomy = LeadAutonomy::ProposeFirst;
    fixture.orchestrator.inner.settings.set(settings).unwrap();
    let lead = fixture.orchestrator.coordinator_open(open_params(&fixture.project, ProviderKind::ClaudeCode, None)).await.unwrap().thread;

    let bridge = spawn_bridge(&fixture, &bridges, &lead).await;
    let text = bridge.coordinator_instructions.clone().unwrap();
    assert!(text.starts_with(LEAD_ROLE_FOR_TESTS));
    assert!(text.contains("Autonomy: propose first."), "{text}");
    assert!(text.contains("Children work in the shared checkout unless you pass workspace."), "{text}");
    assert!(text.contains(super::lead::LEAD_GIT_LINE), "{text}");
    assert!(text.contains("propose the edit with kybern_coordinator_propose_brief"), "{text}");
    for tool in ["kybern_coordinator_propose_brief", "kybern_coordinator_propose_settings"] {
        assert!(bridge.has_tool(tool), "{tool}");
        assert!(bridge.restrictions.permits(tool), "{tool}");
    }

    // The project override wins, and the next session says so.
    let mut project = fixture.store.project_get(fixture.project.id).unwrap().unwrap();
    project.coordinator = Some(CoordinatorOverrides {
        lead_autonomy: Some(LeadAutonomy::Act),
        lead_workspace: Some(DelegationWorkspace::Worktree),
        ..Default::default()
    });
    fixture.store.project_update(&project).unwrap();
    let again = spawn_bridge(&fixture, &bridges, &lead).await.coordinator_instructions.unwrap();
    assert!(again.contains("Autonomy: act.") && !again.contains("Autonomy: propose first."), "{again}");
    assert!(again.contains("Children get their own worktree unless you pass workspace."), "{again}");

    let stranger = fixture.thread(ThreadStatus::Idle);
    let ordinary = spawn_bridge(&fixture, &bridges, &stranger).await;
    for tool in ["kybern_coordinator_propose_brief", "kybern_coordinator_propose_settings"] {
        assert!(!ordinary.has_tool(tool), "{tool} is the Coordinator's alone");
    }
}

#[tokio::test]
async fn changed_settings_are_announced_once_in_the_providers_copy_of_the_leads_next_message() {
    let (fixture, spawned) = scripted_lead_fixture();
    user_note(&fixture, "Project brief", "Be careful.", Some(ProjectNoteRole::Brief));
    let lead = fixture.orchestrator.coordinator_open(open_params(&fixture.project, ProviderKind::ClaudeCode, None)).await.unwrap().thread;
    fixture.orchestrator.send(lead.id, UserMessage::text("first request")).await.unwrap();
    let agent = eventually(|| async { spawned.lock().unwrap().first().cloned() }).await;
    assert_eq!(sent_to(&agent, 1).await[0].parts.len(), 1, "nothing changed yet");
    end_turn(&fixture, lead.id).await;

    // The user changes the project's autonomy and the global push setting mid-session.
    let mut project = fixture.store.project_get(fixture.project.id).unwrap().unwrap();
    project.coordinator = Some(CoordinatorOverrides { lead_autonomy: Some(LeadAutonomy::ProposeFirst), ..Default::default() });
    fixture.store.project_update(&project).unwrap();
    let mut settings = fixture.orchestrator.inner.settings.get();
    settings.orchestration.lead_push_without_asking = true;
    fixture.orchestrator.inner.settings.set(settings).unwrap();

    fixture.orchestrator.send(lead.id, UserMessage::text("second request")).await.unwrap();
    let second = sent_to(&agent, 2).await[1].clone();
    let ContentPart::Text { text } = &second.parts[0] else { panic!("the notice leads the message: {second:?}") };
    assert_eq!(
        text.trim(),
        "Coordinator settings changed: autonomy is now Propose first; pushing and opening pull requests no longer asks the user."
    );
    assert!(matches!(&second.parts[1], ContentPart::Text { text } if text == "second request"));
    let stored = serde_json::to_string(&fixture.store.events_for_thread(lead.id).unwrap()).unwrap();
    assert!(!stored.contains("Coordinator settings changed"), "the notice is not part of the user's message");

    end_turn(&fixture, lead.id).await;
    fixture.orchestrator.send(lead.id, UserMessage::text("third request")).await.unwrap();
    let third = sent_to(&agent, 3).await[2].clone();
    assert_eq!(third.parts.len(), 1, "announced once: {third:?}");
}

#[test]
fn settings_notices_name_only_what_changed() {
    use super::lead::settings_change_text;
    let base = OrchestrationSettings::default().effective_for(None);
    assert_eq!(settings_change_text(&base, &base), None);
    let mut changed = base.clone();
    changed.lead_workspace = DelegationWorkspace::Worktree;
    changed.lead_max_children = 3;
    changed.role_defaults.insert(DelegationRole::Design, role_default(ProviderKind::Codex, "pretty"));
    assert_eq!(
        settings_change_text(&base, &changed).unwrap(),
        "Coordinator settings changed: children now get their own worktree by default; you may run 3 agents at once; the default models per kind of work changed (see kybern_agent_capabilities)."
    );
}
