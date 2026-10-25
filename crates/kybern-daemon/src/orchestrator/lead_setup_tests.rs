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

// ---- notes as history: categories, supersedes, stale flags, the index, tidy ----

use methods::{NoteCategory, NotesTidyParams};

fn git_run(dir: &std::path::Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"])
        .args(args)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

/// Make the fixture's project a git repository with six source files; returns the first commit.
fn init_git_project(fixture: &Fixture) -> String {
    std::fs::create_dir_all(fixture.root.join("src")).unwrap();
    for file in ["a", "b", "c", "d", "e", "f"] {
        std::fs::write(fixture.root.join(format!("src/{file}.ts")), "1").unwrap();
    }
    git_run(&fixture.root, &["init", "-q", "-b", "main"]);
    git_run(&fixture.root, &["add", "src"]);
    git_run(&fixture.root, &["commit", "-q", "-m", "first"]);
    let mut project = fixture.project.clone();
    project.is_git = true;
    fixture.store.project_update(&project).unwrap();
    git_run(&fixture.root, &["rev-parse", "--short", "HEAD"])
}

/// Change the given source files in a new commit.
fn change_files(fixture: &Fixture, files: &[&str]) {
    for file in files {
        std::fs::write(fixture.root.join(format!("src/{file}.ts")), "2").unwrap();
    }
    git_run(&fixture.root, &["commit", "-qam", "change"]);
}

/// A Coordinator thread whose writes need no approval card.
async fn full_access_lead(fixture: &Fixture) -> (Thread, Arc<LiveSession>) {
    let thread = fixture.thread(ThreadStatus::Idle);
    fixture.store.thread_set_relationships(thread.id, None, Some(fixture.project.id)).unwrap();
    let mut thread = fixture.store.thread_get(thread.id).unwrap().unwrap();
    thread.permission_mode = PermissionMode::FullAccess;
    fixture.store.thread_upsert(&thread).unwrap();
    let (live, _) = fixture.active_app_tool_session(&thread).await;
    (thread, live)
}

fn claim_note(fixture: &Fixture, title: &str, sha: &str, file: &str) -> methods::Note {
    user_note(fixture, title, &format!("- 2026-10-25 · As of `{sha}`: it works (`src/{file}.ts`)."), None)
}

#[tokio::test]
async fn agents_file_categorized_claims_retire_lines_with_supersedes_and_cannot_rewrite_history_notes() {
    let fixture = Fixture::new();
    std::fs::create_dir_all(&fixture.root).unwrap();
    let (lead, live) = full_access_lead(&fixture).await;
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();

    let created = fixture
        .tool(&lead, &live, "c1", "kybern_note_create", json!({"title": "Auth decisions", "body": "- first claim\n- second claim", "category": "decision"}))
        .await
        .unwrap();
    assert_eq!(created["category"], "decision");
    let id: methods::NoteId = serde_json::from_value(created["id"].clone()).unwrap();
    assert_eq!(fixture.store.note_get(id).unwrap().unwrap().summary.category, Some(NoteCategory::Decision));

    // Supersede: one match retires that line with today's date and appends the new claim.
    fixture
        .tool(&lead, &live, "a1", "kybern_note_append", json!({"note_id": id, "text": "- third claim", "supersedes": "first claim"}))
        .await
        .unwrap();
    let body = fixture.store.note_get(id).unwrap().unwrap().body;
    assert_eq!(body, format!("- ~~first claim~~ (superseded {today})\n- second claim\n\n- third claim"));

    // No match, several matches, a line already retired: nothing changes and the error says what to do.
    let none = fixture.tool(&lead, &live, "a2", "kybern_note_append", json!({"note_id": id, "text": "x", "supersedes": "missing"})).await.unwrap_err();
    assert!(none.to_string().contains("No line of the note contains that text") && none.to_string().contains("kybern_note_read"), "{none}");
    let many = fixture.tool(&lead, &live, "a3", "kybern_note_append", json!({"note_id": id, "text": "x", "supersedes": "claim"})).await.unwrap_err();
    assert!(many.to_string().contains("2 lines of the note contain that text"), "{many}");
    let again = fixture.tool(&lead, &live, "a4", "kybern_note_append", json!({"note_id": id, "text": "x", "supersedes": "first claim"})).await.unwrap_err();
    assert!(again.to_string().contains("already superseded"), "{again}");
    assert_eq!(fixture.store.note_get(id).unwrap().unwrap().body, body, "a refused supersede changes nothing");

    // Decision and gotcha notes are history: no body rewrite, even by their author; titles stay editable.
    let revision = fixture.store.note_get(id).unwrap().unwrap().summary.revision;
    let refused = fixture.tool(&lead, &live, "u1", "kybern_note_update", json!({"note_id": id, "body": "rewritten", "expected_revision": revision})).await.unwrap_err();
    assert_eq!(refused.to_string(), "Add a dated claim with kybern_note_append instead; use supersedes to retire the old one.");
    fixture.tool(&lead, &live, "u2", "kybern_note_update", json!({"note_id": id, "title": "Auth log", "expected_revision": revision})).await.unwrap();
    let gotcha = fixture.tool(&lead, &live, "c2", "kybern_note_create", json!({"title": "Traps", "body": "a", "category": "gotcha"})).await.unwrap();
    let gotcha_id: methods::NoteId = serde_json::from_value(gotcha["id"].clone()).unwrap();
    assert!(fixture.tool(&lead, &live, "u3", "kybern_note_update", json!({"note_id": gotcha_id, "body": "b", "expected_revision": 1})).await.is_err());
    // A convention note keeps the old rule: its author may rewrite it.
    let convention = fixture.tool(&lead, &live, "c3", "kybern_note_create", json!({"title": "Style", "body": "a", "category": "convention"})).await.unwrap();
    let convention_id: methods::NoteId = serde_json::from_value(convention["id"].clone()).unwrap();
    fixture.tool(&lead, &live, "u4", "kybern_note_update", json!({"note_id": convention_id, "body": "b", "expected_revision": 1})).await.unwrap();

    // Appending sets a missing category, and refuses a different one.
    let plain = fixture.tool(&lead, &live, "c4", "kybern_note_create", json!({"title": "Plain", "body": "a"})).await.unwrap();
    let plain_id: methods::NoteId = serde_json::from_value(plain["id"].clone()).unwrap();
    let set = fixture.tool(&lead, &live, "a5", "kybern_note_append", json!({"note_id": plain_id, "text": "b", "category": "preference"})).await.unwrap();
    assert_eq!(set["category"], "preference");
    let clash = fixture.tool(&lead, &live, "a6", "kybern_note_append", json!({"note_id": plain_id, "text": "c", "category": "gotcha"})).await.unwrap_err();
    assert!(clash.to_string().contains("preference note") && clash.to_string().contains("kybern_note_create"), "{clash}");
    assert!(fixture.tool(&lead, &live, "c5", "kybern_note_create", json!({"title": "S", "body": "x", "project_role": "setup", "category": "gotcha"})).await.is_err());

    // The user's own note stays append-only for agents, categories included.
    let theirs = user_note(&fixture, "User memo", "- keep this", None);
    assert!(fixture.tool(&lead, &live, "m1", "kybern_note_update", json!({"note_id": theirs.summary.id, "body": "x", "expected_revision": 1})).await.is_err());
    fixture
        .tool(&lead, &live, "m2", "kybern_note_append", json!({"note_id": theirs.summary.id, "text": "- new line", "supersedes": "keep this", "category": "preference"}))
        .await
        .unwrap();
    let theirs = fixture.store.note_get(theirs.summary.id).unwrap().unwrap();
    assert_eq!(theirs.summary.category, Some(NoteCategory::Preference));
    assert!(theirs.body.starts_with("- ~~keep this~~ (superseded "), "{}", theirs.body);
}

#[tokio::test]
async fn the_index_groups_notes_by_category_and_labels_outdated_and_undated_ones() {
    let (fixture, bridges) = lead_capture_fixture();
    let first = init_git_project(&fixture);
    let create = |title: &str, body: &str, category| {
        fixture.store.note_create_categorized(NoteScope::Project, Some(fixture.project.id), title, body, None, category).unwrap()
    };
    create("Likes", "- user wants small PRs", Some(NoteCategory::Preference));
    create("Reversals", &format!("- 2026-10-25 · As of `{first}`: guard removed (`src/a.ts`)."), Some(NoteCategory::Decision));
    create("Style", "- tabs", Some(NoteCategory::Convention));
    create("Traps", "- flaky test", Some(NoteCategory::Gotcha));
    // Written before categories existed: undated. Written after: Other.
    create("Old memo", "- from before", None);
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    fixture.store.meta_set("notes_history_since", &chrono::Utc::now().to_rfc3339()).unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    create("Fresh memo", "- from after", None);
    change_files(&fixture, &["a"]);

    let lead = fixture.orchestrator.coordinator_open(open_params(&fixture.project, ProviderKind::ClaudeCode, Some("Plan first."))).await.unwrap().thread;
    let bridge = spawn_bridge(&fixture, &bridges, &lead).await;
    let text = bridge.coordinator_instructions.clone().unwrap();
    let at = |needle: &str| text.find(needle).unwrap_or_else(|| panic!("{needle:?} missing from {text}"));
    let order = ["\nPreferences:\n", "\nDecisions:\n", "\nConventions:\n", "\nGotchas:\n", "\nOther:\n", "\nUndated:\n"].map(at);
    assert!(order.windows(2).all(|pair| pair[0] < pair[1]), "groups in order: {text}");

    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let line = |title: &str| text.lines().find(|line| line.starts_with(&format!("- {title}: "))).unwrap_or_else(|| panic!("{title}: {text}")).to_owned();
    let likes = line("Likes");
    assert!(likes.starts_with("- Likes: user wants small PRs (") && likes.ends_with(&format!(") · {today}")), "{likes}");
    assert!(line("Reversals").ends_with(" · may be outdated: src/a.ts"), "{}", line("Reversals"));
    assert!(line("Old memo").ends_with(&format!(" · undated, before {today}")), "{}", line("Old memo"));
    assert!(!line("Fresh memo").contains("undated") && !line("Style").contains("outdated"));
    assert!(text.find("- Fresh memo").unwrap() < text.find("\nUndated:\n").unwrap(), "after-categories notes are Other");
}

#[tokio::test]
async fn the_index_keeps_its_forty_note_cap_and_the_hundred_character_first_line() {
    let (fixture, bridges) = lead_capture_fixture();
    for index in 0..42 {
        fixture.store.note_create(NoteScope::Project, Some(fixture.project.id), &format!("Note {index:02}"), &"x".repeat(150)).unwrap();
    }
    let lead = fixture.orchestrator.coordinator_open(open_params(&fixture.project, ProviderKind::ClaudeCode, Some("Plan."))).await.unwrap().thread;
    let text = spawn_bridge(&fixture, &bridges, &lead).await.coordinator_instructions.clone().unwrap();
    assert_eq!(text.lines().filter(|line| line.starts_with("- Note ")).count(), 40, "{text}");
    assert!(text.contains("(2 more; find them with kybern_notes_search.)"));
    let line = text.lines().find(|line| line.starts_with("- Note ")).unwrap();
    assert!(line.contains(&format!(": {}… (", "x".repeat(100))), "{line}");
}

#[tokio::test]
async fn stale_flags_reach_summaries_and_five_stale_notes_raise_a_tidy_offer_that_snoozes_for_a_week() {
    let fixture = Fixture::new();
    let first = init_git_project(&fixture);
    let project = NotesTidyParams { project_id: fixture.project.id };
    let flagged: Vec<_> = ["a", "b", "c", "d", "e"].iter().map(|file| claim_note(&fixture, &format!("Claim {file}"), &first, file)).collect();
    let fresh = claim_note(&fixture, "Claim f", &first, "f");

    // Nothing changed yet: no flags, no offer.
    assert!(fixture.orchestrator.notes_list().unwrap().iter().all(|note| note.stale.is_none()));
    assert!(!fixture.orchestrator.notes_tidy_offer(project.clone()).unwrap().offer);

    // Four stale notes are below the threshold.
    change_files(&fixture, &["a", "b", "c", "d"]);
    let offer = fixture.orchestrator.notes_tidy_offer(project.clone()).unwrap();
    assert_eq!((offer.stale.len(), offer.offer), (4, false));

    // The fifth raises the card. The summaries name the changed file and its commit.
    change_files(&fixture, &["e"]);
    let offer = fixture.orchestrator.notes_tidy_offer(project.clone()).unwrap();
    assert_eq!((offer.stale.len(), offer.offer, offer.snoozed_until), (5, true, None));
    assert!(!offer.stale.contains(&fresh.summary.id));
    let head = git_run(&fixture.root, &["rev-parse", "--short", "HEAD"]);
    let listed = fixture.orchestrator.notes_list().unwrap();
    let stale = listed.iter().find(|note| note.id == flagged[4].summary.id).unwrap().stale.clone().expect("flagged");
    assert_eq!((stale.path.as_str(), stale.commit.as_str()), ("src/e.ts", head.as_str()));
    assert!(listed.iter().find(|note| note.id == fresh.summary.id).unwrap().stale.is_none());
    let got = fixture.orchestrator.note_get(methods::NotesGetParams { id: Some(flagged[0].summary.id), thread_id: None }).unwrap().unwrap();
    assert_eq!(got.summary.stale.map(|stale| stale.path), Some("src/a.ts".into()));

    // "Not now": quiet for seven days, then back.
    let snoozed = fixture.orchestrator.notes_tidy_snooze(project.clone()).unwrap();
    assert!(!snoozed.offer && snoozed.stale.len() == 5);
    let until = snoozed.snoozed_until.expect("snoozed");
    let days = (until - chrono::Utc::now()).num_hours();
    assert!((166..=168).contains(&days), "about seven days: {days} h");
    fixture.store.meta_set(&format!("notes_tidy_snooze:{}", fixture.project.id), &(chrono::Utc::now() - chrono::Duration::seconds(1)).to_rfc3339()).unwrap();
    let back = fixture.orchestrator.notes_tidy_offer(project).unwrap();
    assert!(back.offer && back.snoozed_until.is_none());
}

#[tokio::test]
async fn tidy_notes_sends_the_lead_a_row_for_clients_and_the_instructions_for_the_provider_only() {
    let (fixture, spawned) = scripted_lead_fixture();
    let first = init_git_project(&fixture);
    user_note(&fixture, "Project brief", "Ship it.", Some(ProjectNoteRole::Brief));
    let params = NotesTidyParams { project_id: fixture.project.id };

    // Without a Coordinator, or without flagged notes, there is nothing to ask.
    let error = fixture.orchestrator.notes_tidy_start(params.clone()).await.unwrap_err().to_string();
    assert!(error.contains("Coordinator"), "{error}");
    let lead = fixture.orchestrator.coordinator_open(open_params(&fixture.project, ProviderKind::ClaudeCode, None)).await.unwrap().thread;
    let error = fixture.orchestrator.notes_tidy_start(params.clone()).await.unwrap_err().to_string();
    assert!(error.contains("None of this project's notes looks outdated"), "{error}");

    for file in ["a", "b", "c"] {
        claim_note(&fixture, &format!("Claim {file}"), &first, file);
    }
    change_files(&fixture, &["a", "b"]);
    let started = fixture.orchestrator.notes_tidy_start(params.clone()).await.unwrap();
    assert_eq!((started.thread_id, started.notes), (lead.id, 2));

    let stored = started_messages(&fixture, lead.id);
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].parts, vec![ContentPart::SystemRow { kind: SystemRowKind::CoordinatorTidyNotes, text: "Tidy notes".into() }]);
    let agent = eventually(|| async { spawned.lock().unwrap().first().cloned() }).await;
    let text = sent_to(&agent, 1).await[0].plain_text();
    for needed in ["2 notes cite files that changed", "Claim a", "`src/a.ts` changed in", "Claim b", "read-only child", "kybern_coordinator_propose_note_changes", "supersedes"] {
        assert!(text.contains(needed), "{needed}: {text}");
    }
    assert!(!text.contains("Claim c"), "only flagged notes are listed: {text}");
    let events = serde_json::to_string(&fixture.store.events_for_thread(lead.id).unwrap()).unwrap();
    assert!(!events.contains("read-only child"), "the instructions are the provider's copy only");
    // A card that did its job stays away for the week.
    assert!(fixture.orchestrator.notes_tidy_offer(params).unwrap().snoozed_until.is_some());
}

#[tokio::test]
async fn the_note_changes_card_applies_only_the_ticked_rows_as_appends_and_supersedes() {
    let fixture = Fixture::new();
    std::fs::create_dir_all(&fixture.root).unwrap();
    let (lead, live) = lead_tool_thread(&fixture).await;
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let auth = user_note(&fixture, "Auth", "- 2026-10-01 · As of `abc1234`: guard exists (`src/auth.ts`).\n- keep me", None);
    let build = user_note(&fixture, "Build", "- pnpm build", None);
    let brief = user_note(&fixture, "Project brief", "Be careful.", Some(ProjectNoteRole::Brief));

    // Bad proposals fail before any card.
    let tool = |changes: serde_json::Value| fixture.tool(&lead, &live, "bad", "kybern_coordinator_propose_note_changes", json!({"changes": changes, "reason": "r"}));
    let error = tool(json!([{"note_id": brief.summary.id, "text": "x"}])).await.unwrap_err().to_string();
    assert!(error.contains("Change 1") && error.contains("kybern_coordinator_propose_brief"), "{error}");
    let error = tool(json!([{"note_id": auth.summary.id, "text": "x", "supersedes": "no such line"}])).await.unwrap_err().to_string();
    assert!(error.contains("Change 1") && error.contains("No line of the note contains that text"), "{error}");
    assert!(tool(json!([])).await.is_err());
    assert!(tool(json!([{"note_id": uuid::Uuid::now_v7(), "text": "x"}])).await.is_err());

    let call = start_tool_call(
        &fixture,
        &lead,
        &live,
        "n1",
        "kybern_coordinator_propose_note_changes",
        json!({
            "reason": "The guard was removed.",
            "changes": [
                {"note_id": auth.summary.id, "text": "- 2026-10-25 · As of `def5678`: guard removed (`src/auth.ts`).", "supersedes": "guard exists", "category": "decision"},
                {"note_id": build.summary.id, "text": "- 2026-10-25 · yarn is not used."},
            ]
        }),
    );
    let card = secret_card(&live).await;
    let (request, _) = fixture.store.approval_get(card).unwrap().unwrap();
    assert_eq!(request.tool_name, COORDINATOR_NOTES_TOOL);
    assert!(request.is_user_input());
    assert_eq!(request.summary, "Apply 2 note changes?");
    let input: NoteChangesProposalInput = serde_json::from_value(request.input.clone()).unwrap();
    assert_eq!(input.reason, "The guard was removed.");
    assert_eq!(
        input.changes.iter().map(|change| (change.path.as_str(), change.note_title.as_str(), change.op)).collect::<Vec<_>>(),
        vec![("1", "Auth", NoteChangeOp::Supersede), ("2", "Build", NoteChangeOp::Append)]
    );
    assert_eq!(input.changes[0].supersedes.as_deref(), Some("guard exists"));
    assert_eq!(input.changes[0].category, Some(NoteCategory::Decision));

    // Only paths on the card are an answer, and at least one.
    for bad in [json!({}), json!({"accepted": []}), json!({"accepted": ["9"]})] {
        assert!(fixture.orchestrator.respond_approval(card, ApprovalDecision::Submit { response: bad }).await.is_err());
    }
    assert!(!call.is_finished());
    assert_eq!(fixture.store.note_get(auth.summary.id).unwrap().unwrap().body, auth.body, "nothing changes before the answer");

    fixture.orchestrator.respond_approval(card, ApprovalDecision::Submit { response: json!({"accepted": ["1"]}) }).await.unwrap();
    let result = call.await.unwrap().unwrap();
    assert_eq!((result["status"].clone(), result["applied"].clone(), result["skipped"].clone()), (json!("applied"), json!(["1"]), json!(["2"])));
    let auth_after = fixture.store.note_get(auth.summary.id).unwrap().unwrap();
    assert_eq!(
        auth_after.body,
        format!("- ~~2026-10-01 · As of `abc1234`: guard exists (`src/auth.ts`).~~ (superseded {today})\n- keep me\n\n- 2026-10-25 · As of `def5678`: guard removed (`src/auth.ts`).")
    );
    assert_eq!(auth_after.summary.category, Some(NoteCategory::Decision));
    assert_eq!(fixture.store.note_get(build.summary.id).unwrap().unwrap().body, "- pnpm build", "the unticked row was skipped");

    // A decline changes nothing.
    let declined = start_tool_call(
        &fixture,
        &lead,
        &live,
        "n2",
        "kybern_coordinator_propose_note_changes",
        json!({"reason": "r", "changes": [{"note_id": build.summary.id, "text": "- more"}]}),
    );
    let card = secret_card(&live).await;
    fixture.orchestrator.respond_approval(card, ApprovalDecision::Deny { reason: None }).await.unwrap();
    assert_eq!(declined.await.unwrap().unwrap()["status"], "declined");
    assert_eq!(fixture.store.note_get(build.summary.id).unwrap().unwrap().body, "- pnpm build");
}

#[tokio::test]
async fn a_published_note_change_carries_the_known_flag_and_is_corrected_off_the_command_lock() {
    let fixture = Fixture::new();
    let first = init_git_project(&fixture);
    let mut changes = fixture.orchestrator.subscribe_notes();
    let note = claim_note(&fixture, "Claim a", &first, "a");
    change_files(&fixture, &["a"]);

    // An autosave that leaves the claim alone. Nothing checked this note yet, so the
    // first notification has no flag; the background check publishes it again with one.
    let saved = fixture
        .orchestrator
        .note_update(methods::NotesUpdateParams {
            id: Some(note.summary.id),
            thread_id: None,
            expected_revision: note.summary.revision,
            title: None,
            body: Some(format!("{}\nMore prose.", note.body)),
            category: None,
            clear_category: false,
        })
        .unwrap();
    let flagged = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let change = changes.recv().await.unwrap();
            if let Some(summary) = change.note.filter(|summary| summary.id == note.summary.id && summary.revision == saved.summary.revision)
                && summary.stale.is_some()
            {
                return summary;
            }
        }
    })
    .await
    .expect("the corrected flag is published");
    assert_eq!(flagged.stale.unwrap().path, "src/a.ts");

    // The next save of the same claims publishes the flag at once.
    fixture.orchestrator.note_pin(note.summary.id, true).unwrap();
    let pinned = loop {
        let change = changes.recv().await.unwrap();
        if let Some(summary) = change.note.filter(|summary| summary.pinned) {
            break summary;
        }
    };
    assert_eq!(pinned.stale.map(|stale| stale.path).as_deref(), Some("src/a.ts"));
}

#[tokio::test]
async fn agent_note_search_reads_no_git_and_shows_the_flag_a_note_read_found() {
    let fixture = Fixture::new();
    let first = init_git_project(&fixture);
    let (lead, live) = full_access_lead(&fixture).await;
    let note = claim_note(&fixture, "Claim b", &first, "b");
    change_files(&fixture, &["b"]);
    let row = |result: &serde_json::Value| result["notes"].as_array().unwrap().iter().find(|row| row["id"] == json!(note.summary.id)).cloned().unwrap();

    let search = fixture.tool(&lead, &live, "s1", "kybern_notes_search", json!({})).await.unwrap();
    assert_eq!(row(&search)["may_be_outdated"], json!(null), "never checked, and search does not run git");
    let read = fixture.tool(&lead, &live, "r1", "kybern_note_read", json!({"note_id": note.summary.id})).await.unwrap();
    assert_eq!(read["may_be_outdated"]["path"], json!("src/b.ts"));
    let search = fixture.tool(&lead, &live, "s2", "kybern_notes_search", json!({})).await.unwrap();
    assert_eq!(row(&search)["may_be_outdated"]["path"], json!("src/b.ts"));
}

#[tokio::test]
async fn a_notes_category_can_be_cleared_but_not_set_and_cleared_at_once() {
    let fixture = Fixture::new();
    let note =
        fixture.store.note_create_categorized(NoteScope::Project, Some(fixture.project.id), "Style", "- tabs", None, Some(NoteCategory::Convention)).unwrap();
    let update = |category, clear_category| methods::NotesUpdateParams {
        id: Some(note.summary.id),
        thread_id: None,
        expected_revision: note.summary.revision,
        title: None,
        body: None,
        category,
        clear_category,
    };
    let error = fixture.orchestrator.note_update(update(Some(NoteCategory::Gotcha), true)).unwrap_err().to_string();
    assert!(error.contains("not both"), "{error}");
    let cleared = fixture.orchestrator.note_update(update(None, true)).unwrap();
    assert_eq!(cleared.summary.category, None);
    // Leaving both out keeps whatever is there.
    let kept = fixture.orchestrator.note_update(methods::NotesUpdateParams { expected_revision: cleared.summary.revision, ..update(None, false) }).unwrap();
    assert_eq!((kept.summary.category, kept.summary.revision), (None, cleared.summary.revision));
}
