// A delegated agent's question reaching its parent. Included into `orchestrator::tests`
// after `delegation_tests.rs`, whose scripted driver and `Delegating` fixture it uses.

async fn child_asks(child: &ScriptedChild, request_id: &str, tool: &str, input: serde_json::Value) {
    child
        .tx
        .send(DriverEvent::PermissionRequest {
            request_id: request_id.into(),
            tool_call_id: None,
            tool_name: tool.into(),
            input,
            summary: "Question".into(),
            suggestions: vec![],
        })
        .await
        .unwrap();
}

async fn pending_card(t: &Delegating, child: &Thread, tool: &str) -> ApprovalRequest {
    eventually(|| async { t.fixture.store.approvals_pending(Some(child.id)).unwrap().into_iter().find(|a| a.tool_name == tool) }).await
}

fn resolved(t: &Delegating, child: &Thread, card: ApprovalId) -> (ApprovalDecision, Option<RequestAnswerer>) {
    t.fixture
        .store
        .events_for_thread(child.id)
        .unwrap()
        .into_iter()
        .find_map(|event| match event.payload {
            EventPayload::ApprovalResolved { approval_id, decision, answered_by } if approval_id == card => Some((decision, answered_by)),
            _ => None,
        })
        .expect("the card was resolved")
}

#[tokio::test]
async fn a_childs_question_ends_the_wait_and_the_first_answer_wins() {
    let t = Delegating::new().await;
    let result = t.delegate(json!({"task": "Pick a palette"})).await;
    let child = t.delegation(&result["task_id"]);
    let agent = t.agent("Pick a palette").await;
    let questions = json!([{ "question": "Which palette?", "multiSelect": true, "options": [{"label": "Warm, soft"}, {"label": "Cool"}] }]);
    child_asks(&agent, "q1", "AskUserQuestion", json!({ "questions": questions })).await;
    let card = pending_card(&t, &child, "AskUserQuestion").await;
    assert_eq!(card.questions[0].options[0].label, "Warm, soft", "the card carries the normalized questions");

    let waited = t.tool("kybern_agent_wait", json!({ "timeout_ms": 5000 })).await.unwrap();
    assert_eq!(waited["has_pending_question"], true, "{waited}");
    assert_eq!(waited["pending_questions"][0]["request_id"], json!(card.id));
    assert_eq!(waited["wait_timed_out"], false);
    let rewait = t.tool("kybern_agent_wait", json!({ "timeout_ms": 200 })).await.unwrap();
    assert_eq!(rewait["wait_timed_out"], true, "a question already shown does not end the next wait: {rewait}");

    let listed = t.tool("kybern_pending_questions", json!({})).await.unwrap();
    assert_eq!(listed["questions"][0]["questions"][0]["id"], "Which palette?");

    let answered =
        t.tool("kybern_answer_question", json!({ "request_id": card.id, "answers": [{ "answers": ["Warm, soft", "Cool"] }] })).await.unwrap();
    assert_eq!(answered["status"], "answered");
    let (decision, by) = resolved(&t, &child, card.id);
    assert_eq!(by.map(|by| by.title), Some("Parent thread".to_string()));
    let ApprovalDecision::Submit { response } = decision else { panic!("expected an answer") };
    assert_eq!(response["answers"]["Which palette?"], json!(["Warm, soft", "Cool"]), "labels with commas stay whole");

    let again = t.tool("kybern_answer_question", json!({ "request_id": card.id, "answers": [{ "answers": ["Cool"] }] })).await.unwrap();
    assert_eq!(again["status"], "already_answered");
    // The wait returned the question, so no notice follows.
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert!(!serde_json::to_string(&*t.parent_messages.lock().await).unwrap().contains("is waiting on a question"));
}

#[tokio::test]
async fn a_parent_is_told_and_never_answers_approvals() {
    let t = Delegating::new().await;
    let result = t.delegate(json!({"task": "Ship the build"})).await;
    let child = t.delegation(&result["task_id"]);
    let agent = t.agent("Ship the build").await;
    child_asks(&agent, "q1", "AskUserQuestion", json!({ "questions": [{ "question": "Deploy where?", "options": [{"label": "Staging"}, {"label": "Prod"}] }] }))
        .await;
    // The parent is running, so the notice is steered into its turn.
    eventually(|| async {
        serde_json::to_string(&*t.parent_messages.lock().await).unwrap().contains("is waiting on a question").then_some(())
    })
    .await;

    // The user answers with normalized answers; the record names nobody.
    let card = pending_card(&t, &child, "AskUserQuestion").await;
    t.fixture
        .orchestrator
        .respond_approval(card.id, ApprovalDecision::Submit { response: json!({ "kybern_answers": [{ "id": "Deploy where?", "answers": ["Staging"] }] }) })
        .await
        .unwrap();
    let (decision, by) = resolved(&t, &child, card.id);
    assert!(by.is_none());
    assert!(matches!(decision, ApprovalDecision::Submit { response } if response["answers"]["Deploy where?"] == "Staging"));

    child_asks(&agent, "a1", "Bash", json!({ "command": "rm -rf build" })).await;
    let approval = pending_card(&t, &child, "Bash").await;
    let refused = t.tool("kybern_answer_question", json!({ "request_id": approval.id, "answers": [{ "answers": ["yes"] }] })).await.unwrap_err();
    assert!(refused.to_string().contains("only the user can answer"), "{refused}");
    let listed = t.tool("kybern_pending_questions", json!({})).await.unwrap();
    assert!(listed["questions"].as_array().unwrap().is_empty(), "approvals are never listed");
}

#[tokio::test]
async fn a_queued_notice_is_taken_back_when_the_user_answers_first() {
    let t = Delegating::new().await;
    let result = t.delegate(json!({"task": "Name the release"})).await;
    let child = t.delegation(&result["task_id"]);
    let agent = t.agent("Name the release").await;
    t.end_parent_turn().await;
    child_asks(&agent, "q1", "AskUserQuestion", json!({ "questions": [{ "question": "Which name?", "options": [{"label": "Ash"}, {"label": "Elm"}] }] })).await;
    let notice = |t: &Delegating| {
        t.fixture.store.queue_list(Some(t.parent.id)).unwrap().into_iter().any(|queued| {
            matches!(queued.message.parts.as_slice(), [ContentPart::ThreadMessage { body, .. }] if body.contains("is waiting on a question"))
        })
    };
    eventually(|| async { notice(&t).then_some(()) }).await;
    let card = pending_card(&t, &child, "AskUserQuestion").await;
    t.fixture.orchestrator.respond_approval(card.id, ApprovalDecision::Submit { response: json!({ "answers": { "Which name?": "Elm" } }) }).await.unwrap();
    eventually(|| async { (!notice(&t)).then_some(()) }).await;
}

#[tokio::test]
async fn an_answer_to_a_question_that_closed_unanswered_says_closed() {
    let t = Delegating::new().await;
    let result = t.delegate(json!({"task": "Name the file"})).await;
    let child = t.delegation(&result["task_id"]);
    let agent = t.agent("Name the file").await;
    child_asks(&agent, "q1", "AskUserQuestion", json!({ "questions": [{ "question": "Which name?", "options": [{"label": "a.txt"}] }] })).await;
    let card = pending_card(&t, &child, "AskUserQuestion").await;
    t.fixture.orchestrator.respond_approval(card.id, ApprovalDecision::Deny { reason: None }).await.unwrap();
    let late = t.tool("kybern_answer_question", json!({ "request_id": card.id, "answers": [{ "answers": ["a.txt"] }] })).await.unwrap();
    assert_eq!(late["status"], "closed", "{late}");
}

#[test]
fn an_answers_image_keeps_an_extension_the_agent_can_read() {
    assert_eq!(super::asset_extension("Shot.PNG", "image/png").as_deref(), Some("png"));
    assert_eq!(super::asset_extension("attachment", "image/jpeg").as_deref(), Some("jpg"));
    assert_eq!(super::asset_extension("notes.a b", "application/octet-stream"), None);
}
