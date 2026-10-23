// `kybern_request_secret` tests. Included into `orchestrator::tests` so they can
// use its fixture and live-session helpers.

/// Every file under `root` whose bytes contain `needle`.
fn files_containing(root: &std::path::Path, needle: &str) -> Vec<std::path::PathBuf> {
    fn walk(dir: &std::path::Path, needle: &[u8], found: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, needle, found);
            } else if let Ok(bytes) = std::fs::read(&path)
                && bytes.windows(needle.len()).any(|window| window == needle)
            {
                found.push(path);
            }
        }
    }
    let mut found = Vec::new();
    walk(root, needle.as_bytes(), &mut found);
    found
}

fn secret_args(extra: serde_json::Value) -> serde_json::Value {
    let mut args = json!({ "label": "Stripe key", "reason": "Run the checkout test", "env_key": "STRIPE_KEY" });
    args.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    args
}

/// Start `kybern_request_secret` in the background, as a harness would.
fn start_secret_call(
    fixture: &Fixture,
    thread: &Thread,
    live: &LiveSession,
    call: &'static str,
    args: serde_json::Value,
) -> tokio::task::JoinHandle<anyhow::Result<serde_json::Value>> {
    let (orchestrator, thread_id, session) = (fixture.orchestrator.clone(), thread.id, live.session_instance_id);
    tokio::spawn(async move { orchestrator.execute_native_app_tool_call(thread_id, session, call, "kybern_request_secret", args).await })
}

/// The open (unanswered) card.
async fn secret_card(live: &LiveSession) -> ApprovalId {
    loop {
        if let Some(id) = live.daemon_approvals.lock().await.iter().find(|(_, entry)| entry.decision.borrow().is_none()).map(|(id, _)| *id) {
            return id;
        }
        tokio::task::yield_now().await;
    }
}

fn resolved_decisions(fixture: &Fixture, thread: &Thread) -> Vec<ApprovalDecision> {
    fixture
        .store
        .events_for_thread(thread.id)
        .unwrap()
        .into_iter()
        .filter_map(|event| match event.payload {
            EventPayload::ApprovalResolved { decision, .. } => Some(decision),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn a_requested_secret_is_written_to_the_file_and_never_stored() {
    let fixture = Fixture::on_disk();
    let (thread, live) = fixture.tool_thread(PermissionMode::Supervised).await;
    let token = format!("zq{}", Uuid::new_v4().simple());
    let secret = format!("{token}-a b\"c$d");
    let env = fixture.root.join(".env");
    std::fs::write(&env, "# keys\nA=1\n").unwrap();

    let call = start_secret_call(&fixture, &thread, &live, "s1", secret_args(json!({ "placeholder": "sk_live_..." })));
    let card = secret_card(&live).await;
    let (request, resolved) = fixture.store.approval_get(card).unwrap().unwrap();
    assert!(!resolved);
    assert_eq!(request.tool_name, SECRET_REQUEST_TOOL);
    assert!(request.is_user_input());
    assert_eq!(
        request.input,
        json!({ "label": "Stripe key", "reason": "Run the checkout test", "env_key": "STRIPE_KEY", "file": ".env", "replaces": false, "placeholder": "sk_live_..." })
    );
    assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().status, ThreadStatus::AwaitingApproval);
    assert_eq!(fixture.store.approvals_pending(Some(thread.id)).unwrap().len(), 1);

    // Only a value is an answer.
    for bad in [ApprovalDecision::AllowOnce, ApprovalDecision::AllowAlways] {
        assert!(fixture.orchestrator.respond_approval(card, bad).await.is_err());
    }
    for bad in [json!({}), json!({ "secret": "" }), json!({ "secret": 5 })] {
        assert!(fixture.orchestrator.respond_approval(card, ApprovalDecision::Submit { response: bad }).await.is_err());
    }
    assert!(!call.is_finished());

    tokio::time::timeout(
        Duration::from_secs(5),
        fixture.orchestrator.respond_approval(card, ApprovalDecision::Submit { response: json!({ "secret": secret }) }),
    )
    .await
    .expect("answering must not deadlock")
    .unwrap();
    let result = call.await.unwrap().unwrap();
    assert_eq!(result, json!({ "status": "saved", "env_key": "STRIPE_KEY", "file": ".env", "replaced": false }));
    assert!(!result.to_string().contains(&token), "the result never carries the value");
    assert_eq!(std::fs::read_to_string(&env).unwrap(), format!("# keys\nA=1\nSTRIPE_KEY=\"{token}-a b\\\"c\\$d\"\n"));
    assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().status, ThreadStatus::Running);

    // The stored and broadcast answer is redacted.
    assert_eq!(resolved_decisions(&fixture, &thread), vec![ApprovalDecision::Submit { response: json!({ "secret": REDACTED_SECRET }) }]);
    assert!(fixture.orchestrator.respond_approval(card, ApprovalDecision::Deny { reason: None }).await.is_err(), "answers are final");

    // Nothing the daemon wrote to disk holds the secret but the env file: not the
    // database, its write-ahead log, nor any other file under the data directory.
    assert!(
        files_containing(&fixture.root, "kybern_request_secret").iter().any(|path| path.to_string_lossy().contains("state.sqlite")),
        "the scan reads the real database and WAL"
    );
    assert_eq!(files_containing(&fixture.root, &token), vec![env.clone()]);

    // A second request replaces the value and leaves one assignment.
    let second = start_secret_call(&fixture, &thread, &live, "s2", secret_args(json!({})));
    let card = secret_card(&live).await;
    let (request, _) = fixture.store.approval_get(card).unwrap().unwrap();
    assert_eq!(request.input["replaces"], json!(true));
    fixture
        .orchestrator
        .respond_approval(card, ApprovalDecision::Submit { response: json!({ "secret": "next_value" }) })
        .await
        .unwrap();
    assert_eq!(second.await.unwrap().unwrap()["replaced"], json!(true));
    assert_eq!(std::fs::read_to_string(&env).unwrap(), "# keys\nA=1\nSTRIPE_KEY=next_value\n");

    assert_eq!(files_containing(&fixture.root, "next_value"), vec![env.clone()]);
}

#[tokio::test]
async fn declining_cancelling_and_timing_out_write_nothing() {
    let fixture = Fixture::on_disk();
    let (thread, live) = fixture.tool_thread(PermissionMode::Supervised).await;
    let env = fixture.root.join(".env");

    let call = start_secret_call(&fixture, &thread, &live, "d1", secret_args(json!({})));
    let card = secret_card(&live).await;
    fixture.orchestrator.respond_approval(card, ApprovalDecision::Deny { reason: None }).await.unwrap();
    assert_eq!(call.await.unwrap().unwrap(), json!({ "status": "declined", "env_key": "STRIPE_KEY", "file": ".env", "replaced": false }));
    assert!(!env.exists());
    assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().status, ThreadStatus::Running);

    // The run ends while the card is open.
    let turn_id = live.turn.lock().await.as_ref().unwrap().id;
    let call = start_secret_call(&fixture, &thread, &live, "c1", secret_args(json!({})));
    let card = secret_card(&live).await;
    fixture.orchestrator.resolve_finished_requests(thread.id, turn_id, &live).await.unwrap();
    assert_eq!(call.await.unwrap().unwrap()["status"], json!("cancelled"));
    assert!(fixture.orchestrator.respond_approval(card, ApprovalDecision::Submit { response: json!({ "secret": "late" }) }).await.is_err());
    assert!(!env.exists());

    // Nobody answers in time: the card is closed, and a late answer is refused.
    // (The tool's shortest wait is 10 s, so this drives the request directly.)
    let request = crate::secrets::SecretRequest {
        label: "Stripe key".into(),
        reason: "Run the checkout test".into(),
        env_key: "STRIPE_KEY".into(),
        file: ".env".into(),
        placeholder: None,
        timeout: Duration::from_millis(200),
    };
    let target = crate::secrets::resolve_target(std::path::Path::new(&thread.cwd), ".env", "STRIPE_KEY").await.unwrap();
    let timed_out = {
        let (orchestrator, live, thread_id) = (fixture.orchestrator.clone(), live.clone(), thread.id);
        tokio::spawn(async move { orchestrator.run_secret_request(thread_id, turn_id, live, request, target).await })
    };
    let card = secret_card(&live).await;
    assert_eq!(timed_out.await.unwrap().unwrap(), json!({ "status": "timed_out", "env_key": "STRIPE_KEY", "file": ".env", "replaced": false }));
    let (_, resolved) = fixture.store.approval_get(card).unwrap().unwrap();
    assert!(resolved);
    assert!(live.daemon_approvals.lock().await.is_empty());
    assert_eq!(fixture.store.thread_get(thread.id).unwrap().unwrap().status, ThreadStatus::Running);
    let error = fixture.orchestrator.respond_approval(card, ApprovalDecision::Submit { response: json!({ "secret": "late" }) }).await;
    assert!(error.is_err());
    assert!(!env.exists());
    assert_eq!(
        resolved_decisions(&fixture, &thread).last(),
        Some(&ApprovalDecision::Deny { reason: Some("timed out".into()) }),
    );
}

#[tokio::test]
async fn bad_requests_fail_before_a_card_is_shown() {
    let fixture = Fixture::new();
    let (thread, live) = fixture.tool_thread(PermissionMode::Supervised).await;
    let outside = std::env::temp_dir().join(format!("kybern-secret-outside-{}", Uuid::now_v7()));
    std::fs::create_dir_all(&outside).unwrap();
    let call = |args: serde_json::Value| {
        let (orchestrator, thread_id, session) = (fixture.orchestrator.clone(), thread.id, live.session_instance_id);
        async move { orchestrator.execute_native_app_tool_call(thread_id, session, "b1", "kybern_request_secret", args).await }
    };

    let cases = [
        (secret_args(json!({ "file": outside.join(".env").to_string_lossy() })), "outside this workspace"),
        (secret_args(json!({ "file": "../.env" })), "outside this workspace"),
        (secret_args(json!({ "file": "no/such/dir/.env" })), "Create it first"),
        (secret_args(json!({ "env_key": "1BAD" })), "env_key must be"),
        (secret_args(json!({ "timeout_seconds": 5 })), "timeout_seconds must be between 10 and 3600"),
        (secret_args(json!({ "secret": "sneaky" })), "Invalid arguments"),
    ];
    for (args, expected) in cases {
        let error = call(args).await.unwrap_err().to_string();
        assert!(error.contains(expected), "{error}");
        assert!(live.daemon_approvals.lock().await.is_empty(), "no card for: {error}");
    }

    // A git repository needs the file to be ignored.
    let git = |args: &[&str]| assert!(std::process::Command::new("git").arg("-C").arg(&fixture.root).args(args).status().unwrap().success());
    git(&["init", "-q"]);
    // (A name the machine's global gitignore is unlikely to cover.)
    let error = call(secret_args(json!({ "file": "app.secrets" }))).await.unwrap_err().to_string();
    assert!(error.contains("`app.secrets` is not ignored by git. Add it to .gitignore, then call kybern_request_secret again."), "{error}");
    assert!(live.daemon_approvals.lock().await.is_empty());
    std::fs::write(fixture.root.join(".gitignore"), "app.secrets\n").unwrap();
    let allowed = {
        let running = start_secret_call(&fixture, &thread, &live, "ok", secret_args(json!({ "file": "app.secrets" })));
        let card = secret_card(&live).await;
        fixture.orchestrator.respond_approval(card, ApprovalDecision::Deny { reason: None }).await.unwrap();
        running.await.unwrap().unwrap()
    };
    assert_eq!(allowed["status"], json!("declined"));

    // A symlink out of the workspace is refused.
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&outside, fixture.root.join("out")).unwrap();
        let error = call(secret_args(json!({ "file": "out/.env" }))).await.unwrap_err().to_string();
        assert!(error.contains("outside this workspace"), "{error}");
    }
    let _ = std::fs::remove_dir_all(&outside);
}

#[tokio::test]
async fn secret_answers_to_codex_questions_are_delivered_but_never_stored() {
    let fixture = Fixture::on_disk();
    let thread = fixture.thread(ThreadStatus::Idle);
    let session = TestSession::default();
    let responses = session.permission_responses.clone();
    let live = fixture.active_session(&thread, session).await;
    let turn_id = live.turn.lock().await.as_ref().unwrap().id;
    let token = format!("zq{}", Uuid::new_v4().simple());

    let approval = ApprovalRequest {
        id: Uuid::now_v7(),
        thread_id: thread.id,
        turn_id,
        tool_call_id: None,
        tool_name: "request_user_input".into(),
        input: json!({ "questions": [
            { "id": "token", "header": "Token", "question": "Paste the API token", "isSecret": true },
            { "id": "color", "header": "Color", "question": "Which color?", "isSecret": false },
        ] }),
        summary: "Answer the agent's questions".into(),
        suggestions: vec![],
        created_at: chrono::Utc::now(),
        questions: Vec::new(),
    };
    fixture.store.approval_insert(&approval).unwrap();
    fixture.orchestrator.emit(thread.id, Some(turn_id), EventPayload::UserInputRequested { approval: approval.clone() }).unwrap();
    live.pending.lock().await.insert(approval.id, "provider-request-1".into());

    let response = json!({ "answers": { "token": { "answers": [token] }, "color": { "answers": ["Blue"] } } });
    fixture.orchestrator.respond_approval(approval.id, ApprovalDecision::Submit { response: response.clone() }).await.unwrap();

    // The provider receives the real answer.
    assert_eq!(*responses.lock().await, vec![ApprovalDecision::Submit { response }]);
    // The record keeps the shape and the plain answer, and hides the secret one.
    let redacted = ApprovalDecision::Submit {
        response: json!({ "answers": { "token": { "answers": [REDACTED_SECRET] }, "color": { "answers": ["Blue"] } } }),
    };
    assert_eq!(resolved_decisions(&fixture, &thread), vec![redacted]);
    assert!(
        files_containing(&fixture.root, "Paste the API token").iter().any(|path| path.to_string_lossy().contains("state.sqlite")),
        "the scan reads the real database and WAL"
    );
    assert!(files_containing(&fixture.root, "Blue").iter().any(|path| path.to_string_lossy().contains("state.sqlite")));
    assert!(files_containing(&fixture.root, &token).is_empty(), "the secret answer is not on disk");
}
