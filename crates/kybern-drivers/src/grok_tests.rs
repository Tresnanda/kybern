//! Grok driver tests: the pure mappings, and whole sessions against a fake `grok agent stdio`
//! that plays ACP transcripts. The `initialize` answer is trimmed from a real `grok` 1.0.92; the
//! `x.ai/…` messages follow T3 Code's Grok provider, since no signed-in `grok` was available.

use super::*;
use agent_client_protocol::schema::v1::{PermissionOptionId, ToolCallLocation};

fn option(id: &str, kind: PermissionOptionKind) -> PermissionOption {
    PermissionOption::new(PermissionOptionId::new(id), id, kind)
}

/// The options `grok` offers for an edit (T3 Code's fixtures: `allow-edits-session` is the session grant).
fn edit_options() -> Vec<PermissionOption> {
    vec![
        option("allow-once", PermissionOptionKind::AllowOnce),
        option(ALLOW_EDITS_SESSION, PermissionOptionKind::AllowAlways),
        option("allow-always-project", PermissionOptionKind::AllowAlways),
        option("reject-once", PermissionOptionKind::RejectOnce),
    ]
}

fn selected(response: &RequestPermissionResponse) -> Option<String> {
    match &response.outcome {
        RequestPermissionOutcome::Selected(selected) => Some(selected.option_id.to_string()),
        _ => None,
    }
}

#[test]
fn every_permission_mode_launches_with_its_own_grok_flags() {
    assert_eq!(launch_args(PermissionMode::Supervised), ["--no-auto-update", "--permission-mode", "default", "agent", "stdio"]);
    assert_eq!(launch_args(PermissionMode::AcceptEdits), ["--no-auto-update", "--permission-mode", "default", "agent", "stdio"]);
    // Auto is xAI's own classifier, not "approve everything".
    assert_eq!(launch_args(PermissionMode::Auto), ["--no-auto-update", "--permission-mode", "auto", "agent", "stdio"]);
    assert_eq!(launch_args(PermissionMode::FullAccess), ["--no-auto-update", "agent", "--always-approve", "stdio"]);
    assert_eq!(initialize_meta().get("clientType"), Some(&json!("extension")));
}

#[test]
fn decisions_pick_grok_options_and_allow_always_never_saves_a_project_grant() {
    let options = edit_options();
    assert_eq!(selected(&permission_response(&options, Some(&ApprovalDecision::AllowOnce))).as_deref(), Some("allow-once"));
    assert_eq!(selected(&permission_response(&options, Some(&ApprovalDecision::AllowAlways))).as_deref(), Some(ALLOW_EDITS_SESSION));
    assert_eq!(selected(&permission_response(&options, Some(&ApprovalDecision::Deny { reason: None }))).as_deref(), Some("reject-once"));
    // The turn ended before anyone answered.
    assert_eq!(selected(&permission_response(&options, None)), None);

    // A command offers no session grant: "for this thread" allows once rather than for the project.
    let command = vec![option("allow-once", PermissionOptionKind::AllowOnce), option("always", PermissionOptionKind::AllowAlways)];
    assert_eq!(selected(&permission_response(&command, Some(&ApprovalDecision::AllowAlways))).as_deref(), Some("allow-once"));
    // Nothing to reject with: cancel.
    assert_eq!(selected(&permission_response(&command, Some(&ApprovalDecision::Deny { reason: None }))), None);
}

#[test]
fn accept_edits_answers_workspace_edits_and_asks_for_everything_else() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().join("repo");
    std::fs::create_dir_all(cwd.join("src")).unwrap();
    let edit = |kind: ToolKind, paths: &[PathBuf]| {
        ToolCallUpdateFields::new().kind(kind).locations(paths.iter().map(|path| ToolCallLocation::new(path.clone())).collect::<Vec<_>>())
    };
    let inside = edit(ToolKind::Edit, &[cwd.join("src/new.rs"), PathBuf::from("README.md")]);
    assert_eq!(auto_decision(PermissionMode::AcceptEdits, &inside, &cwd), Some(ApprovalDecision::AllowOnce));
    assert_eq!(auto_decision(PermissionMode::Supervised, &inside, &cwd), None);
    // Auto's requests are refusals by xAI's classifier: they reach the user.
    assert_eq!(auto_decision(PermissionMode::Auto, &inside, &cwd), None);
    assert_eq!(auto_decision(PermissionMode::FullAccess, &edit(ToolKind::Execute, &[]), &cwd), Some(ApprovalDecision::AllowOnce));

    for asks in [
        edit(ToolKind::Execute, &[cwd.join("src/new.rs")]),
        edit(ToolKind::Edit, &[]),
        edit(ToolKind::Edit, &[root.path().join("elsewhere.rs")]),
        edit(ToolKind::Delete, &[cwd.join("../repo/../outside.rs")]),
    ] {
        assert_eq!(auto_decision(PermissionMode::AcceptEdits, &asks, &cwd), None, "{asks:?}");
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(root.path(), cwd.join("escape")).unwrap();
        assert_eq!(auto_decision(PermissionMode::AcceptEdits, &edit(ToolKind::Edit, &[cwd.join("escape/x.rs")]), &cwd), None);
    }
}

#[test]
fn ask_user_questions_become_question_cards_and_answers_go_back_in_xai_shape() {
    let params = json!({
        "sessionId": "s1", "toolCallId": "call-7", "mode": "default",
        "questions": [
            { "question": "Which layout?", "options": [{ "label": "Grid", "preview": "▦" }, { "label": "List" }] },
            { "question": "Which tests?", "multiSelect": true, "options": [{ "label": "Unit" }, { "label": "Live" }] },
        ],
    });
    let wrapped = json!({ "method": "x.ai/ask_user_question", "params": params });
    let ask = XaiRequest::parse("_x.ai/ask_user_question", &params).unwrap();
    assert_eq!(XaiRequest::parse("x.ai/ask_user_question", &wrapped), Some(ask.clone()));
    assert_eq!(XaiRequest::parse("x.ai/something_else", &params), None);

    let DriverEvent::PermissionRequest { tool_name, input, summary, tool_call_id, .. } = ask.card("r1".into()) else { panic!("a card") };
    assert_eq!((tool_name.as_str(), summary.as_str(), tool_call_id.as_deref()), ("AskUserQuestion", "Which layout?", Some("call-7")));
    let questions = kybern_protocol::user_input_questions(&tool_name, &input);
    assert_eq!(questions.len(), 2);
    assert_eq!(questions[0].options[0].preview.as_deref(), Some("▦"));
    assert!(questions[1].multi_select);

    // What the daemon's `encode_answers` sends for an `AskUserQuestion`, including a typed answer.
    let response = json!({
        "answers": { "Which layout?": "Grid", "Which tests?": ["Unit", "Only the flaky one"] },
        "annotations": { "Which layout?": { "preview": "▦" } },
    });
    assert_eq!(
        ask.response(Some(ApprovalDecision::Submit { response })),
        json!({
            "outcome": "accepted",
            "answers": { "Which layout?": ["Grid"], "Which tests?": ["Unit"] },
            "annotations": { "Which layout?": { "preview": "▦" }, "Which tests?": { "notes": "Only the flaky one" } },
        })
    );
    let typed = json!({ "answers": { "Which layout?": "Columns", "Which tests?": ["Live"] } });
    assert_eq!(ask.response(Some(ApprovalDecision::Submit { response: typed }))["answers"]["Which layout?"], json!(["Other"]));
    assert_eq!(ask.response(Some(ApprovalDecision::Deny { reason: None })), json!({ "outcome": "cancelled" }));
    assert_eq!(ask.response(None), json!({ "outcome": "cancelled" }));
}

#[test]
fn a_plan_exit_is_a_plan_approval() {
    let plan =
        XaiRequest::parse("x.ai/exit_plan_mode", &json!({ "sessionId": "s1", "toolCallId": "p1", "planContent": " # Plan\n1. Do it " }))
            .unwrap();
    let DriverEvent::PermissionRequest { tool_name, input, .. } = plan.card("r1".into()) else { panic!("a card") };
    assert_eq!((tool_name.as_str(), &input), ("ExitPlanMode", &json!({ "plan": "# Plan\n1. Do it" })));
    assert_eq!(plan.response(Some(ApprovalDecision::AllowOnce)), json!({ "outcome": "approved" }));
    assert_eq!(
        plan.response(Some(ApprovalDecision::Deny { reason: Some("Add tests first".into()) })),
        json!({ "outcome": "request_changes", "feedback": "Add tests first" })
    );
    assert_eq!(plan.response(None)["outcome"], "abandoned");
    let empty = XaiRequest::parse("_x.ai/exit_plan_mode", &json!({ "sessionId": "s1", "toolCallId": "p1", "planContent": null })).unwrap();
    assert_eq!(empty, XaiRequest::ExitPlanMode { tool_call_id: Some("p1".into()), plan: None });
}

#[test]
fn grok_completion_notices_settle_only_named_foreground_prompts() {
    let complete =
        prompt_complete("_x.ai/session/prompt_complete", &json!({ "sessionId": "s1", "promptId": "kybern-1", "stopReason": "end_turn" }));
    assert_eq!(
        complete,
        Some(PromptComplete { prompt_id: Some("kybern-1".into()), stop_reason: Some("end_turn".into()), agent_result: None })
    );
    let update = |prompt: Value| json!({ "sessionId": "s1", "update": { "sessionUpdate": "turn_completed", "prompt_id": prompt, "stop_reason": "cancelled" } });
    assert_eq!(prompt_complete("x.ai/session_notification", &update(json!("kybern-2"))).unwrap().stop_reason.as_deref(), Some("cancelled"));
    assert!(prompt_complete("_x.ai/session/update", &update(json!("kybern-2"))).is_some());
    // A background command's wake, a turn without a prompt id, and other updates are not our prompt.
    assert_eq!(prompt_complete("_x.ai/session_notification", &update(json!("task-completed-9"))), None);
    assert_eq!(prompt_complete("_x.ai/session_notification", &update(Value::Null)), None);
    assert_eq!(prompt_complete("_x.ai/session_notification", &json!({ "update": { "sessionUpdate": "task_started" } })), None);
    assert_eq!(prompt_complete("_x.ai/mcp/servers_updated", &json!({ "mcpServers": [] })), None);
}

#[test]
fn completion_notices_and_failed_prompts_name_usage_limits_and_xai_errors() {
    let done = |stop: &str, result: Option<Value>| {
        completion_event(&PromptComplete { prompt_id: None, stop_reason: Some(stop.into()), agent_result: result }, 5)
    };
    assert!(matches!(done("end_turn", None), DriverEvent::TurnCompleted { stop_reason: StopReason::Completed, duration_ms: 5, .. }));
    assert!(matches!(done("cancelled", None), DriverEvent::TurnCompleted { stop_reason: StopReason::Interrupted, .. }));
    let DriverEvent::TurnFailed { error, problem } = done("error", Some(json!("Model overloaded, try again later"))) else { panic!() };
    assert_eq!(error, "Model overloaded, try again later");
    assert_eq!(problem.and_then(|problem| problem.subject).as_deref(), Some("network"));
    let DriverEvent::TurnFailed { problem, .. } = done("rate_limit", None) else { panic!() };
    assert_eq!(problem.and_then(|problem| problem.subject).as_deref(), Some("rate_limit"));

    // -32003 is a usage limit whatever its message says.
    let limited = agent_client_protocol::Error::new(RATE_LIMITED, "Request failed");
    let DriverEvent::TurnFailed { problem, .. } = prompt_failure(&limited) else { panic!() };
    assert_eq!(problem.and_then(|problem| problem.subject).as_deref(), Some("rate_limit"));
    let other = agent_client_protocol::Error::new(-32603, "Something broke");
    assert!(matches!(prompt_failure(&other), DriverEvent::TurnFailed { problem: None, .. }));
}

#[test]
fn mcp_calls_through_use_tool_show_the_real_tool_and_result() {
    let input = json!({ "tool_name": "kybern__kybern_html_publish", "tool_input": { "title": "Report" } });
    assert_eq!(mcp_call("use_tool", Some(&input)), Some(("mcp__kybern__kybern_html_publish".into(), json!({ "title": "Report" }))));
    assert_eq!(mcp_call("read_file", Some(&input)), None);
    for odd in [json!({ "tool_name": "__x" }), json!({ "tool_name": "kybern__" }), json!({ "tool_name": "plain" })] {
        assert_eq!(mcp_call("use_tool", Some(&odd)), None, "{odd}");
    }
    assert_eq!(mcp_call("use_tool", Some(&json!({ "tool_name": "a__b" }))), Some(("mcp__a__b".into(), json!({}))));

    let okay = json!({ "type": "MCP", "output": { "OkayOutput": "{\"ok\":true}" } });
    let (output, is_error) = tool_output(Some("completed"), Some(okay), Value::Null, Some("use_tool".into()));
    assert!(!is_error);
    assert_eq!(output["raw"]["content"], json!([{ "type": "text", "text": "{\"ok\":true}" }]));
    let failed = json!({ "type": "MCP", "output": { "Error": "no such thread" } });
    let (output, is_error) = tool_output(Some("completed"), Some(failed), Value::Null, None);
    assert!(is_error);
    assert_eq!(output["content"][0]["text"], "no such thread");
    // Anything else keeps Grok's own shape.
    let (output, is_error) = tool_output(Some("failed"), Some(json!({ "type": "Bash" })), json!([]), None);
    assert!(is_error);
    assert_eq!(output["raw"], json!({ "type": "Bash" }));
}

#[test]
fn skills_images_and_thread_references_reach_grok() {
    let thread = uuid::Uuid::now_v7();
    let message = UserMessage {
        parts: vec![
            ContentPart::Skill { name: "deploy".into(), path: "/skills/deploy/SKILL.md".into() },
            ContentPart::Text { text: " to staging, see ".into() },
            ContentPart::ThreadReference { thread_id: thread, title: "Deploy notes".into(), project_id: None },
            ContentPart::Image { media_type: "image/png".into(), data: "iVBOR".into() },
            ContentPart::Text { text: "and this".into() },
        ],
    };
    let blocks = prompt_blocks(&message);
    let [ContentBlock::Text(first), ContentBlock::Image(image), ContentBlock::Text(last)] = blocks.as_slice() else {
        panic!("text, image, text: {blocks:?}")
    };
    assert!(first.text.starts_with("/deploy to staging, see "), "{}", first.text);
    assert!(first.text.contains(&thread_reference_text(thread, "Deploy notes")));
    assert_eq!((image.mime_type.as_str(), image.data.as_str()), ("image/png", "iVBOR"));
    assert_eq!(last.text, "and this");

    // A skill keeps the start of the prompt, so the guide waits for the next ordinary one.
    let mut guide = Some("GUIDE".to_string());
    let (blocks, carried) = blocks_with_guide(&mut guide, blocks);
    assert!(carried.is_none() && guide.is_some());
    assert!(matches!(&blocks[0], ContentBlock::Text(text) if text.text.starts_with("/deploy")));
    // An image-only prompt gets the guide as its own block in front.
    let image_only = prompt_blocks(&UserMessage { parts: vec![ContentPart::Image { media_type: "image/png".into(), data: "x".into() }] });
    let (blocks, carried) = blocks_with_guide(&mut guide, image_only);
    assert_eq!(carried.as_deref(), Some("GUIDE"));
    assert!(matches!(&blocks[..], [ContentBlock::Text(text), ContentBlock::Image(_)] if text.text.contains("GUIDE")));
}

#[test]
fn orchestration_parts_flatten_into_the_prompt() {
    let blocks = prompt_blocks(&crate::test_support::orchestration_message());
    let [ContentBlock::Text(text)] = blocks.as_slice() else { panic!("{blocks:?}") };
    crate::test_support::assert_flattened(&text.text);
}

#[tokio::test(start_paused = true)]
async fn a_load_finishes_when_answered_or_once_its_replay_goes_quiet_and_never_hangs() {
    let gap = Duration::from_secs(2);
    let timeout = Duration::from_secs(90);
    let last = std::sync::Mutex::new(None);
    assert_eq!(await_session_load(async { 7 }, &last, gap, timeout).await, LoadOutcome::Answered(7));

    // Replayed, then silent: done after the quiet gap, long before the timeout.
    *last.lock().unwrap() = Some(tokio::time::Instant::now());
    let started = tokio::time::Instant::now();
    assert_eq!(await_session_load(std::future::pending::<()>(), &last, gap, timeout).await, LoadOutcome::ReplayIdle);
    assert!(started.elapsed() < Duration::from_secs(3));

    // Nothing replayed and no answer: give up at the timeout.
    let last = std::sync::Mutex::new(None);
    let started = tokio::time::Instant::now();
    assert_eq!(await_session_load(std::future::pending::<()>(), &last, gap, timeout).await, LoadOutcome::TimedOut);
    assert!(started.elapsed() >= timeout);
}

/// A stand-in for `grok`: answers ACP from a scenario in `FAKE_GROK`, logs every message it reads to
/// `received.jsonl` and its arguments and updater setting to `argv.json`.
#[cfg(unix)]
const FAKE_GROK: &str = r##"#!/usr/bin/env python3
import json, os, sys
scenario = os.environ.get("FAKE_GROK", "")
with open("argv.json", "w") as f:
    json.dump({"argv": sys.argv[1:], "autoupdater": os.environ.get("GROK_DISABLE_AUTOUPDATER")}, f)
log = open("received.jsonl", "a")
def send(msg):
    msg["jsonrpc"] = "2.0"
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()
def read():
    line = sys.stdin.readline()
    if not line:
        sys.exit(0)
    log.write(line)
    log.flush()
    return json.loads(line)
def reply_to(request_id):
    while True:
        msg = read()
        if msg.get("id") == request_id and "method" not in msg:
            return msg
def update(sid, u):
    send({"method": "session/update", "params": {"sessionId": sid, "update": u}})
def ask(method, params):
    send({"id": "grok-1", "method": method, "params": params})
    return reply_to("grok-1")
while True:
    msg = read()
    method, mid, params = msg.get("method"), msg.get("id"), msg.get("params") or {}
    if method == "initialize":
        # Trimmed from a real grok 1.0.92.
        send({"id": mid, "result": {"protocolVersion": 1, "agentCapabilities": {"loadSession": True, "promptCapabilities": {"image": True, "audio": False, "embeddedContext": True}, "mcpCapabilities": {"http": True, "sse": True}}, "authMethods": [{"id": "grok.com", "name": "Grok", "description": "Sign in with Grok"}], "_meta": {"agentVersion": "1.0.92"}}})
    elif method == "session/new":
        send({"id": mid, "result": {"sessionId": "s-new"}})
    elif method == "session/load":
        sid = params["sessionId"]
        update(sid, {"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": "old question"}})
        update(sid, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "old answer"}})
        if scenario != "load_hangs":
            send({"id": mid, "result": {}})
    elif method == "session/prompt":
        sid = params["sessionId"]
        prompt_id = (params.get("_meta") or {}).get("promptId")
        if scenario == "permission":
            ask("session/request_permission", {"sessionId": sid, "toolCall": {"toolCallId": "t1", "title": "Edit src/a.rs", "kind": "edit", "locations": [{"path": "/somewhere/else/a.rs"}]}, "options": [
                {"optionId": "allow-once", "name": "Yes", "kind": "allow_once"},
                {"optionId": "allow-edits-session", "name": "Yes, and allow all edits this session", "kind": "allow_always"},
                {"optionId": "reject-once", "name": "No", "kind": "reject_once"}]})
        elif scenario == "question":
            ask("_x.ai/ask_user_question", {"sessionId": sid, "toolCallId": "q1", "mode": "default", "questions": [{"question": "Which layout?", "options": [{"label": "Grid"}, {"label": "List"}]}]})
        elif scenario == "plan":
            ask("x.ai/exit_plan_mode", {"sessionId": sid, "toolCallId": "p1", "planContent": "# Plan\n1. Ship it"})
        update(sid, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "new answer"}})
        if scenario == "prompt_complete":
            send({"method": "_x.ai/session/prompt_complete", "params": {"sessionId": sid, "promptId": "someone-else", "stopReason": "end_turn"}})
            send({"method": "_x.ai/session_notification", "params": {"sessionId": sid, "update": {"sessionUpdate": "turn_completed", "prompt_id": "task-completed-1"}}})
            send({"method": "_x.ai/session/prompt_complete", "params": {"sessionId": sid, "promptId": prompt_id, "stopReason": "end_turn"}})
        elif scenario == "rate_limit":
            send({"id": mid, "error": {"code": -32003, "message": "Request failed"}})
        else:
            send({"id": mid, "result": {"stopReason": "end_turn"}})
"##;

#[cfg(unix)]
struct Run {
    events: Vec<DriverEvent>,
    received: Vec<Value>,
    argv: Value,
}

#[cfg(unix)]
impl Run {
    /// What Kybern answered to Grok's own request.
    fn reply(&self) -> &Value {
        self.received.iter().find(|msg| msg["id"] == "grok-1").map(|msg| &msg["result"]).expect("Kybern answered Grok's request")
    }
    fn end(&self) -> &DriverEvent {
        self.events
            .iter()
            .find(|event| matches!(event, DriverEvent::TurnCompleted { .. } | DriverEvent::TurnFailed { .. }))
            .expect("the turn ended")
    }
    fn texts(&self) -> String {
        self.events
            .iter()
            .filter_map(|event| if let DriverEvent::TextDelta { delta, .. } = event { Some(delta.as_str()) } else { None })
            .collect()
    }
}

/// One turn against the fake `grok`; every card is answered with `answer`.
#[cfg(unix)]
async fn run_turn(scenario: &str, mode: PermissionMode, resume: Option<&str>, answer: ApprovalDecision) -> Run {
    let root = tempfile::tempdir().unwrap();
    let binary = root.path().join("grok");
    kybern_protocol::process::write_executable(&binary, FAKE_GROK).unwrap();
    let config = SessionConfig {
        cwd: root.path().into(),
        model: None,
        effort: None,
        permission_mode: mode,
        native_tool_bridge: None,
        resume_session_id: resume.map(str::to_owned),
        resume_lacks_instructions: false,
        fork: false,
        rewind: None,
        binary: Some(binary),
        env: HashMap::from([("FAKE_GROK".into(), scenario.into())]),
        compaction: Default::default(),
    };
    // Another test's forked child can briefly hold the new script open (Linux ETXTBSY).
    let mut attempts = 0;
    let spawned = loop {
        match tokio::time::timeout(Duration::from_secs(20), GrokDriver.spawn(config.clone())).await.expect("the session starts") {
            Err(DriverError::Io(error)) if error.kind() == std::io::ErrorKind::ExecutableFileBusy && attempts < 50 => {
                attempts += 1;
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            result => break result.unwrap(),
        }
    };
    let SpawnedSession { session, mut events } = spawned;
    session.send_message("m1", &UserMessage::text("Go")).await.unwrap();
    let mut seen = Vec::new();
    let turn = async {
        while let Some(event) = events.recv().await {
            if let DriverEvent::PermissionRequest { request_id, .. } = &event {
                session.respond_permission(request_id, &answer).await.unwrap();
            }
            let done = matches!(event, DriverEvent::TurnCompleted { .. } | DriverEvent::TurnFailed { .. });
            seen.push(event);
            if done {
                break;
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(20), turn).await.expect("the turn ends");
    session.close().await.unwrap();
    let received = std::fs::read_to_string(root.path().join("received.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let argv = serde_json::from_str(&std::fs::read_to_string(root.path().join("argv.json")).unwrap()).unwrap();
    Run { events: seen, received, argv }
}

#[cfg(unix)]
#[tokio::test]
async fn supervised_sessions_ask_through_kybern_and_allow_always_grants_this_session_only() {
    let run = run_turn("permission", PermissionMode::Supervised, None, ApprovalDecision::AllowAlways).await;
    assert_eq!(run.argv["argv"], json!(["--no-auto-update", "--permission-mode", "default", "agent", "stdio"]));
    assert_eq!(run.argv["autoupdater"], "1");
    assert_eq!(run.received[0]["params"]["_meta"], json!({ "clientType": "extension" }));
    let card = run.events.iter().find_map(|event| match event {
        DriverEvent::PermissionRequest { tool_name, summary, tool_call_id, .. } => {
            Some((tool_name.clone(), summary.clone(), tool_call_id.clone()))
        }
        _ => None,
    });
    assert_eq!(card, Some(("edit".into(), "Edit src/a.rs".into(), Some("t1".into()))));
    assert_eq!(run.reply(), &json!({ "outcome": { "outcome": "selected", "optionId": "allow-edits-session" } }));
    assert!(matches!(run.end(), DriverEvent::TurnCompleted { stop_reason: StopReason::Completed, .. }));
}

#[cfg(unix)]
#[tokio::test]
async fn full_access_is_always_approve_and_answers_without_a_card() {
    let run = run_turn("permission", PermissionMode::FullAccess, None, ApprovalDecision::Deny { reason: None }).await;
    assert_eq!(run.argv["argv"], json!(["--no-auto-update", "agent", "--always-approve", "stdio"]));
    assert!(!run.events.iter().any(|event| matches!(event, DriverEvent::PermissionRequest { .. })));
    assert_eq!(run.reply()["outcome"]["optionId"], "allow-once");
}

#[cfg(unix)]
#[tokio::test]
async fn ask_user_and_plan_exit_reach_the_user_and_answer_grok() {
    let answer = ApprovalDecision::Submit { response: json!({ "answers": { "Which layout?": "Grid" } }) };
    let run = run_turn("question", PermissionMode::FullAccess, None, answer).await;
    assert!(
        run.events.iter().any(|event| matches!(event, DriverEvent::PermissionRequest { tool_name, .. } if tool_name == "AskUserQuestion"))
    );
    assert_eq!(run.reply(), &json!({ "outcome": "accepted", "answers": { "Which layout?": ["Grid"] } }));

    let run = run_turn("plan", PermissionMode::Auto, None, ApprovalDecision::Deny { reason: Some("Add tests".into()) }).await;
    assert_eq!(run.argv["argv"], json!(["--no-auto-update", "--permission-mode", "auto", "agent", "stdio"]));
    assert!(run.events.iter().any(|event| matches!(event, DriverEvent::PermissionRequest { tool_name, input, .. }
        if tool_name == "ExitPlanMode" && input["plan"] == "# Plan\n1. Ship it")));
    assert_eq!(run.reply(), &json!({ "outcome": "request_changes", "feedback": "Add tests" }));
}

#[cfg(unix)]
#[tokio::test]
async fn a_prompt_grok_completes_by_notice_ends_the_turn_and_usage_limits_are_named() {
    let run = run_turn("prompt_complete", PermissionMode::Supervised, None, ApprovalDecision::AllowOnce).await;
    assert!(matches!(run.end(), DriverEvent::TurnCompleted { stop_reason: StopReason::Completed, .. }));
    assert_eq!(run.texts(), "new answer");
    let prompt = run.received.iter().find(|msg| msg["method"] == "session/prompt").unwrap();
    assert!(prompt["params"]["_meta"]["promptId"].as_str().is_some_and(|id| id.starts_with("kybern-")));

    let run = run_turn("rate_limit", PermissionMode::Supervised, None, ApprovalDecision::AllowOnce).await;
    let DriverEvent::TurnFailed { problem, .. } = run.end() else { panic!("{:?}", run.end()) };
    assert_eq!(problem.as_ref().and_then(|problem| problem.subject.as_deref()), Some("rate_limit"));
}

#[cfg(unix)]
#[tokio::test]
async fn a_resume_grok_never_answers_opens_once_its_replay_goes_quiet() {
    let started = std::time::Instant::now();
    let run = run_turn("load_hangs", PermissionMode::Supervised, Some("s-old"), ApprovalDecision::AllowOnce).await;
    assert!(started.elapsed() < Duration::from_secs(15), "{:?}", started.elapsed());
    assert!(matches!(&run.events[0], DriverEvent::SessionBound { session_id, .. } if session_id == "s-old"));
    // The replay is history: only the new answer is output.
    assert_eq!(run.texts(), "new answer");
    assert!(matches!(run.end(), DriverEvent::TurnCompleted { .. }));
}
