use super::*;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn session(base: &str) -> (Arc<OpencodeSession>, mpsc::Receiver<DriverEvent>) {
    let (events, rx) = mpsc::channel(64);
    let mut command = crate::test_process::sleep();
    command.arg("30").kill_on_drop(true);
    let session = Arc::new(OpencodeSession {
        server: Api { http: reqwest::Client::new(), base: base.into(), password: "pw".into() },
        child: Mutex::new(command.spawn().unwrap()),
        events,
        state: Mutex::new(State::new("ses_root".into(), Vec::new())),
    });
    (session, rx)
}

fn event(ty: &str, data: Value) -> Value {
    json!({ "id": "evt", "type": ty, "data": data })
}

/// Accept `count` requests, answer each with `{"data":{"id":"msg_x"}}`, return them raw.
async fn mock(count: usize) -> (String, tokio::task::JoinHandle<Vec<String>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let mut requests = vec![];
        for _ in 0..count {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = vec![];
            loop {
                let mut chunk = [0; 4096];
                let read = socket.read(&mut chunk).await.unwrap();
                assert!(read > 0);
                bytes.extend_from_slice(&chunk[..read]);
                let text = String::from_utf8_lossy(&bytes);
                if let Some(end) = text.find("\r\n\r\n") {
                    let length: usize = text[..end]
                        .lines()
                        .find_map(|line| line.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap()))
                        .unwrap_or(0);
                    if bytes.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            requests.push(String::from_utf8(bytes).unwrap());
            let body = r#"{"data":{"id":"msg_x"}}"#;
            let reply = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(reply.as_bytes()).await.unwrap();
        }
        requests
    });
    (base, server)
}

fn body(request: &str) -> Value {
    serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap()
}

#[tokio::test]
async fn a_root_turn_maps_v2_events_and_anchors_the_user_message() {
    let (base, server) = mock(1).await;
    let (session, mut rx) = session(&base);
    let handle = Handle(session.clone(), std::sync::Mutex::new(None), None);
    handle.send_message("kybern-id", &UserMessage::text("hello")).await.unwrap();
    let requests = server.await.unwrap();
    assert!(requests[0].starts_with("POST /api/session/ses_root/prompt "));
    assert!(requests[0].to_lowercase().contains("authorization: basic b3blbmnvzgu6chc="), "basic auth as opencode:pw");
    assert_eq!(body(&requests[0])["text"], "hello");
    session.state.lock().await.context_windows.insert("p/m".into(), 1000);
    let frames = [
        event("session.execution.started", json!({"sessionID":"ses_root"})),
        event("session.step.started", json!({"sessionID":"ses_root","model":{"providerID":"p","id":"m"},"assistantMessageID":"msg_a"})),
        event("session.reasoning.delta", json!({"sessionID":"ses_root","assistantMessageID":"msg_a","ordinal":0,"delta":"hm"})),
        event("session.reasoning.ended", json!({"sessionID":"ses_root","assistantMessageID":"msg_a","ordinal":0,"text":"hm"})),
        event("session.tool.input.started", json!({"sessionID":"ses_root","assistantMessageID":"msg_a","id":"call_1","name":"shell"})),
        event("session.tool.called", json!({"sessionID":"ses_root","assistantMessageID":"msg_a","id":"call_1","input":{"command":"ls"}})),
        event(
            "session.tool.success",
            json!({"sessionID":"ses_root","id":"call_1","content":[{"type":"text","text":"a.txt"}],"metadata":{"exit":0}}),
        ),
        event(
            "session.step.ended",
            json!({"sessionID":"ses_root","tokens":{"input":100,"output":10,"reasoning":5,"cache":{"read":50,"write":0}},"cost":0.5}),
        ),
        event("session.text.delta", json!({"sessionID":"ses_root","assistantMessageID":"msg_b","ordinal":1,"delta":"po"})),
        event("session.text.ended", json!({"sessionID":"ses_root","assistantMessageID":"msg_b","ordinal":1,"text":"pong"})),
        // Another session's events never reach this thread.
        event("session.text.ended", json!({"sessionID":"ses_other","assistantMessageID":"msg_c","ordinal":0,"text":"leak"})),
        event("session.execution.succeeded", json!({"sessionID":"ses_root"})),
    ];
    for frame in &frames {
        session.handle_event(frame).await;
    }
    let mut shape = Vec::new();
    while let Ok(event) = rx.try_recv() {
        shape.push(match event {
            DriverEvent::ThinkingDelta { message_id, delta, .. } => format!("think {message_id} {delta}"),
            DriverEvent::ThinkingCompleted { message_id, .. } => format!("thought {message_id}"),
            DriverEvent::ToolStarted(call) => format!("tool {} {} {}", call.name, call.id, call.input["command"]),
            DriverEvent::ToolCompleted { tool_call_id, output, is_error } => {
                format!("done {tool_call_id} {} {is_error}", output["content"])
            }
            DriverEvent::UsageUpdated(usage) => {
                let context = usage.context.unwrap();
                format!("context {}/{}", context.used_tokens, context.window_tokens)
            }
            DriverEvent::TextDelta { message_id, delta, .. } => format!("text {message_id} {delta}"),
            DriverEvent::MessageCompleted { message_id, text, .. } => format!("message {message_id} {text}"),
            DriverEvent::TurnCompleted { stop_reason, usage, cost_usd, anchors, .. } => format!(
                "turn {stop_reason:?} in={} out={} cache={} cost={cost_usd:?} anchor={:?}",
                usage.input_tokens, usage.output_tokens, usage.cache_read_tokens, anchors.turn_id
            ),
            other => panic!("unexpected {other:?}"),
        });
    }
    assert_eq!(
        shape,
        [
            "think msg_a hm",
            "thought msg_a",
            "tool shell call_1 \"ls\"",
            "done call_1 \"a.txt\" false",
            "context 165/1000",
            "text msg_b:1 po",
            "message msg_b:1 pong",
            "turn Completed in=100 out=15 cache=50 cost=Some(0.5) anchor=Some(\"msg_x\")",
        ]
    );
}

#[tokio::test]
async fn interrupted_and_failed_executions_end_the_turn() {
    let (session, mut rx) = session("http://127.0.0.1:9");
    session.handle_event(&event("session.execution.started", json!({"sessionID":"ses_root"}))).await;
    session.handle_event(&event("session.execution.interrupted", json!({"sessionID":"ses_root","reason":"user"}))).await;
    assert!(matches!(rx.recv().await, Some(DriverEvent::TurnCompleted { stop_reason: StopReason::Interrupted, .. })));
    session.handle_event(&event("session.execution.started", json!({"sessionID":"ses_root"}))).await;
    session
        .handle_event(&event(
            "session.execution.failed",
            json!({"sessionID":"ses_root","error":{"type":"provider.auth","message":"denied"}}),
        ))
        .await;
    let Some(DriverEvent::TurnFailed { error, problem }) = rx.recv().await else { panic!("the turn must fail") };
    assert_eq!(error, "provider.auth: denied");
    let problem = problem.expect("a signed-out problem");
    assert_eq!((problem.kind, problem.subject.as_deref()), (kybern_protocol::rpc::ProblemKind::SignedOut, Some("opencode")));
}

#[tokio::test]
async fn subagent_output_reaches_its_thread_and_never_the_root() {
    let (session, mut rx) = session("http://127.0.0.1:9");
    let frames = [
        event("session.tool.input.started", json!({"sessionID":"ses_root","id":"call_s","name":"subagent"})),
        event(
            "session.tool.called",
            json!({"sessionID":"ses_root","id":"call_s","input":{"agent":"general","description":"Look around","prompt":"List files"}}),
        ),
        event("session.created", json!({"sessionID":"ses_kid","parentID":"ses_root","title":"Look around (@general subagent)"})),
        event("session.tool.progress", json!({"sessionID":"ses_root","id":"call_s","metadata":{"sessionID":"ses_kid","status":"running"}})),
        event("session.tool.input.started", json!({"sessionID":"ses_kid","id":"c1","name":"glob"})),
        event("session.tool.called", json!({"sessionID":"ses_kid","id":"c1","input":{"pattern":"*"}})),
        event("session.tool.success", json!({"sessionID":"ses_kid","id":"c1","content":[{"type":"text","text":"a.txt"}]})),
        event("session.text.delta", json!({"sessionID":"ses_kid","assistantMessageID":"msg_k","ordinal":0,"delta":"One"})),
        event("session.text.ended", json!({"sessionID":"ses_kid","assistantMessageID":"msg_k","ordinal":0,"text":"One file."})),
        event("session.execution.succeeded", json!({"sessionID":"ses_kid"})),
    ];
    for frame in &frames {
        session.handle_event(frame).await;
    }
    let mut shape = Vec::new();
    while let Ok(event) = rx.try_recv() {
        shape.push(match event {
            DriverEvent::ToolStarted(call) => format!("root tool {}", call.name),
            DriverEvent::RuntimeTaskStarted(task) => {
                format!("task {} {} {:?} {:?}", task.id, task.title, task.tool_call_id, task.provider_type)
            }
            DriverEvent::RuntimeTaskUpdated(update) => format!("update {:?}", update.last_tool_name),
            DriverEvent::RuntimeTaskCompleted(update) => format!("completed {:?}", update.status),
            DriverEvent::SubagentOnly { task_id, event } => {
                assert_eq!(task_id, "opencode:ses_kid");
                match *event {
                    DriverEvent::ToolStarted(call) => format!("kid tool {}", call.name),
                    DriverEvent::ToolCompleted { tool_call_id, .. } => format!("kid done {tool_call_id}"),
                    DriverEvent::TextDelta { delta, .. } => format!("kid text {delta}"),
                    DriverEvent::MessageCompleted { text, .. } => format!("kid message {text}"),
                    other => panic!("unexpected {other:?}"),
                }
            }
            DriverEvent::TextDelta { .. } | DriverEvent::MessageCompleted { .. } => panic!("child prose leaked to the root"),
            other => panic!("unexpected {other:?}"),
        });
    }
    assert_eq!(
        shape,
        [
            "root tool subagent",
            "task opencode:ses_kid Look around None None",
            "task opencode:ses_kid Look around Some(\"call_s\") Some(\"task:general\")",
            "kid tool glob",
            "update Some(\"glob\")",
            "kid done c1",
            "kid text One",
            "kid message One file.",
            "completed Some(Completed)",
        ]
    );
}

#[tokio::test]
async fn permissions_and_forms_reply_to_their_native_endpoints() {
    let (base, server) = mock(4).await;
    let (session, mut rx) = session(&base);
    let handle = Handle(session.clone(), std::sync::Mutex::new(None), None);
    session
        .handle_event(&event(
            "permission.asked",
            json!({"id":"per_1","sessionID":"ses_root","action":"shell","resources":["echo hi"],"save":["echo *"],"source":{"type":"tool","messageID":"m","id":"call_1"}}),
        ))
        .await;
    let Some(DriverEvent::PermissionRequest { request_id, tool_call_id, tool_name, summary, suggestions, .. }) = rx.recv().await else {
        panic!("missing permission")
    };
    assert_eq!(
        (request_id.as_str(), tool_call_id.as_deref(), tool_name.as_str(), summary.as_str()),
        ("per_1", Some("call_1"), "shell", "run: echo hi")
    );
    assert_eq!(suggestions, vec![json!("echo *")]);
    handle.respond_permission("per_1", &ApprovalDecision::AllowAlways).await.unwrap();

    let form = json!({"id":"frm_1","sessionID":"ses_root","title":"Questions","metadata":{"kind":"question","tool":{"id":"call_q"}},"fields":[
        {"key":"q0","title":"Color","description":"Which color?","type":"string","options":[{"value":"red","label":"Red"},{"value":"blue","label":"Blue"}],"custom":true},
        {"key":"q1","type":"multiselect","description":"Which sizes?","options":[{"value":"s","label":"Small"},{"value":"l","label":"Large"}]},
        {"key":"q2","type":"boolean","title":"Ship it?"}
    ]});
    session.handle_event(&event("form.created", json!({ "form": form }))).await;
    let Some(DriverEvent::PermissionRequest { tool_name, input, .. }) = rx.recv().await else { panic!("missing question") };
    assert_eq!(tool_name, "opencode_question");
    assert_eq!(input["questions"][0]["question"], "Which color?");
    assert_eq!(input["questions"][0]["header"], "Color");
    assert_eq!(input["questions"][1]["multiple"], true);
    assert_eq!(input["questions"][2]["options"][0]["label"], "Yes");
    assert_eq!(input["questions"][2]["custom"], false);
    let approval: ApprovalRequest = serde_json::from_value(json!({"id":"00000000-0000-0000-0000-000000000001","thread_id":"00000000-0000-0000-0000-000000000002","turn_id":"00000000-0000-0000-0000-000000000003","tool_name":tool_name,"input":input,"summary":"Question","created_at":"2026-10-28T00:00:00Z"})).unwrap();
    let response = json!({"answers":[["Blue"],["Small","Large"],["Yes"]]});
    assert!(approval.validate_decision(&ApprovalDecision::Submit { response: response.clone() }).is_ok());
    handle.respond_permission("frm_1", &ApprovalDecision::Submit { response }).await.unwrap();

    session
        .handle_event(&event(
            "form.created",
            json!({ "form": {"id":"frm_2","sessionID":"ses_root","title":"Q","fields":[{"key":"q0","type":"string"}]} }),
        ))
        .await;
    assert!(matches!(rx.recv().await, Some(DriverEvent::PermissionRequest { .. })));
    handle.respond_permission("frm_2", &ApprovalDecision::Deny { reason: None }).await.unwrap();

    session
        .handle_event(&event("permission.asked", json!({"id":"per_2","sessionID":"ses_root","action":"edit","resources":["a.rs"]})))
        .await;
    assert!(matches!(rx.recv().await, Some(DriverEvent::PermissionRequest { summary, .. }) if summary == "edit: a.rs"));
    handle.respond_permission("per_2", &ApprovalDecision::Deny { reason: Some("not now".into()) }).await.unwrap();

    let requests = tokio::time::timeout(Duration::from_secs(2), server).await.unwrap().unwrap();
    assert!(requests[0].starts_with("POST /api/session/ses_root/permission/per_1/reply "));
    assert_eq!(body(&requests[0]), json!({"decision":"always","message":null}));
    assert!(requests[1].starts_with("POST /api/session/ses_root/form/frm_1/reply "));
    assert_eq!(body(&requests[1]), json!({"answer":{"q0":"blue","q1":["s","l"],"q2":true}}));
    assert!(requests[2].starts_with("DELETE /api/session/ses_root/form/frm_2 "));
    assert_eq!(body(&requests[3]), json!({"decision":"reject","message":"not now"}));
    assert!(session.state.lock().await.pending.is_empty());

    // A reply from another client withdraws the card.
    session.handle_event(&event("permission.asked", json!({"id":"per_3","sessionID":"ses_root","action":"shell","resources":["x"]}))).await;
    rx.recv().await.unwrap();
    session.handle_event(&event("permission.replied", json!({"sessionID":"ses_root","requestID":"per_3","reply":"once"}))).await;
    assert!(matches!(rx.recv().await, Some(DriverEvent::PermissionWithdrawn { request_id }) if request_id == "per_3"));
}

#[tokio::test]
async fn skills_commands_mode_and_model_use_v2_endpoints() {
    let (base, server) = mock(4).await;
    let (session, _rx) = session(&base);
    session.state.lock().await.commands =
        vec![ProviderCommand { name: "review".into(), description: "Review".into(), ..Default::default() }];
    let handle = Handle(session.clone(), std::sync::Mutex::new(None), None);
    let skill = UserMessage {
        parts: vec![ContentPart::Skill { name: "demo".into(), path: "/x/SKILL.md".into() }, ContentPart::Text { text: " go".into() }],
    };
    handle.send_message("a", &skill).await.unwrap();
    handle.send_message("b", &UserMessage::text("/review changed files")).await.unwrap();
    handle.set_permission_mode(PermissionMode::AcceptEdits).await.unwrap();
    handle.set_model("openrouter/openai/gpt-x#high").await.unwrap();
    let requests = tokio::time::timeout(Duration::from_secs(2), server).await.unwrap().unwrap();
    assert_eq!(body(&requests[0])["skills"], json!([{"id":"demo"}]));
    assert_eq!(body(&requests[0])["text"], "/demo go");
    assert!(requests[1].starts_with("POST /api/session/ses_root/command "));
    assert_eq!(body(&requests[1])["name"], "review");
    assert_eq!(body(&requests[1])["text"], "changed files");
    assert!(requests[2].starts_with("PATCH /api/session/ses_root "));
    assert_eq!(body(&requests[2])["permissions"][1], json!({"action":"shell","resource":"*","effect":"ask"}));
    assert_eq!(body(&requests[3]), json!({"model":{"providerID":"openrouter","id":"openai/gpt-x","variant":"high"}}));
}

#[test]
fn a_coordinator_keeps_only_kybern_tools_after_any_mode() {
    let mut bridge = NativeToolBridge {
        server_name: "kybern".into(),
        endpoint: Some("http://127.0.0.1:4199/native-tools/mcp".into()),
        authorization: Some("cap".into()),
        coordinator_instructions: None,
        guide: None,
        tools: vec![],
        restrictions: crate::NativeToolRestrictions {
            allowed_tools: vec![],
            denied_tools: vec![],
            require_enforcement: true,
            allow_read_only_builtins: false,
            allowed_mcp_servers: Default::default(),
        },
    };
    let rules = restriction_rules(Some(&bridge));
    assert_eq!(rules, [json!({"action":"*","resource":"*","effect":"deny"}), json!({"action":"kybern_*","resource":"*","effect":"allow"})]);
    bridge.restrictions.allowed_mcp_servers.insert("memory".into(), json!({}));
    assert!(restriction_rules(Some(&bridge)).contains(&json!({"action":"memory_*","resource":"*","effect":"allow"})));
    assert!(!restriction_rules(Some(&bridge)).iter().any(|rule| rule["action"] == "other_*"));
    bridge.restrictions.allow_read_only_builtins = true;
    let rules = restriction_rules(Some(&bridge));
    assert!(rules.contains(&json!({"action":"read","resource":"*","effect":"allow"})));
    assert!(!rules.iter().any(|rule| rule["action"] == "edit" || rule["action"] == "shell"));
    bridge.restrictions.require_enforcement = false;
    assert!(restriction_rules(Some(&bridge)).is_empty());
    assert_eq!(ruleset(PermissionMode::FullAccess), [json!({"action":"*","resource":"*","effect":"allow"})]);
    assert_eq!(ruleset(PermissionMode::Auto).last().unwrap()["action"], "external_directory");
}

#[test]
fn parses_the_v2_skill_catalog() {
    let cwd = Path::new("/work/app");
    let skills = parse_skills(
        &[
            json!({"id":"opencode","name":"OpenCode","path":"/builtin/opencode.md","content":""}),
            json!({"id":"demo","name":"demo","description":" Demo ","path":"/work/app/.opencode/skills/demo/SKILL.md","content":""}),
            json!({"id":"Demo","name":"dup","path":"/x","content":""}),
            json!({"id":"tdd","name":"tdd","path":"/home/me/.config/opencode/skills/tdd/SKILL.md","content":""}),
        ],
        cwd,
    );
    let shape: Vec<_> = skills.iter().map(|s| (s.name.as_str(), s.display_name.as_deref(), s.scope)).collect();
    assert_eq!(
        shape,
        [("demo", None, SkillScope::Project), ("opencode", Some("OpenCode"), SkillScope::System), ("tdd", None, SkillScope::User)]
    );
    assert_eq!(skills[0].description.as_deref(), Some("Demo"));
}

#[tokio::test]
async fn steering_needs_a_running_turn_and_uses_native_delivery() {
    let (base, server) = mock(1).await;
    let (session, _rx) = session(&base);
    let handle = Handle(session.clone(), std::sync::Mutex::new(None), None);
    assert!(matches!(handle.steer("s", &UserMessage::text("also check tests")).await, Err(DriverError::Unsupported(_))));
    session.state.lock().await.active = true;
    handle.steer("s", &UserMessage::text("also check tests")).await.unwrap();
    let requests = server.await.unwrap();
    assert!(requests[0].starts_with("POST /api/session/ses_root/prompt "));
    assert_eq!(body(&requests[0])["delivery"], "steer");
    assert_eq!(body(&requests[0])["text"], "also check tests");
}

#[test]
fn model_reference_carries_an_effort_as_the_variant() {
    assert_eq!(model_ref("p/m", None), Some(json!({"providerID": "p", "id": "m"})));
    assert_eq!(model_ref("p/m", Some("high")), Some(json!({"providerID": "p", "id": "m", "variant": "high"})));
    assert_eq!(model_ref("p/m#low", Some("high")), Some(json!({"providerID": "p", "id": "m", "variant": "high"})));
    assert_eq!(model_ref("p/m#low", None), Some(json!({"providerID": "p", "id": "m", "variant": "low"})));
    assert_eq!(model_ref("p/m", Some(" ")), Some(json!({"providerID": "p", "id": "m"})));
    assert_eq!(model_ref("nomodel", Some("high")), None);
}

#[tokio::test]
async fn a_model_switch_carries_the_current_effort() {
    let (base, server) = mock(1).await;
    let (session, _rx) = session(&base);
    session.state.lock().await.model = Some("p/m".into());
    session.state.lock().await.effort = Some("xhigh".into());
    let handle = Handle(session.clone(), std::sync::Mutex::new(None), None);
    handle.set_model("q/n").await.unwrap();
    let requests = server.await.unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].starts_with("POST /api/session/ses_root/model "));
    assert_eq!(body(&requests[0])["model"], json!({"providerID": "q", "id": "n", "variant": "xhigh"}));
    let state = session.state.lock().await;
    assert_eq!(state.model.as_deref(), Some("q/n"));
    assert_eq!(state.effort.as_deref(), Some("xhigh"));
}

#[tokio::test]
async fn an_effort_switch_resends_the_current_model_with_the_variant() {
    let (base, server) = mock(2).await;
    let (session, _rx) = session(&base);
    session.state.lock().await.model = Some("p/m".into());
    let handle = Handle(session.clone(), std::sync::Mutex::new(None), None);
    handle.set_effort("xhigh").await.unwrap();
    // A stored `#variant` must not shadow the switch: it is stripped, so the
    // new effort wins and the stored model drops its variant.
    session.state.lock().await.model = Some("p/m#low".into());
    handle.set_effort("high").await.unwrap();
    session.state.lock().await.model = None;
    assert!(matches!(handle.set_effort("high").await, Err(DriverError::Unsupported(_))));
    let requests = server.await.unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[0].starts_with("POST /api/session/ses_root/model "));
    assert_eq!(body(&requests[0])["model"], json!({"providerID": "p", "id": "m", "variant": "xhigh"}));
    assert_eq!(body(&requests[1])["model"], json!({"providerID": "p", "id": "m", "variant": "high"}));
}

// --- Subagent rules, resumed subagents and turn recovery --------------------------------------------------

use crate::opencode::resilience_tests::{Mock, Reply, frame};

fn drain(rx: &mut mpsc::Receiver<DriverEvent>) -> Vec<DriverEvent> {
    std::iter::from_fn(|| rx.try_recv().ok()).collect()
}

/// A subagent call by the root thread, its session, and the progress event that ties them together.
async fn start_subagent(session: &OpencodeSession, call: &str, child: &str) {
    for frame in [
        event("session.tool.input.started", json!({"sessionID":"ses_root","id":call,"name":"subagent"})),
        event("session.tool.called", json!({"sessionID":"ses_root","id":call,"input":{"agent":"general","description":"Look around"}})),
        event("session.tool.progress", json!({"sessionID":"ses_root","id":call,"metadata":{"sessionID":child,"status":"running"}})),
    ] {
        session.handle_event(&frame).await;
    }
}

#[tokio::test]
async fn a_new_subagent_inherits_the_rules_and_a_mode_change_rewrites_the_running_ones() {
    let mock = Mock::start(|_, _, _| Reply::Json(200, json!({}))).await;
    let (session, _rx) = session(&mock.base);
    let scope = vec![json!({"action":"*","resource":"*","effect":"deny"}), json!({"action":"kybern_*","resource":"*","effect":"allow"})];
    session.state.lock().await.restrictions = scope.clone();
    let handle = Handle(session.clone(), std::sync::Mutex::new(None), None);
    // OpenCode 2 copies the parent's whole ruleset into a subagent it creates: nothing to write.
    session
        .handle_event(&event("session.created", json!({"sessionID":"ses_kid","parentID":"ses_root","title":"A (@general subagent)"})))
        .await;
    session
        .handle_event(&event("session.created", json!({"sessionID":"ses_done","parentID":"ses_root","title":"B (@general subagent)"})))
        .await;
    session.handle_event(&event("session.execution.succeeded", json!({"sessionID":"ses_done"}))).await;
    assert!(mock.requests("PATCH", "/api/session/ses_kid").is_empty());

    handle.set_permission_mode(PermissionMode::AcceptEdits).await.unwrap();

    let expected: Vec<Value> = ruleset(PermissionMode::AcceptEdits).into_iter().chain(scope).collect();
    assert_eq!(session.state.lock().await.mode, PermissionMode::AcceptEdits);
    for id in ["ses_root", "ses_kid"] {
        let writes = mock.requests("PATCH", &format!("/api/session/{id}"));
        assert_eq!(writes.len(), 1, "{id}");
        assert_eq!(writes[0].body["permissions"], json!(expected), "{id} keeps the coordinator's tool scope too");
    }
    assert!(mock.requests("PATCH", "/api/session/ses_done").is_empty(), "a finished subagent is left alone");
}

#[tokio::test]
async fn a_resumed_subagent_reports_its_new_run_and_is_given_the_current_rules() {
    let mock = Mock::start(|_, _, _| Reply::Json(200, json!({}))).await;
    let (session, mut rx) = session(&mock.base);
    let ends = |events: Vec<DriverEvent>| -> Vec<String> {
        events
            .into_iter()
            .filter_map(|event| match event {
                DriverEvent::RuntimeTaskStarted(task) => Some(format!("started {:?}", task.tool_call_id)),
                DriverEvent::RuntimeTaskCompleted(update) => Some(format!("completed {:?}", update.status)),
                _ => None,
            })
            .collect()
    };
    session
        .handle_event(&event("session.created", json!({"sessionID":"ses_kid","parentID":"ses_root","title":"A (@general subagent)"})))
        .await;
    start_subagent(&session, "call_1", "ses_kid").await;
    session.handle_event(&event("session.execution.succeeded", json!({"sessionID":"ses_kid"}))).await;
    // The same call reporting again is not a new run.
    session
        .handle_event(&event("session.tool.progress", json!({"sessionID":"ses_root","id":"call_1","metadata":{"sessionID":"ses_kid"}})))
        .await;
    session.handle_event(&event("session.execution.succeeded", json!({"sessionID":"ses_kid"}))).await;
    assert_eq!(ends(drain(&mut rx)), ["started None", "started Some(\"call_1\")", "completed Some(Completed)", "started Some(\"call_1\")"]);
    assert!(mock.requests("PATCH", "/api/session/ses_kid").is_empty(), "it was created under the current rules");

    // A second call resumes the same session: it may hold an older mode's rules.
    start_subagent(&session, "call_2", "ses_kid").await;
    session.handle_event(&event("session.execution.succeeded", json!({"sessionID":"ses_kid"}))).await;
    assert_eq!(ends(drain(&mut rx)), ["started Some(\"call_2\")", "completed Some(Completed)"]);
    let writes = mock.requests("PATCH", "/api/session/ses_kid");
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].body["permissions"], json!(ruleset(PermissionMode::Supervised)));

    // A session this server never created, seen for the first time, gets them as well.
    start_subagent(&session, "call_3", "ses_old").await;
    assert_eq!(mock.requests("PATCH", "/api/session/ses_old").len(), 1);
}

#[tokio::test]
async fn a_model_switch_leaves_off_an_effort_the_new_model_does_not_list() {
    let mock = Mock::start(|_, _, _| Reply::Json(200, json!({}))).await;
    let (session, _rx) = session(&mock.base);
    {
        let mut state = session.state.lock().await;
        state.model = Some("p/m".into());
        state.effort = Some("xhigh".into());
        state.model_variants = HashMap::from([
            ("q/plain".to_string(), HashSet::new()),
            ("q/low-only".to_string(), HashSet::from(["low".to_string()])),
            ("q/full".to_string(), HashSet::from(["low".to_string(), "xhigh".to_string()])),
        ]);
    }
    let handle = Handle(session.clone(), std::sync::Mutex::new(None), None);
    for model in ["q/plain", "q/low-only", "q/full", "q/never-listed"] {
        handle.set_model(model).await.unwrap();
    }
    let models: Vec<Value> =
        mock.requests("POST", "/api/session/ses_root/model").into_iter().map(|seen| seen.body["model"].clone()).collect();
    assert_eq!(
        models,
        [
            json!({"providerID": "q", "id": "plain"}),
            json!({"providerID": "q", "id": "low-only"}),
            json!({"providerID": "q", "id": "full", "variant": "xhigh"}),
            json!({"providerID": "q", "id": "never-listed", "variant": "xhigh"}),
        ],
        "an unknown model keeps the choice, as before"
    );
    assert_eq!(session.state.lock().await.effort.as_deref(), Some("xhigh"), "the choice stays for a model that lists it");
}

#[tokio::test]
async fn the_model_catalog_gives_windows_by_input_limit_and_the_variants_each_model_lists() {
    let mock = Mock::start(|_, path, _| match path {
        "/api/model" => Reply::Json(
            200,
            json!({"data": [
                {"id": "wide", "providerID": "p", "limit": {"context": 1_000_000, "input": 900_000}, "variants": [{"id": "low"}, {"id": "high"}]},
                {"id": "plain", "providerID": "p", "limit": {"context": 200_000}, "variants": []},
            ]}),
        ),
        _ => Reply::Json(200, json!({"data": []})),
    })
    .await;
    let (session, _rx) = session(&mock.base);
    session.discover_metadata().await;
    let state = session.state.lock().await;
    assert_eq!((state.context_windows["p/wide"], state.context_windows["p/plain"]), (900_000, 200_000));
    assert_eq!(state.model_variants["p/wide"], HashSet::from(["low".to_string(), "high".to_string()]));
    assert!(state.model_variants["p/plain"].is_empty());
}

#[tokio::test]
async fn text_split_in_the_middle_of_a_character_arrives_whole() {
    let delta = "caf\u{e9} \u{1f980} \u{4e2d}";
    let bytes = frame(event("session.text.delta", json!({"sessionID":"ses_root","assistantMessageID":"msg_a","ordinal":0,"delta":delta})));
    // Cut inside the crab's four bytes.
    let cut = bytes.windows(4).position(|window| window == "\u{1f980}".as_bytes()).unwrap() + 2;
    let mock = Mock::start(move |_, _, _| Reply::Stream(vec![bytes[..cut].to_vec(), bytes[cut..].to_vec()])).await;
    let (session, mut rx) = session(&mock.base);
    let looping = tokio::spawn(session.clone().event_loop_with(None, Duration::from_secs(5)));
    let Some(DriverEvent::TextDelta { delta: received, .. }) = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.unwrap()
    else {
        panic!("no text")
    };
    looping.abort();
    assert_eq!(received, delta);
}

/// A turn waiting on `msg_x` with a stream that says nothing, over a server that stored `stored` (newest first).
async fn settle(active: Value, stored: Vec<Value>, live_text: Option<&str>) -> Vec<DriverEvent> {
    let mock = Mock::start(move |method, path, _| match (method, path) {
        ("GET", "/api/event") => Reply::Stream(vec![frame(event("server.heartbeat", json!({})))]),
        ("GET", "/api/session/active") => Reply::Json(200, json!({ "data": active })),
        ("GET", "/api/session/ses_root/message") => Reply::Json(200, json!({ "data": stored })),
        _ => Reply::Json(200, json!({})),
    })
    .await;
    let (session, mut rx) = session(&mock.base);
    {
        let mut state = session.state.lock().await;
        state.active = true;
        state.turn_started = Some(std::time::Instant::now());
        state.current_message_id = Some("msg_x".into());
    }
    if let Some(text) = live_text {
        session
            .handle_event(&event(
                "session.text.ended",
                json!({"sessionID":"ses_root","assistantMessageID":"msg_a","ordinal":0,"text":text}),
            ))
            .await;
    }
    let looping = tokio::spawn(session.clone().event_loop_with(None, Duration::from_millis(150)));
    tokio::time::sleep(Duration::from_millis(1000)).await;
    looping.abort();
    drain(&mut rx)
}

fn user() -> Value {
    json!({"type": "user", "id": "msg_x"})
}

fn reply(text: &str) -> Value {
    json!({"type": "assistant", "id": "msg_a", "content": [{"type": "reasoning", "text": "hm"}, {"type": "text", "text": text}]})
}

#[tokio::test]
async fn a_missed_end_of_turn_is_settled_with_the_reply_it_was_missing() {
    let idle = |outcome: &str| json!({"type": "idle", "id": "msg_i", "outcome": outcome});
    let events = settle(json!({}), vec![idle("succeeded"), reply("The final answer."), user()], None).await;
    let [DriverEvent::MessageCompleted { message_id, text, .. }, DriverEvent::TurnCompleted { stop_reason, anchors, .. }] =
        events.as_slice()
    else {
        panic!("{events:?}")
    };
    assert_eq!(
        (message_id.as_str(), text.as_str(), *stop_reason, anchors.turn_id.as_deref()),
        ("msg_a", "The final answer.", StopReason::Completed, Some("msg_x"))
    );

    // Text the stream already delivered is not delivered twice.
    let events = settle(json!({}), vec![idle("succeeded"), reply("Done."), user()], Some("Done.")).await;
    assert!(matches!(events.as_slice(), [DriverEvent::MessageCompleted { .. }, DriverEvent::TurnCompleted { .. }]), "{events:?}");

    // The session failed while nobody listened.
    let events = settle(json!({}), vec![idle("failed"), user()], None).await;
    assert!(matches!(events.as_slice(), [DriverEvent::TurnFailed { .. }]), "{events:?}");

    // An execution that left no idle message was lost: the turn is interrupted.
    let events = settle(json!({}), vec![reply("Partial"), user()], None).await;
    assert!(matches!(events.last(), Some(DriverEvent::TurnCompleted { stop_reason: StopReason::Interrupted, .. })), "{events:?}");
}

#[tokio::test]
async fn a_turn_still_running_or_not_yet_stored_is_left_alone_after_a_reconnect() {
    let idle = json!({"type": "idle", "id": "msg_i", "outcome": "succeeded"});
    // OpenCode still runs the session: the stream carries on from here.
    let events = settle(json!({"ses_root": {"type": "running"}}), vec![idle.clone(), reply("x"), user()], None).await;
    assert!(events.is_empty(), "{events:?}");
    // The prompt is not in the stored messages yet; what is there belongs to the last turn.
    let events = settle(json!({}), vec![idle, reply("old"), json!({"type": "user", "id": "msg_old"})], None).await;
    assert!(events.is_empty(), "{events:?}");
}

// --- Mode changes, long turns, usage, late text and approvals asked in a gap --------------------------------

#[tokio::test]
async fn a_failed_mode_change_leaves_the_mode_as_it_was_and_a_stuck_subagent_is_a_warning() {
    let mock = Mock::start(|_, _, _| Reply::Json(500, json!({"error": "no"}))).await;
    let (root_only, _rx) = session(&mock.base);
    let handle = Handle(root_only.clone(), std::sync::Mutex::new(None), None);
    assert!(handle.set_permission_mode(PermissionMode::FullAccess).await.is_err());
    assert_eq!(root_only.state.lock().await.mode, PermissionMode::Supervised, "the thread's own rules were not written");

    // The thread's rules go through; the subagent's do not.
    let mock = Mock::start(|method, path, _| {
        if (method, path) == ("PATCH", "/api/session/ses_kid") {
            Reply::Json(500, json!({"error": "no"}))
        } else {
            Reply::Json(200, json!({}))
        }
    })
    .await;
    let (session, mut rx) = session(&mock.base);
    let handle = Handle(session.clone(), std::sync::Mutex::new(None), None);
    session
        .handle_event(&event("session.created", json!({"sessionID":"ses_kid","parentID":"ses_root","title":"A (@general subagent)"})))
        .await;
    drain(&mut rx);
    handle.set_permission_mode(PermissionMode::FullAccess).await.expect("the thread is in the new mode");
    assert_eq!(session.state.lock().await.mode, PermissionMode::FullAccess);
    let events = drain(&mut rx);
    assert_eq!(
        events.iter().filter(|event| matches!(event, DriverEvent::Notice { level: NoticeLevel::Warning, .. })).count(),
        1,
        "{events:?}"
    );
    assert!(!session.state.lock().await.children["ses_kid"].rules_current, "it is written again at the next chance");
}

#[tokio::test]
async fn a_subagent_created_while_the_mode_is_being_switched_gets_the_new_rules() {
    let mock = Mock::start(|method, path, _| {
        if (method, path) == ("PATCH", "/api/session/ses_root") {
            Reply::After(Duration::from_millis(400), 200, json!({}))
        } else {
            Reply::Json(200, json!({}))
        }
    })
    .await;
    let (session, _rx) = session(&mock.base);
    let handle = Arc::new(Handle(session.clone(), std::sync::Mutex::new(None), None));
    let switching = tokio::spawn({
        let handle = handle.clone();
        async move { handle.set_permission_mode(PermissionMode::AcceptEdits).await }
    });
    tokio::time::sleep(Duration::from_millis(150)).await;
    // OpenCode made this subagent from the old rules, while the switch was in flight.
    session
        .handle_event(&event("session.created", json!({"sessionID":"ses_late","parentID":"ses_root","title":"A (@general subagent)"})))
        .await;
    switching.await.unwrap().unwrap();
    let writes = mock.requests("PATCH", "/api/session/ses_late");
    assert_eq!(writes.len(), 1, "it is rewritten once the thread has its new rules");
    assert_eq!(writes[0].body["permissions"], json!(ruleset(PermissionMode::AcceptEdits)));
}

#[tokio::test]
async fn a_finished_subagent_is_marked_to_be_written_again_when_the_mode_changes() {
    let mock = Mock::start(|_, _, _| Reply::Json(200, json!({}))).await;
    let (session, _rx) = session(&mock.base);
    let handle = Handle(session.clone(), std::sync::Mutex::new(None), None);
    session
        .handle_event(&event("session.created", json!({"sessionID":"ses_done","parentID":"ses_root","title":"B (@general subagent)"})))
        .await;
    session.handle_event(&event("session.execution.succeeded", json!({"sessionID":"ses_done"}))).await;
    handle.set_permission_mode(PermissionMode::AcceptEdits).await.unwrap();
    assert!(!session.state.lock().await.children["ses_done"].rules_current);
    // Whatever way it resumes, it is written before it is announced.
    session.handle_event(&event("session.tool.input.started", json!({"sessionID":"ses_root","id":"call_9","name":"subagent"}))).await;
    session
        .handle_event(&event(
            "session.tool.called",
            json!({"sessionID":"ses_root","id":"call_9","input":{"agent":"general","description":"B"}}),
        ))
        .await;
    session
        .handle_event(&event("session.tool.progress", json!({"sessionID":"ses_root","id":"call_9","metadata":{"sessionID":"ses_done"}})))
        .await;
    let writes = mock.requests("PATCH", "/api/session/ses_done");
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].body["permissions"], json!(ruleset(PermissionMode::AcceptEdits)));
}

fn filler(count: usize) -> Vec<Value> {
    (0..count).map(|i| json!({"type": "assistant", "id": format!("msg_step_{i}"), "content": []})).collect()
}

async fn waiting(session: &OpencodeSession) {
    let mut state = session.state.lock().await;
    state.active = true;
    state.turn_started = Some(std::time::Instant::now());
    state.current_message_id = Some("msg_x".into());
}

#[tokio::test]
async fn a_turn_longer_than_one_page_of_messages_still_settles() {
    let mock = Mock::start(|method, path, nth| match (method, path) {
        ("GET", "/api/session/active") => Reply::Json(200, json!({"data": {}})),
        // Newest first: the first page is all of a long turn's later steps, the prompt is further back.
        ("GET", "/api/session/ses_root/message") if nth == 0 => {
            let mut page = vec![json!({"type": "idle", "id": "msg_i", "outcome": "succeeded"})];
            page.extend(filler(SETTLE_PAGE - 1));
            Reply::Json(200, json!({"data": page, "cursor": {"previous": null, "next": "page-2"}}))
        }
        ("GET", "/api/session/ses_root/message") => {
            Reply::Json(200, json!({"data": [reply("The final answer."), user()], "cursor": {"previous": null, "next": null}}))
        }
        _ => Reply::Json(200, json!({})),
    })
    .await;
    let (session, mut rx) = session(&mock.base);
    waiting(&session).await;
    session.settle_after_reconnect().await;
    let events = drain(&mut rx);
    assert!(
        matches!(events.as_slice(), [DriverEvent::MessageCompleted { text, .. }, DriverEvent::TurnCompleted { stop_reason: StopReason::Completed, .. }] if text == "The final answer."),
        "{events:?}"
    );
    let reads = mock.requests("GET", "/api/session/ses_root/message");
    assert_eq!(
        reads.iter().map(|read| read.query.as_str()).collect::<Vec<_>>(),
        [format!("order=desc&limit={SETTLE_PAGE}"), format!("limit={SETTLE_PAGE}&cursor=page-2")],
        "the cursor is not sent with an order"
    );
}

#[tokio::test]
async fn a_settled_turn_reports_the_tokens_and_cost_of_the_steps_the_stream_missed_only() {
    let assistant = |id: &str, input: u64, cost: f64| json!({"type": "assistant", "id": id, "content": [], "cost": cost, "tokens": {"input": input, "output": 2, "reasoning": 1, "cache": {"read": 4, "write": 0}}});
    let mock = Mock::start(move |method, path, _| match (method, path) {
        ("GET", "/api/session/active") => Reply::Json(200, json!({"data": {}})),
        ("GET", "/api/session/ses_root/message") => Reply::Json(
            200,
            json!({"data": [json!({"type": "idle", "id": "msg_i", "outcome": "succeeded"}), assistant("msg_b", 20, 0.5), assistant("msg_a", 10, 0.25), user()]}),
        ),
        _ => Reply::Json(200, json!({})),
    })
    .await;
    let (session, mut rx) = session(&mock.base);
    waiting(&session).await;
    // The stream delivered the first step before it broke.
    session
        .handle_event(&event(
            "session.step.ended",
            json!({"sessionID":"ses_root","assistantMessageID":"msg_a","tokens":{"input":10,"output":2,"reasoning":1,"cache":{"read":4,"write":0}},"cost":0.25}),
        ))
        .await;
    session.settle_after_reconnect().await;
    let events = drain(&mut rx);
    let Some(DriverEvent::TurnCompleted { usage, cost_usd, .. }) = events.last() else { panic!("{events:?}") };
    assert_eq!((usage.input_tokens, usage.output_tokens, usage.cache_read_tokens, *cost_usd), (30, 6, 8, Some(0.75)));
}

#[tokio::test]
async fn text_that_was_buffered_behind_a_settled_turn_is_dropped() {
    let mock = Mock::start(|method, path, _| match (method, path) {
        ("GET", "/api/session/active") => Reply::Json(200, json!({"data": {}})),
        ("GET", "/api/session/ses_root/message") => {
            Reply::Json(200, json!({"data": [json!({"type": "idle", "id": "msg_i", "outcome": "succeeded"}), reply("Done."), user()]}))
        }
        _ => Reply::Json(200, json!({})),
    })
    .await;
    let (session, mut rx) = session(&mock.base);
    waiting(&session).await;
    session.settle_after_reconnect().await;
    assert!(matches!(drain(&mut rx).as_slice(), [DriverEvent::MessageCompleted { .. }, DriverEvent::TurnCompleted { .. }]));
    // The text.delta the stream buffered before the status was read.
    session
        .handle_event(&event(
            "session.text.delta",
            json!({"sessionID":"ses_root","assistantMessageID":"msg_a","ordinal":0,"delta":"Done."}),
        ))
        .await;
    assert!(drain(&mut rx).is_empty());
}

#[tokio::test]
async fn a_turn_replaced_while_it_is_settled_is_left_alone() {
    let mock = Mock::start(|method, path, _| match (method, path) {
        ("GET", "/api/session/active") => Reply::Json(200, json!({"data": {}})),
        ("GET", "/api/session/ses_root/message") => Reply::After(
            Duration::from_millis(300),
            200,
            json!({"data": [json!({"type": "idle", "id": "msg_i", "outcome": "succeeded"}), reply("Done."), user()]}),
        ),
        _ => Reply::Json(200, json!({})),
    })
    .await;
    let (session, mut rx) = session(&mock.base);
    waiting(&session).await;
    let settling = tokio::spawn({
        let session = session.clone();
        async move { session.settle_after_reconnect().await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    session.handle_event(&event("session.execution.succeeded", json!({"sessionID":"ses_root"}))).await;
    drain(&mut rx);
    {
        let mut state = session.state.lock().await;
        state.active = true;
        state.current_message_id = Some("msg_next".into());
    }
    settling.await.unwrap();
    assert!(drain(&mut rx).is_empty(), "the settled turn was not this one");
    let state = session.state.lock().await;
    assert!(state.active && state.current_message_id.as_deref() == Some("msg_next"));
}

#[tokio::test]
async fn approvals_asked_while_the_stream_was_down_are_surfaced_and_answered_ones_withdrawn() {
    let mock = Mock::start(|method, path, _| match (method, path) {
        ("GET", "/api/permission/request") => Reply::Json(
            200,
            json!({"data": [
                {"id": "per_old", "sessionID": "ses_root", "action": "shell", "resources": ["ls"]},
                {"id": "per_new", "sessionID": "ses_root", "action": "shell", "resources": ["rm x"]},
                {"id": "per_other", "sessionID": "ses_elsewhere", "action": "shell", "resources": ["id"]}
            ]}),
        ),
        ("GET", "/api/form") => Reply::Json(
            200,
            json!({"data": [{"id": "frm_new", "sessionID": "ses_root", "title": "Question", "metadata": {"kind": "question"},
                "fields": [{"key": "q", "type": "text", "title": "Which?"}]}]}),
        ),
        _ => Reply::Json(200, json!({})),
    })
    .await;
    let (session, mut rx) = session(&mock.base);
    {
        let mut state = session.state.lock().await;
        state.pending.insert("per_old".into(), Pending::Permission { session: "ses_root".into() });
        state.pending.insert("per_answered".into(), Pending::Permission { session: "ses_root".into() });
        state.pending.insert("frm_answered".into(), Pending::Form { session: "ses_root".into(), fields: vec![] });
    }
    session.resync_requests().await;
    let events = drain(&mut rx);
    let asked: Vec<&str> = events
        .iter()
        .filter_map(|event| match event {
            DriverEvent::PermissionRequest { request_id, .. } => Some(request_id.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(asked, ["per_new", "frm_new"], "{events:?}");
    let mut withdrawn: Vec<&str> = events
        .iter()
        .filter_map(|event| match event {
            DriverEvent::PermissionWithdrawn { request_id } => Some(request_id.as_str()),
            _ => None,
        })
        .collect();
    withdrawn.sort();
    assert_eq!(withdrawn, ["frm_answered", "per_answered"], "{events:?}");
    // Announced again by the stream, it is not shown twice.
    session
        .handle_event(&event(
            "permission.asked",
            json!({"id": "per_new", "sessionID": "ses_root", "action": "shell", "resources": ["rm x"]}),
        ))
        .await;
    assert!(drain(&mut rx).is_empty());
}
