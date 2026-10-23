// Summoned-card tests (`kybern_ask_user`, `kybern_request_login`, `kybern_request_permission`,
// `kybern_run_in_terminal` and `kybern askpass`). Included into `orchestrator::tests`, after
// `secret_tests.rs`, so they use its fixture and helpers.

fn layout_question(extra: serde_json::Value) -> serde_json::Value {
    let mut question = json!({"question":"Which layout?","header":"Layout","options":[{"label":"A"},{"label":"B","description":"Denser"}],"default":"B"});
    question.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    json!({ "questions": [question], "deadline_seconds": 30 })
}

#[tokio::test(start_paused = true)]
async fn a_question_picks_its_default_when_the_deadline_passes() {
    let fixture = Fixture::new();
    let (thread, live) = fixture.tool_thread(PermissionMode::Supervised).await;
    let call = start_tool_call(&fixture, &thread, &live, "q1", "kybern_ask_user", layout_question(json!({})));
    let card = secret_card(&live).await;
    let (request, _) = fixture.store.approval_get(card).unwrap().unwrap();
    assert_eq!(request.tool_name, "AskUserQuestion");
    assert!(request.is_user_input());
    assert_eq!(request.input["questions"][0]["options"][1], json!({"label":"B","description":"Denser"}));
    assert_eq!(request.input["deadline"]["defaults"], json!({"Which layout?":"B"}));
    assert_eq!(request.input["deadline"]["seconds"], 30);
    assert!(fixture.orchestrator.requests().get(card).is_some_and(|p| p.kind == RequestKind::Question && p.ends_at.is_some()));

    let result = call.await.unwrap().unwrap();
    assert_eq!(result["status"], "auto_answered");
    assert_eq!(result["answers"], json!({"Which layout?":"B"}));
    assert_eq!(result["waited_seconds"], 30);
    let decisions = resolved_decisions(&fixture, &thread);
    let [ApprovalDecision::Submit { response }] = decisions.as_slice() else { panic!("{decisions:?}") };
    assert_eq!(response["answers"], json!({"Which layout?":"B"}));
    assert_eq!(response["auto"]["waited_seconds"], 30);
    assert!(fixture.orchestrator.requests().get(card).is_none(), "a finished card is forgotten");
}

#[tokio::test(start_paused = true)]
async fn the_user_can_answer_pause_or_hold_a_deadline() {
    let fixture = Fixture::new();
    let (thread, live) = fixture.tool_thread(PermissionMode::Supervised).await;
    let act = |card, action: &str| fixture.orchestrator.requests().act(card, crate::requests::RequestAct { action: action.into(), value: None, can_write: true });

    // Answered in time: the answer stands and nothing fires.
    let call = start_tool_call(&fixture, &thread, &live, "q1", "kybern_ask_user", layout_question(json!({})));
    let card = secret_card(&live).await;
    fixture
        .orchestrator
        .respond_approval(card, ApprovalDecision::Submit { response: json!({"answers":{"Which layout?":"A"}}) })
        .await
        .unwrap();
    assert_eq!(call.await.unwrap().unwrap(), json!({"status":"answered","answers":{"Which layout?":"A"}}));

    // Paused: the deadline stands still, then runs out the time that was left.
    let call = start_tool_call(&fixture, &thread, &live, "q2", "kybern_ask_user", layout_question(json!({})));
    let card = loop {
        let id = secret_card(&live).await;
        if fixture.store.approval_get(id).unwrap().is_some_and(|(_, resolved)| !resolved) {
            break id;
        }
        tokio::task::yield_now().await;
    };
    tokio::time::sleep(Duration::from_secs(10)).await;
    act(card, "pause").unwrap();
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
    let paused = fixture.orchestrator.requests().get(card).unwrap();
    assert_eq!(paused.phase, RequestPhase::Paused);
    assert!(paused.remaining_ms.is_some_and(|ms| ms > 0 && ms <= 30_000));
    tokio::time::sleep(Duration::from_secs(600)).await;
    assert!(!call.is_finished(), "a paused question does not fire");
    act(card, "resume").unwrap();
    let result = call.await.unwrap().unwrap();
    assert_eq!(result["status"], "auto_answered");

    // "Wait for me": no deadline remains.
    let call = start_tool_call(&fixture, &thread, &live, "q3", "kybern_ask_user", layout_question(json!({})));
    let card = loop {
        let ids: Vec<_> = live.daemon_approvals.lock().await.iter().filter(|(_, e)| e.decision.borrow().is_none()).map(|(id, _)| *id).collect();
        if let Some(id) = ids.first() {
            break *id;
        }
        tokio::task::yield_now().await;
    };
    act(card, "hold").unwrap();
    tokio::time::sleep(Duration::from_secs(3000)).await;
    assert!(!call.is_finished(), "a held question waits for the user");
    assert_eq!(fixture.orchestrator.requests().get(card).unwrap().phase, RequestPhase::Held);
    fixture.orchestrator.respond_approval(card, ApprovalDecision::Deny { reason: None }).await.unwrap();
    assert_eq!(call.await.unwrap().unwrap()["status"], "declined");
}

#[tokio::test]
async fn a_deadline_is_ignored_when_the_user_turned_deadlines_off_and_capped_otherwise() {
    let fixture = Fixture::new();
    let (thread, live) = fixture.tool_thread(PermissionMode::Supervised).await;
    let mut settings = fixture.orchestrator.inner.settings.get();
    settings.ask_deadlines.enabled = false;
    fixture.orchestrator.inner.settings.set(settings).unwrap();
    let call = start_tool_call(&fixture, &thread, &live, "q1", "kybern_ask_user", layout_question(json!({})));
    let card = secret_card(&live).await;
    let (request, _) = fixture.store.approval_get(card).unwrap().unwrap();
    assert!(request.input.get("deadline").is_none(), "no countdown when the user turned it off");
    fixture.orchestrator.respond_approval(card, ApprovalDecision::Deny { reason: None }).await.unwrap();
    assert_eq!(call.await.unwrap().unwrap()["status"], "declined");

    let mut settings = fixture.orchestrator.inner.settings.get();
    settings.ask_deadlines = AskDeadlineSettings { enabled: true, max_seconds: 120 };
    fixture.orchestrator.inner.settings.set(settings).unwrap();
    let mut args = layout_question(json!({}));
    args["deadline_seconds"] = json!(7200);
    let call = start_tool_call(&fixture, &thread, &live, "q2", "kybern_ask_user", args);
    let card = loop {
        let id = secret_card(&live).await;
        if fixture.store.approval_get(id).unwrap().is_some_and(|(_, resolved)| !resolved) {
            break id;
        }
        tokio::task::yield_now().await;
    };
    let (request, _) = fixture.store.approval_get(card).unwrap().unwrap();
    assert_eq!(request.input["deadline"]["seconds"], 120, "the user's cap wins");
    fixture.orchestrator.respond_approval(card, ApprovalDecision::Deny { reason: None }).await.unwrap();
    call.await.unwrap().unwrap();
}

#[tokio::test]
async fn a_command_runs_in_a_terminal_after_an_approval_and_returns_its_tail() {
    let fixture = Fixture::on_disk();
    let (thread, live) = fixture.tool_thread(PermissionMode::Supervised).await;
    let args = json!({"command":"printf 'one\\ntwo\\n'; exit 3","reason":"It may prompt"});
    let call = start_tool_call(&fixture, &thread, &live, "t1", "kybern_run_in_terminal", args.clone());
    let card = secret_card(&live).await;
    let (request, _) = fixture.store.approval_get(card).unwrap().unwrap();
    assert_eq!(request.tool_name, "Bash", "the usual command card asks first");
    assert_eq!(request.input["command"], "printf 'one\\ntwo\\n'; exit 3");
    fixture.orchestrator.respond_approval(card, ApprovalDecision::AllowOnce).await.unwrap();
    let result = tokio::time::timeout(Duration::from_secs(20), call).await.expect("the command exits").unwrap().unwrap();
    assert_eq!(result["status"], "exited");
    assert_eq!(result["exit_code"], 3);
    assert!(result["output"].as_str().unwrap().contains("one\ntwo"), "{result}");
    let id: Uuid = result["terminal_id"].as_str().unwrap().parse().unwrap();
    assert_eq!(fixture.orchestrator.inner.app_tools.terminals().iter().find(|t| t.id == id).and_then(|t| t.thread_id), Some(thread.id));

    // Declining runs nothing.
    let call = start_tool_call(&fixture, &thread, &live, "t2", "kybern_run_in_terminal", args.clone());
    let card = loop {
        let ids: Vec<_> = live.daemon_approvals.lock().await.iter().filter(|(_, e)| e.decision.borrow().is_none()).map(|(id, _)| *id).collect();
        if let Some(id) = ids.first() {
            break *id;
        }
        tokio::task::yield_now().await;
    };
    fixture.orchestrator.respond_approval(card, ApprovalDecision::Deny { reason: None }).await.unwrap();
    assert_eq!(call.await.unwrap().unwrap()["status"], "declined");

    // Full access runs it at once.
    let (thread, live) = fixture.tool_thread(PermissionMode::FullAccess).await;
    let result = tokio::time::timeout(Duration::from_secs(20), fixture.tool(&thread, &live, "t3", "kybern_run_in_terminal", args)).await.unwrap().unwrap();
    assert_eq!(result["exit_code"], 3);
}

#[tokio::test]
async fn a_custom_sign_in_runs_in_a_terminal_and_finishes_when_the_check_passes() {
    let fixture = Fixture::on_disk();
    let (thread, live) = fixture.tool_thread(PermissionMode::Supervised).await;
    let marker = fixture.root.join("signed-in");
    let args = json!({"cli":"mytool","reason":"Publish the package","command":format!("touch '{}'", marker.display()),"verify":format!("test -f '{}'", marker.display())});
    let call = start_tool_call(&fixture, &thread, &live, "l1", "kybern_request_login", args);
    let card = secret_card(&live).await;
    let (request, _) = fixture.store.approval_get(card).unwrap().unwrap();
    assert_eq!(request.tool_name, LOGIN_REQUEST_TOOL);
    assert!(request.is_user_input());
    assert_eq!(request.input["methods"], json!(["terminal"]));
    assert_eq!(request.input["custom"], true);
    // Nothing ran before the user chose.
    assert!(!marker.exists());
    // A client can only decline this card; the buttons go through requests.act.
    assert!(fixture.orchestrator.respond_approval(card, ApprovalDecision::Submit { response: json!({"status":"signed_in"}) }).await.is_err());
    let hub = fixture.orchestrator.requests();
    assert!(hub.get(card).is_some_and(|p| p.phase == RequestPhase::Asking));
    assert!(hub.act(card, crate::requests::RequestAct { action: "browser".into(), value: None, can_write: false }).is_ok());
    for _ in 0..200 {
        if hub.get(card).is_some_and(|p| p.phase == RequestPhase::Failed) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let failed = hub.get(card).unwrap();
    assert_eq!(failed.phase, RequestPhase::Failed);
    assert!(failed.error.unwrap().contains("full access"), "a read-only device cannot change this Mac's logins");
    hub.act(card, crate::requests::RequestAct { action: "terminal".into(), value: None, can_write: true }).unwrap();
    let result = tokio::time::timeout(Duration::from_secs(20), call).await.expect("the check passes").unwrap().unwrap();
    assert_eq!(result, json!({"status":"signed_in","cli":"mytool"}));
    assert!(marker.exists());
    let decisions = resolved_decisions(&fixture, &thread);
    let [ApprovalDecision::Submit { response }] = decisions.as_slice() else { panic!("{decisions:?}") };
    assert_eq!(response["status"], "signed_in");
    assert!(fixture.orchestrator.requests().get(card).is_none());
}

#[tokio::test]
async fn declining_a_sign_in_tells_the_agent_not_to_ask_again() {
    let fixture = Fixture::on_disk();
    let (thread, live) = fixture.tool_thread(PermissionMode::Supervised).await;
    let args = json!({"cli":"mytool","reason":"Publish","command":"mytool login","verify":"false"});
    let call = start_tool_call(&fixture, &thread, &live, "l1", "kybern_request_login", args);
    let card = secret_card(&live).await;
    fixture.orchestrator.respond_approval(card, ApprovalDecision::Deny { reason: None }).await.unwrap();
    assert_eq!(call.await.unwrap().unwrap(), json!({"status":"declined","cli":"mytool"}));
    // An unknown CLI with no command is refused with the way forward.
    let error = fixture.tool(&thread, &live, "l2", "kybern_request_login", json!({"cli":"mytool","reason":"x"})).await.unwrap_err().to_string();
    assert!(error.contains("verify"), "{error}");
}

#[tokio::test]
async fn a_known_cli_is_checked_with_its_own_command() {
    let fixture = Fixture::on_disk();
    let bin = fixture.root.join("gh");
    std::fs::write(&bin, "#!/bin/sh\necho '  ✓ Logged in to github.com account Tester (keyring)'\n").unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let checker = super::login_request::Checker::for_test(kybern_drivers::login_recipes::recipe("gh").unwrap(), bin.clone(), fixture.root.clone());
    assert_eq!(checker.signed_in().await, Some(Some("Tester".to_string())));
    std::fs::write(&bin, "#!/bin/sh\nexit 1\n").unwrap();
    assert_eq!(checker.signed_in().await, None);
}

#[tokio::test]
async fn a_password_prompt_is_a_private_card_whose_answer_is_never_stored() {
    let fixture = Fixture::on_disk();
    let (thread, live) = fixture.tool_thread(PermissionMode::FullAccess).await;
    let token = format!("zq{}", Uuid::new_v4().simple());
    let (orchestrator, session) = (fixture.orchestrator.clone(), live.session_instance_id);
    let ask = tokio::spawn(async move { orchestrator.ask_prompt(thread.id, session, "[sudo] password for me: ".into(), std::process::id()).await });
    let card = secret_card(&live).await;
    let (request, _) = fixture.store.approval_get(card).unwrap().unwrap();
    assert_eq!(request.tool_name, PROMPT_REQUEST_TOOL);
    assert!(request.is_user_input());
    // The test process stands in for the asker, and it is not sudo: the prompt's own words cannot make it a sudo card.
    assert_eq!(request.input["purpose"], "other");
    assert_eq!(request.input["secret"], true);
    assert_eq!(request.input["attempt"], 1);
    assert_eq!(request.input["harness"], thread.provider.kind.display_name());
    // Full access does not answer it, and only a value or a cancel is an answer.
    assert!(!ask.is_finished());
    assert!(fixture.orchestrator.respond_approval(card, ApprovalDecision::AllowOnce).await.is_err());
    assert!(fixture.orchestrator.respond_approval(card, ApprovalDecision::Submit { response: json!({"secret":""}) }).await.is_err());
    fixture.orchestrator.respond_approval(card, ApprovalDecision::Submit { response: json!({"secret": token}) }).await.unwrap();
    let reply = ask.await.unwrap();
    assert!(matches!(&reply, super::PromptReply::Answer(answer) if *answer == token));
    assert_eq!(resolved_decisions(&fixture, &thread), vec![ApprovalDecision::Submit { response: json!({ "secret": REDACTED_SECRET }) }]);
    assert!(files_containing(&fixture.root, &token).is_empty(), "the password is never written anywhere");
    assert!(live.daemon_approvals.lock().await.is_empty());

    // Cancel fails the command.
    let (orchestrator, session) = (fixture.orchestrator.clone(), live.session_instance_id);
    let ask = tokio::spawn(async move { orchestrator.ask_prompt(thread.id, session, "[sudo] password for me: ".into(), std::process::id()).await });
    let card = secret_card(&live).await;
    let (request, _) = fixture.store.approval_get(card).unwrap().unwrap();
    assert_eq!(request.input["attempt"], 2, "the same prompt again is the next try");
    fixture.orchestrator.respond_approval(card, ApprovalDecision::Deny { reason: None }).await.unwrap();
    assert!(matches!(ask.await.unwrap(), super::PromptReply::Cancelled(message) if message.contains("cancelled")));
}

#[tokio::test]
async fn a_host_key_is_a_yes_or_no_and_github_is_sent_to_the_sign_in() {
    let fixture = Fixture::on_disk();
    let (thread, live) = fixture.tool_thread(PermissionMode::Supervised).await;
    let host_key = "The authenticity of host '203.0.113.24 (203.0.113.24)' can't be established.\nED25519 key fingerprint is SHA256:abc123.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ";
    let (orchestrator, session) = (fixture.orchestrator.clone(), live.session_instance_id);
    let ask = tokio::spawn(async move { orchestrator.ask_prompt(thread.id, session, host_key.into(), std::process::id()).await });
    let card = secret_card(&live).await;
    let (request, _) = fixture.store.approval_get(card).unwrap().unwrap();
    assert_eq!((request.input["purpose"].as_str(), request.input["confirm"].as_bool()), (Some("ssh_host_key"), Some(true)));
    assert_eq!(request.input["fingerprint"], "SHA256:abc123");
    assert!(fixture.orchestrator.respond_approval(card, ApprovalDecision::Submit { response: json!({"secret":"yes"}) }).await.is_err(), "yes or no, nothing else");
    fixture.orchestrator.respond_approval(card, ApprovalDecision::Submit { response: json!({"confirmed": true}) }).await.unwrap();
    assert!(matches!(ask.await.unwrap(), super::PromptReply::Answer(answer) if answer == "yes"));

    let reply = fixture.orchestrator.ask_prompt(thread.id, live.session_instance_id, "Password for 'https://me@github.com': ".into(), std::process::id()).await;
    assert!(matches!(reply, super::PromptReply::Cancelled(message) if message.contains("kybern_request_login")), "GitHub never gets a password card");
    assert!(live.daemon_approvals.lock().await.is_empty());

    let stale = fixture.orchestrator.ask_prompt(thread.id, Uuid::now_v7(), "Password:".into(), std::process::id()).await;
    // A helper whose parent is not sudo, ssh or git (here: this test process) may not raise a card.
    let mut child = std::process::Command::new("/bin/sleep").arg("5").spawn().unwrap();
    let faked = fixture.orchestrator.ask_prompt(thread.id, live.session_instance_id, "[sudo] password for me: ".into(), child.id()).await;
    let _ = child.kill();
    let _ = child.wait();
    assert!(matches!(faked, super::PromptReply::Cancelled(message) if message.contains("only shows a password prompt that sudo, ssh or git asked for")));
    assert!(matches!(stale, super::PromptReply::Cancelled(_)), "a replaced session cannot ask");
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn a_permission_card_names_the_pane_and_stops_waiting_on_request() {
    let fixture = Fixture::new();
    let (thread, live) = fixture.tool_thread(PermissionMode::Supervised).await;
    let args = json!({"pane":"camera","app":"Safari","bundle_id":"com.apple.Safari","reason":"Test the video call"});
    let call = start_tool_call(&fixture, &thread, &live, "p1", "kybern_request_permission", args.clone());
    let card = secret_card(&live).await;
    let (request, _) = fixture.store.approval_get(card).unwrap().unwrap();
    assert_eq!(request.tool_name, PERMISSION_REQUEST_TOOL);
    assert_eq!(request.input["url"], "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera");
    assert_eq!(request.input["pane_label"], "Privacy & Security › Camera");
    assert_eq!(request.input["relaunch"], false);
    let hub = fixture.orchestrator.requests();
    hub.act(card, crate::requests::RequestAct { action: "open".into(), value: None, can_write: false }).unwrap();
    for _ in 0..200 {
        if hub.get(card).is_some_and(|p| p.phase == RequestPhase::Waiting) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(hub.get(card).unwrap().phase, RequestPhase::Waiting);
    hub.act(card, crate::requests::RequestAct { action: "stop".into(), value: None, can_write: false }).unwrap();
    assert_eq!(call.await.unwrap().unwrap()["status"], "stopped");

    // Without a way to see the grant, the user's word closes the card.
    let call = start_tool_call(&fixture, &thread, &live, "p2", "kybern_request_permission", args);
    let card = loop {
        let ids: Vec<_> = live.daemon_approvals.lock().await.iter().filter(|(_, e)| e.decision.borrow().is_none()).map(|(id, _)| *id).collect();
        if let Some(id) = ids.first() {
            break *id;
        }
        tokio::task::yield_now().await;
    };
    let (request, _) = fixture.store.approval_get(card).unwrap().unwrap();
    if request.input["detects"] == false {
        hub.act(card, crate::requests::RequestAct { action: "granted".into(), value: None, can_write: false }).unwrap();
        assert_eq!(call.await.unwrap().unwrap()["status"], "user_confirmed");
    } else {
        fixture.orchestrator.respond_approval(card, ApprovalDecision::Deny { reason: None }).await.unwrap();
        call.await.unwrap().unwrap();
    }
}
