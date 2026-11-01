use super::login::parse_login;
use super::stream::{TurnMapper, friendly_error};
use super::tools::{exited_nonzero, find_in_transcript, normalize};
use super::usage::{merge_buckets, parse_load_code_assist, parse_quota_summary, plan_name, to_limits};
use super::*;
use crate::{NativeToolBridge, NativeToolRestrictions};
use base64::Engine;

const CID: &str = "4324f2c8-c69e-4505-a32a-b3849aeef895";

/// Recorded output, with the blank lines `agy` writes between events.
fn feed(mapper: &mut TurnMapper, ndjson: &str) -> Vec<DriverEvent> {
    ndjson
        .lines()
        .filter(|line| !line.trim().is_empty())
        .flat_map(|line| mapper.handle(&serde_json::from_str::<Value>(line).unwrap_or_else(|error| panic!("{error}: {line}"))))
        .collect()
}

const TEXT_TURN: &str = r#"
{"event":"init","conversation_id":"4324f2c8-c69e-4505-a32a-b3849aeef895","init":{"model":"gemini-3.8-flash-low","cwd":"/work","permission_mode":"always-proceed","tools":["run_command","view_file"]}}

{"event":"step_update","step_update":{"conversation_id":"4324f2c8-c69e-4505-a32a-b3849aeef895","step_index":0,"state":"DONE","step_type":"user_input"}}

{"event":"step_update","step_update":{"conversation_id":"4324f2c8-c69e-4505-a32a-b3849aeef895","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"ok"}}

{"event":"step_update","step_update":{"conversation_id":"4324f2c8-c69e-4505-a32a-b3849aeef895","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"\n","duration_seconds":3.796846,"usage":{"input_tokens":21361,"output_tokens":1,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":21362}}}

{"event":"result","result":{"conversation_id":"4324f2c8-c69e-4505-a32a-b3849aeef895","status":"SUCCESS","response":"ok\n","duration_seconds":3.931191,"num_turns":1,"usage":{"input_tokens":21361,"output_tokens":1,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":21362}}}
"#;

#[test]
fn a_text_turn_streams_binds_and_completes_with_step_usage() {
    let mut mapper = TurnMapper::new(None);
    let mut events = feed(&mut mapper, TEXT_TURN);
    events.extend(mapper.finish(Some(0), None, false));
    assert!(
        matches!(&events[0], DriverEvent::SessionBound { session_id, model } if session_id == CID && model.as_deref() == Some("gemini-3.8-flash-low"))
    );
    let id = format!("{CID}:1");
    let deltas: Vec<&str> = events
        .iter()
        .filter_map(|event| match event {
            DriverEvent::TextDelta { message_id, delta, .. } if *message_id == id => Some(delta.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(deltas, ["ok", "\n"]);
    assert!(
        events
            .iter()
            .any(|event| matches!(event, DriverEvent::MessageCompleted { message_id, text, .. } if *message_id == id && text == "ok\n"))
    );
    // The final text matched what streamed: no second completion.
    assert_eq!(events.iter().filter(|event| matches!(event, DriverEvent::MessageCompleted { .. })).count(), 1);
    let Some(DriverEvent::TurnCompleted { stop_reason, usage, .. }) = events.last() else { panic!("{events:?}") };
    assert_eq!(*stop_reason, StopReason::Completed);
    assert_eq!((usage.input_tokens, usage.output_tokens), (21361, 1));
    assert_eq!(mapper.conversation(), Some(CID));
}

/// A resumed turn: step indices continue (7, 8, ...) and `result.usage` is
/// cumulative over the conversation, so only the steps of this turn are summed.
const TOOL_TURN: &str = r#"
{"event":"init","conversation_id":"4324f2c8-c69e-4505-a32a-b3849aeef895","init":{"model":"gemini-3.8-flash-low","cwd":"/work","permission_mode":"always-proceed"}}
{"event":"step_update","step_update":{"conversation_id":"4324f2c8-c69e-4505-a32a-b3849aeef895","step_index":7,"state":"DONE","step_type":"user_input"}}
{"event":"step_update","step_update":{"conversation_id":"4324f2c8-c69e-4505-a32a-b3849aeef895","step_index":8,"state":"DONE","step_type":"agent_response","duration_seconds":2.0,"usage":{"input_tokens":100,"output_tokens":20,"thinking_tokens":5,"cache_read_tokens":10,"total_tokens":135}}}

{"event":"step_update","step_update":{"conversation_id":"4324f2c8-c69e-4505-a32a-b3849aeef895","step_index":9,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hi","Cwd":"/work"}}}}
{"event":"step_update","step_update":{"conversation_id":"4324f2c8-c69e-4505-a32a-b3849aeef895","step_index":9,"state":"DONE","step_type":"tool","tool_name":"run_command","duration_seconds":0.2,"tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hi","Cwd":"/work"},"output":"Command exited with code 0.\n\nCommand output:\nhi\r\n"}}}
{"event":"step_update","step_update":{"conversation_id":"4324f2c8-c69e-4505-a32a-b3849aeef895","step_index":10,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"false"}}}}
{"event":"step_update","step_update":{"conversation_id":"4324f2c8-c69e-4505-a32a-b3849aeef895","step_index":10,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"false"},"output":"Command exited with code 1.\n"}}}
{"event":"step_update","step_update":{"conversation_id":"4324f2c8-c69e-4505-a32a-b3849aeef895","step_index":11,"state":"ACTIVE","step_type":"agent_response","text_delta":"done"}}
{"event":"step_update","step_update":{"conversation_id":"4324f2c8-c69e-4505-a32a-b3849aeef895","step_index":11,"state":"DONE","step_type":"agent_response","text_delta":".","usage":{"input_tokens":200,"output_tokens":3,"thinking_tokens":0,"cache_read_tokens":50,"total_tokens":253}}}
{"event":"result","result":{"conversation_id":"4324f2c8-c69e-4505-a32a-b3849aeef895","status":"SUCCESS","response":"done.","duration_seconds":99.0,"num_turns":4,"usage":{"input_tokens":9999,"output_tokens":9999,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":19998}}}
"#;

#[test]
fn tool_steps_become_cards_and_cumulative_result_usage_is_ignored() {
    let mut mapper = TurnMapper::new(None);
    let mut events = feed(&mut mapper, TOOL_TURN);
    events.extend(mapper.finish(Some(0), None, false));
    let started: Vec<&ToolCall> =
        events.iter().filter_map(|event| if let DriverEvent::ToolStarted(call) = event { Some(call) } else { None }).collect();
    assert_eq!(started.len(), 2);
    assert_eq!(started[0].id, format!("agy:{CID}:9"));
    assert_eq!(started[0].name, "Bash");
    assert_eq!(started[0].input["command"], "echo hi");
    assert_eq!(started[0].input["cwd"], "/work");
    assert_eq!(started[0].input["raw"]["CommandLine"], "echo hi");
    let completed: Vec<(&str, &Value, bool)> = events
        .iter()
        .filter_map(|event| match event {
            DriverEvent::ToolCompleted { tool_call_id, output, is_error } => Some((tool_call_id.as_str(), output, *is_error)),
            _ => None,
        })
        .collect();
    assert_eq!(completed.len(), 2);
    assert!(completed[0].1.as_str().unwrap().contains("hi"));
    assert!(!completed[0].2);
    assert!(completed[1].2, "a nonzero exit code is an error");
    // The planning step (index 8) carried no text and made no message.
    let completions = events.iter().filter(|event| matches!(event, DriverEvent::MessageCompleted { .. })).count();
    assert_eq!(completions, 1);
    let Some(DriverEvent::TurnCompleted { usage, .. }) = events.last() else { panic!() };
    assert_eq!(usage.input_tokens, 300);
    assert_eq!(usage.output_tokens, 20 + 5 + 3, "thinking tokens count as output");
    assert_eq!(usage.cache_read_tokens, 60);
}

#[test]
fn a_tool_that_only_reports_done_still_gets_its_start() {
    let mut mapper = TurnMapper::new(None);
    let events = feed(
        &mut mapper,
        r#"{"event":"step_update","step_update":{"conversation_id":"c","step_index":3,"state":"DONE","step_type":"tool","tool_name":"read_file","tool_info":{"name":"read_file","parameters":{"Path":"/abs/a.txt"},"output":"1 lines, 6 bytes"}}}"#,
    );
    assert!(matches!(&events[0], DriverEvent::ToolStarted(call) if call.name == "Read" && call.input["file_path"] == "/abs/a.txt"));
    assert!(matches!(&events[1], DriverEvent::ToolCompleted { is_error: false, .. }));
}

#[test]
fn a_kybern_tool_call_is_named_like_the_other_harnesses_name_it() {
    let mut mapper = TurnMapper::new(None);
    let events = feed(
        &mut mapper,
        r#"{"event":"step_update","step_update":{"conversation_id":"c","step_index":4,"state":"ACTIVE","step_type":"tool","tool_name":"call_mcp_tool","tool_info":{"name":"call_mcp_tool","parameters":{"ServerName":"kybern","ToolName":"kybern_notes_search","Arguments":{"query":"auth"}}}}}
{"event":"step_update","step_update":{"conversation_id":"c","step_index":4,"state":"DONE","step_type":"tool","tool_name":"call_mcp_tool","tool_info":{"name":"call_mcp_tool","parameters":{"ServerName":"kybern","ToolName":"kybern_notes_search","Arguments":{"query":"auth"}},"output":"2 notes"}}}"#,
    );
    assert!(matches!(&events[0], DriverEvent::ToolStarted(call)
        if call.name == "mcp__kybern__kybern_notes_search" && call.input["query"] == "auth"));
    assert!(matches!(&events[1], DriverEvent::ToolCompleted { output, is_error: false, .. } if output == "2 notes"));
}

#[test]
fn a_tool_step_that_ends_in_error_still_completes_with_the_error_text() {
    let mut mapper = TurnMapper::new(None);
    let events = feed(
        &mut mapper,
        r#"{"event":"step_update","step_update":{"conversation_id":"c","step_index":4,"state":"ACTIVE","step_type":"tool","tool_name":"call_mcp_tool","tool_info":{"name":"call_mcp_tool","parameters":{"ServerName":"kybern","ToolName":"kybern_project_map","Arguments":"{}"}}}}
{"event":"step_update","step_update":{"conversation_id":"c","step_index":4,"state":"ERROR","step_type":"tool","tool_name":"call_mcp_tool","error":"This project has no commits yet, so it has no map."}}"#,
    );
    assert!(matches!(&events[0], DriverEvent::ToolStarted(call) if call.name == "mcp__kybern__kybern_project_map"));
    assert!(matches!(&events[1], DriverEvent::ToolCompleted { output, is_error: true, .. }
        if output.as_str().is_some_and(|text| text.contains("no commits yet"))));
}

#[test]
fn agy_reading_its_own_mcp_schema_shows_nothing() {
    let mut mapper = TurnMapper::new(None);
    let events = feed(
        &mut mapper,
        r#"{"event":"step_update","step_update":{"conversation_id":"c","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"read_file","tool_info":{"name":"read_file","parameters":{"Path":"/Users/me/.gemini/antigravity-cli/mcp/kybern/kybern_notes_search.json"}}}}
{"event":"step_update","step_update":{"conversation_id":"c","step_index":2,"state":"DONE","step_type":"tool","tool_name":"read_file","tool_info":{"name":"read_file","parameters":{"Path":"/Users/me/.gemini/antigravity-cli/mcp/kybern/kybern_notes_search.json"},"output":"{}"}}}
{"event":"step_update","step_update":{"conversation_id":"c","step_index":3,"state":"DONE","step_type":"tool","tool_name":"read_file","tool_info":{"name":"read_file","parameters":{"Path":"/work/src/mcp/notes.rs"},"output":"1 lines"}}}"#,
    );
    // Only the ordinary file read of step 3 is shown.
    assert_eq!(events.len(), 2, "{events:?}");
    assert!(matches!(&events[0], DriverEvent::ToolStarted(call) if call.input["file_path"] == "/work/src/mcp/notes.rs"));
}

#[test]
fn an_interrupted_result_ends_the_turn_as_interrupted() {
    let mut mapper = TurnMapper::new(None);
    feed(
        &mut mapper,
        r#"
{"event":"init","conversation_id":"c1","init":{"model":"m"}}
{"event":"result","result":{"conversation_id":"c1","status":"ERROR","error":"interrupted","finished_reason":"USER_CANCELED"}}
"#,
    );
    let events = mapper.finish(Some(1), None, true);
    assert!(matches!(&events[..], [DriverEvent::TurnCompleted { stop_reason: StopReason::Interrupted, .. }]));
    // Even a kill that came before `agy` wrote a result is an interrupt.
    let mut killed = TurnMapper::new(None);
    assert!(matches!(&killed.finish(None, None, true)[..], [DriverEvent::TurnCompleted { stop_reason: StopReason::Interrupted, .. }]));
}

#[test]
fn failures_say_what_to_do_next() {
    let mut mapper = TurnMapper::new(None);
    feed(&mut mapper, r#"{"event":"result","result":{"conversation_id":"c","status":"ERROR","error":"authentication required"}}"#);
    let events = mapper.finish(Some(1), None, false);
    let [DriverEvent::TurnFailed { error }] = &events[..] else { panic!("{events:?}") };
    assert!(error.contains("Settings → Agents → Antigravity"), "{error}");

    // A crash with no result says what the process printed.
    let mut crashed = TurnMapper::new(None);
    let events = crashed.finish(Some(2), Some("authentication required"), false);
    assert!(matches!(&events[..], [DriverEvent::TurnFailed { error }] if error.contains("Settings → Agents → Antigravity")));
    let mut other = TurnMapper::new(None);
    let events = other.finish(Some(3), Some("quota exhausted for today"), false);
    let [DriverEvent::TurnFailed { error }] = &events[..] else { panic!() };
    assert!(error.starts_with("Antigravity stopped: quota exhausted for today."));
    assert!(error.ends_with("pick another agent."));
    // The structured `error` event is used when nothing was printed on stderr.
    let mut evented = TurnMapper::new(None);
    feed(&mut evented, r#"{"event":"error","error":"model not found"}"#);
    let events = evented.finish(Some(1), None, false);
    assert!(matches!(&events[..], [DriverEvent::TurnFailed { error }] if error.contains("model not found")));
    assert!(friendly_error("").contains("Send your message again"));
}

#[test]
fn the_result_text_is_authoritative() {
    // Streaming missed the tail: the final message is corrected from `result.response`.
    let mut mapper = TurnMapper::new(None);
    let mut events = feed(
        &mut mapper,
        r#"
{"event":"step_update","step_update":{"conversation_id":"c","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"hel"}}
{"event":"result","result":{"conversation_id":"c","status":"SUCCESS","response":"hello"}}
"#,
    );
    events.extend(mapper.finish(Some(0), None, false));
    assert!(
        events
            .iter()
            .any(|event| matches!(event, DriverEvent::MessageCompleted { message_id, text, .. } if message_id == "c:1" && text == "hello"))
    );
    // Nothing streamed at all: the response becomes the message.
    let mut silent = TurnMapper::new(None);
    feed(&mut silent, r#"{"event":"result","result":{"conversation_id":"c","status":"SUCCESS","response":"just this"}}"#);
    let events = silent.finish(Some(0), None, false);
    assert!(events.iter().any(|event| matches!(event, DriverEvent::MessageCompleted { text, .. } if text == "just this")));
    assert_eq!(silent.one_shot_answer().as_deref(), Some("just this"));
}

#[test]
fn tool_names_and_inputs_are_normalised_with_the_original_kept() {
    let none = |_: &str| None;
    let cases: [(&str, Value, &str, (&str, &str)); 9] = [
        ("view_file", json!({"Path": "/a"}), "Read", ("file_path", "/a")),
        ("write_to_file", json!({"TargetFile": "/b"}), "Write", ("file_path", "/b")),
        ("replace_file_content", json!({"Path": "/c"}), "Edit", ("file_path", "/c")),
        ("grep_search", json!({"query": "needle", "SearchPath": "/src"}), "Grep", ("pattern", "needle")),
        ("find_by_name", json!({"Pattern": "*.rs", "SearchDirectory": "/src"}), "Glob", ("pattern", "*.rs")),
        ("list_dir", json!({"directory_path": "/src"}), "LS", ("path", "/src")),
        ("search_web", json!({"query": "rust"}), "WebSearch", ("query", "rust")),
        ("read_url_content", json!({"Url": "https://example.com"}), "WebFetch", ("url", "https://example.com")),
        ("invoke_subagent", json!({"Prompt": "look around", "TaskName": "scout"}), "Task", ("prompt", "look around")),
    ];
    for (agy, params, name, (key, value)) in cases {
        let (mapped, input) = normalize(agy, &params, none);
        assert_eq!(mapped, name, "{agy}");
        assert_eq!(input[key], value, "{agy}");
        assert_eq!(input["raw"], params, "{agy} keeps the original");
    }
    let (name, input) =
        normalize("call_mcp_tool", &json!({"ServerName": "git hub", "ToolName": "list_issues", "Arguments": {"repo": "x"}}), none);
    assert_eq!(name, "mcp__git_hub__list_issues");
    assert_eq!(input["repo"], "x");
    let (name, input) = normalize("generate_image", &json!({"Prompt": "a cat"}), none);
    assert_eq!((name.as_str(), input["Prompt"].as_str()), ("generate_image", Some("a cat")));
    // The edit-path guard understands the mapped calls.
    let (name, input) = normalize("write_to_file", &json!({"Path": "/work/a.rs"}), none);
    let call = ToolCall { id: "t".into(), name, input, parent_id: None };
    assert_eq!(crate::edit_paths::edited_paths(&call), vec!["/work/a.rs".to_string()]);
}

#[test]
fn a_thin_call_borrows_arguments_from_the_transcript_without_failing() {
    let transcript = r#"{"step_index":1,"type":"PLANNER_RESPONSE","tool_calls":[{"name":"run_command","args":{"CommandLine":"\"ls -la\"","Cwd":"\"/work\""}}]}
not json at all
{"step_index":5,"type":"PLANNER_RESPONSE","tool_calls":[{"name":"run_command","args":{"CommandLine":"\"later\""}}]}
"#;
    let args = find_in_transcript(transcript, 2, "run_command").unwrap();
    assert_eq!(args["CommandLine"], "ls -la");
    assert_eq!(args["Cwd"], "/work");
    let (name, input) = normalize("run_command", &json!({}), |agy| find_in_transcript(transcript, 2, agy));
    assert_eq!((name.as_str(), input["command"].as_str()), ("Bash", Some("ls -la")));
    // A missing file or a path that tries to leave the brain folder is ignored.
    assert!(super::tools::transcript_args(Some(Path::new("/definitely/not/here")), "abc", 3, "run_command").is_none());
    assert!(super::tools::transcript_args(Some(Path::new("/tmp")), "../x", 3, "run_command").is_none());
    assert!(exited_nonzero("Command exited with code 2.\n"));
    assert!(!exited_nonzero("Command exited with code 0.\n"));
    assert!(!exited_nonzero("1 lines, 6 bytes"));
}

#[test]
fn models_come_from_the_tab_separated_list() {
    let models = parse_models(
        "Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n\nnoise without a tab\ngemini-3.8-flash-high\tduplicate\n",
    );
    assert_eq!(models.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(), ["gemini-3.8-flash-high", "claude-sonnet-4-6"]);
    assert!(models[0].is_default && !models[1].is_default);
    assert_eq!(models[1].display_name, "Claude Sonnet 4.6 (Thinking)");
    assert!(parse_models("Fetching available models...\n").is_empty());
}

#[test]
fn one_turn_is_built_exactly_as_the_spec_says() {
    let log = Path::new("/tmp/s/agy.log");
    let args: Vec<String> = turn_args(Some("gemini-3.8-flash-low"), Some("high"), Some("abc"), log)
        .into_iter()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        args,
        [
            "--output-format",
            "stream-json",
            "--input-format",
            "stream-json",
            "--dangerously-skip-permissions",
            "--model",
            "gemini-3.8-flash-low",
            "--effort",
            "high",
            "--conversation",
            "abc",
            "--log-file",
            "/tmp/s/agy.log",
            "-p="
        ]
    );
    let bare: Vec<String> = turn_args(None, None, None, log).into_iter().map(|a| a.to_string_lossy().into_owned()).collect();
    assert!(!bare.iter().any(|arg| arg == "--conversation" || arg == "--model" || arg == "--effort"));
    assert_eq!(bare.last().unwrap(), "-p=");
    let line = prompt_line("hi \"there\"\nsecond");
    assert_eq!(line["event"], "user");
    assert_eq!(line["message"]["role"], "user");
    assert_eq!(line["message"]["content"], "hi \"there\"\nsecond");
    assert!(valid_model("gemini-3.8-flash-low") && !valid_model("--model") && !valid_model("a b") && !valid_model(""));
}

#[test]
fn only_full_access_is_accepted_everywhere() {
    assert!(require_full_access(PermissionMode::FullAccess).is_ok());
    for mode in [PermissionMode::Supervised, PermissionMode::AcceptEdits, PermissionMode::Auto] {
        assert_eq!(require_full_access(mode), Err("Antigravity only runs in Full access. Choose Full access, or pick another agent."));
    }
}

fn config(binary: &Path, cwd: &Path) -> SessionConfig {
    SessionConfig {
        cwd: cwd.into(),
        model: None,
        effort: None,
        permission_mode: PermissionMode::FullAccess,
        native_tool_bridge: None,
        resume_session_id: None,
        resume_lacks_instructions: false,
        fork: false,
        rewind: None,
        binary: Some(binary.into()),
        env: Default::default(),
    }
}

#[tokio::test]
async fn spawn_refuses_what_agy_cannot_do() {
    let root = tempfile::tempdir().unwrap();
    let binary = root.path().join("agy");
    std::fs::write(&binary, "").unwrap();
    let driver = AntigravityDriver::default();
    for mode in [PermissionMode::Supervised, PermissionMode::AcceptEdits, PermissionMode::Auto] {
        let mut refused = config(&binary, root.path());
        refused.permission_mode = mode;
        let Err(error) = driver.spawn(refused).await else { panic!("{mode:?} must be refused") };
        assert!(error.to_string().contains("Antigravity only runs in Full access. Choose Full access, or pick another agent."), "{error}");
    }
    let mut forked = config(&binary, root.path());
    forked.fork = true;
    assert!(driver.spawn(forked).await.is_err());
    let mut lead = config(&binary, root.path());
    lead.native_tool_bridge = Some(NativeToolBridge {
        server_name: "kybern".into(),
        endpoint: None,
        authorization: None,
        coordinator_instructions: None,
        guide: None,
        tools: vec![],
        restrictions: NativeToolRestrictions { require_enforcement: true, ..Default::default() },
    });
    let Err(error) = driver.spawn(lead).await else { panic!("a lead must be refused") };
    assert!(error.to_string().contains("Antigravity can't lead a project"), "{error}");
    let ok = driver.spawn(config(&binary, root.path())).await.unwrap();
    assert!(ok.session.set_permission_mode(PermissionMode::FullAccess).await.is_ok());
    assert!(ok.session.set_permission_mode(PermissionMode::Auto).await.is_err());
    assert!(ok.session.set_effort("ludicrous").await.is_err());
    assert!(ok.session.set_effort("xhigh").await.is_ok());
    assert!(ok.session.set_model("--evil").await.is_err());
    assert!(ok.session.set_model("gemini-3.8-flash-low").await.is_ok());
    assert!(!driver.supports_fork());
}

#[test]
fn a_prompt_flattens_parts_and_saves_images_in_the_scratch_folder() {
    let scratch = Scratch::new().unwrap();
    let png = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG fake");
    let message = UserMessage {
        parts: vec![
            ContentPart::Text { text: "look ".into() },
            ContentPart::FileMention { path: "src/a.rs".into() },
            ContentPart::Text { text: " ".into() },
            ContentPart::Image { media_type: "image/png".into(), data: png },
            ContentPart::Image { media_type: "image/png".into(), data: "!!not base64".into() },
        ],
    };
    let text = prompt_text(&message, &scratch);
    assert!(text.starts_with("look @src/a.rs [image 1: "), "{text}");
    assert!(text.ends_with("[image]"), "an undecodable image is named, not dropped: {text}");
    let saved = std::fs::read_dir(scratch.image_dir()).unwrap().count();
    assert_eq!(saved, 1);
    let path = scratch.0.clone();
    drop(scratch);
    assert!(!path.exists(), "the scratch folder goes with the session");
    crate::test_support::assert_flattened(&prompt_text(&crate::test_support::orchestration_message(), &Scratch::new().unwrap()));
}

#[test]
fn the_stored_login_yields_an_email_and_an_expiry_and_hides_the_token() {
    let json = r#"{"token":{"access_token":"ya29.SECRET-VALUE","token_type":"Bearer","refresh_token":"1//REFRESH-SECRET","expiry":"2099-01-02T03:04:05Z","expires_in":3599},"auth_method":"oauth","id_token_email":"dev@example.com"}"#;
    let wrapped = format!("go-keyring-base64:{}", base64::engine::general_purpose::STANDARD.encode(json));
    for text in [wrapped.as_str(), json] {
        let login = parse_login(text).unwrap();
        assert_eq!(login.email.as_deref(), Some("dev@example.com"));
        assert_eq!(login.expiry.unwrap().to_rfc3339(), "2099-01-02T03:04:05+00:00");
        assert!(!login.expires_within(chrono::Duration::seconds(60)));
        let shown = format!("{login:?}");
        assert!(!shown.contains("SECRET"), "{shown}");
    }
    // A bare oauth2.Token has no email.
    let bare = parse_login(r#"{"access_token":"t","expiry":"2001-01-01T00:00:00Z"}"#).unwrap();
    assert!(bare.email.is_none() && bare.expires_within(chrono::Duration::seconds(60)));
    assert!(parse_login("go-keyring-base64:@@@").is_none());
    assert!(parse_login("{}").is_none());
}

#[test]
fn quota_buckets_merge_by_id_and_map_the_windows() {
    let daily = json!({"groups": [
        {"displayName": "Gemini", "buckets": [
            {"bucketId": "3p-5h", "displayName": "Gemini", "window": "5h", "resetTime": "2026-11-01T12:00:00Z", "remainingFraction": 0.75},
            {"bucketId": "3p-weekly", "window": "weekly", "resetTime": "2026-11-05T00:00:00Z", "remainingFraction": 1}]},
        {"displayName": "Off", "buckets": [{"bucketId": "off", "window": "5h", "remainingFraction": 0.1, "disabled": true}]}]});
    let production = json!({"groups": [
        {"displayName": "Gemini", "buckets": [{"bucketId": "3p-5h", "window": "5h", "resetTime": "2026-11-01T12:00:00Z", "remainingFraction": 0.5}]},
        {"displayName": "Claude", "buckets": [{"bucketId": "claude-weekly", "window": "weekly", "resetTime": "2026-11-05T00:00:00Z", "remainingFraction": 0.9},
                                              {"bucketId": "odd", "window": "monthly", "remainingFraction": 0.5}]}]});
    let merged = merge_buckets([parse_quota_summary(&daily), parse_quota_summary(&production)]);
    assert_eq!(merged.len(), 3, "disabled and unknown windows are skipped: {merged:?}");
    let limits = to_limits(&merged);
    assert_eq!(limits[0].name, "Gemini · 5-hour");
    assert_eq!(limits[0].used_percent, 50.0, "the most-used reading wins");
    assert_eq!(limits[0].window_minutes, Some(300));
    assert_eq!(limits[0].resets_at, Some(1_793_534_400));
    assert!(limits[1..].iter().all(|limit| limit.window_minutes == Some(10080)));
    assert_eq!(limits[1].name, "Claude · Weekly");
    assert_eq!(limits[1].used_percent, 10.0);
    assert_eq!(limits[2].used_percent, 0.0);
}

#[test]
fn the_project_and_plan_come_from_load_code_assist() {
    let (project, plan) = parse_load_code_assist(
        &json!({"cloudaicompanionProject": "proj-123", "paidTier": {"id": "g1-plus-tier"}, "currentTier": {"id": "free-tier"}}),
    );
    assert_eq!((project.as_deref(), plan.as_deref()), (Some("proj-123"), Some("Google AI Plus")));
    let (project, plan) = parse_load_code_assist(&json!({"cloudaicompanionProject": {"id": "p2"}, "currentTier": {"id": "standard-tier"}}));
    assert_eq!((project.as_deref(), plan.as_deref()), (Some("p2"), Some("Google AI Free")));
    assert_eq!(parse_load_code_assist(&json!({})), (None, None));
    assert_eq!(plan_name("g1-pro-tier"), "Google AI Pro");
    assert_eq!(plan_name("g1-ultra-tier"), "Google AI Ultra");
    assert_eq!(plan_name("enterprise-tier"), "Enterprise");
}

#[test]
fn agy_is_found_where_its_installer_puts_it() {
    let home = Path::new("/home/me");
    let local = Path::new("C:/Users/me/AppData/Local");
    let candidates = crate::binary::antigravity_candidates(Some(home), Some(local));
    assert_eq!(candidates[0], home.join(".local/bin/agy"));
    assert_eq!(candidates[1], local.join("agy/bin/agy.exe"));
}

#[cfg(unix)]
mod process {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A stand-in `agy`: records its arguments and stdin, then plays a script.
    fn fake_agy(root: &Path, script: &str) -> PathBuf {
        let binary = root.join("agy");
        std::fs::write(
            &binary,
            format!(
                "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 1.4.12; exit 0; fi\nif [ \"$1\" = models ]; then printf 'Fetching available models...\\ngemini-3.8-flash-low\\tGemini 3.8 Flash (Low)\\nclaude-sonnet-4-6\\tClaude Sonnet 4.6\\n'; exit 0; fi\nprintf '%s\\n' \"$*\" >> \"{root}/args.log\"\nIFS= read -r line\nprintf '%s\\n' \"$line\" >> \"{root}/stdin.log\"\n{script}\n",
                root = root.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        binary
    }

    const REPLY: &str = r#"printf '%s\n\n' '{"event":"init","conversation_id":"conv-1","init":{"model":"gemini-3.8-flash-low"}}'
printf '%s\n\n' '{"event":"step_update","step_update":{"conversation_id":"conv-1","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"hi","usage":{"input_tokens":4,"output_tokens":2}}}'
printf '%s\n\n' '{"event":"result","result":{"conversation_id":"conv-1","status":"SUCCESS","response":"hi"}}'"#;

    async fn next_turn_end(events: &mut mpsc::Receiver<DriverEvent>) -> Vec<DriverEvent> {
        let mut seen = Vec::new();
        loop {
            let event = tokio::time::timeout(Duration::from_secs(15), events.recv()).await.expect("the turn ended").expect("events open");
            let done = matches!(event, DriverEvent::TurnCompleted { .. } | DriverEvent::TurnFailed { .. });
            seen.push(event);
            if done {
                return seen;
            }
        }
    }

    #[tokio::test]
    async fn turns_run_one_process_each_and_resume_the_conversation() {
        let root = tempfile::tempdir().unwrap();
        let binary = fake_agy(root.path(), REPLY);
        let driver = AntigravityDriver::default();
        let mut config = config(&binary, root.path());
        config.model = Some("gemini-3.8-flash-low".into());
        config.native_tool_bridge = Some(NativeToolBridge {
            server_name: "kybern".into(),
            endpoint: None,
            authorization: None,
            coordinator_instructions: None,
            guide: Some("GUIDE TEXT".into()),
            tools: vec![],
            restrictions: Default::default(),
        });
        let SpawnedSession { session, mut events } = driver.spawn(config).await.unwrap();
        session.send_message("m1", &UserMessage::text("first")).await.unwrap();
        let first = next_turn_end(&mut events).await;
        assert!(matches!(&first[0], DriverEvent::SessionBound { session_id, .. } if session_id == "conv-1"));
        assert!(matches!(first.last(), Some(DriverEvent::TurnCompleted { stop_reason: StopReason::Completed, .. })));
        session.send_message("m2", &UserMessage::text("second")).await.unwrap();
        next_turn_end(&mut events).await;
        let args = std::fs::read_to_string(root.path().join("args.log")).unwrap();
        let args: Vec<&str> = args.lines().collect();
        assert_eq!(args.len(), 2, "one process per turn");
        assert!(
            args[0].contains("--dangerously-skip-permissions")
                && args[0].contains("--model gemini-3.8-flash-low")
                && args[0].ends_with("-p=")
        );
        assert!(!args[0].contains("--conversation"));
        assert!(args[1].contains("--conversation conv-1"), "{}", args[1]);
        let stdin = std::fs::read_to_string(root.path().join("stdin.log")).unwrap();
        let lines: Vec<Value> = stdin.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        let first_prompt = lines[0]["message"]["content"].as_str().unwrap();
        assert!(first_prompt.starts_with("<kybern_instructions>\nGUIDE TEXT\n</kybern_instructions>\n\nfirst"), "{first_prompt}");
        assert_eq!(lines[1]["message"]["content"], "second", "the guide rides in the first prompt only");
        // The log file lives in the session's scratch folder, not the checkout.
        assert!(args[0].contains("kybern-agy-"), "{}", args[0]);
        session.close().await.unwrap();
        assert!(matches!(events.recv().await, Some(DriverEvent::Exited { .. })));
    }

    #[tokio::test]
    async fn the_bridge_endpoint_travels_in_the_environment_not_on_the_command_line() {
        let root = tempfile::tempdir().unwrap();
        let script = format!(
            "printf '%s|%s\\n' \"$KYBERN_MCP_URL\" \"$KYBERN_MCP_AUTHORIZATION\" >> \"{}/env.log\"\n{REPLY}",
            root.path().display()
        );
        let binary = fake_agy(root.path(), &script);
        let driver = AntigravityDriver::default();
        let mut config = config(&binary, root.path());
        config.env.insert("KYBERN_MCP_URL".into(), "http://stale".into());
        config.native_tool_bridge = Some(NativeToolBridge {
            server_name: "kybern".into(),
            endpoint: Some("http://127.0.0.1:4199/native-tools/mcp".into()),
            authorization: Some("secret-credential".into()),
            coordinator_instructions: None,
            guide: None,
            tools: vec![],
            restrictions: Default::default(),
        });
        assert!(!format!("{:?}", config.native_tool_bridge).contains("secret-credential"));
        let SpawnedSession { session, mut events } = driver.spawn(config).await.unwrap();
        session.send_message("m1", &UserMessage::text("hi")).await.unwrap();
        next_turn_end(&mut events).await;
        let env = std::fs::read_to_string(root.path().join("env.log")).unwrap();
        assert_eq!(env.trim(), "http://127.0.0.1:4199/native-tools/mcp|secret-credential");
        let args = std::fs::read_to_string(root.path().join("args.log")).unwrap();
        assert!(!args.contains("secret-credential") && !args.contains("127.0.0.1"), "{args}");
        session.close().await.unwrap();
    }

    #[tokio::test]
    async fn a_resumed_session_sends_the_guide_only_when_the_conversation_lacks_it() {
        for (lacks, expect) in [(false, false), (true, true)] {
            let root = tempfile::tempdir().unwrap();
            let binary = fake_agy(root.path(), REPLY);
            let mut config = config(&binary, root.path());
            config.resume_session_id = Some("conv-9".into());
            config.resume_lacks_instructions = lacks;
            config.native_tool_bridge = Some(NativeToolBridge {
                server_name: "kybern".into(),
                endpoint: None,
                authorization: None,
                coordinator_instructions: None,
                guide: Some("GUIDE".into()),
                tools: vec![],
                restrictions: Default::default(),
            });
            let SpawnedSession { session, mut events } = AntigravityDriver::default().spawn(config).await.unwrap();
            session.send_message("m", &UserMessage::text("go")).await.unwrap();
            next_turn_end(&mut events).await;
            let stdin = std::fs::read_to_string(root.path().join("stdin.log")).unwrap();
            assert_eq!(stdin.contains("GUIDE"), expect);
            assert!(std::fs::read_to_string(root.path().join("args.log")).unwrap().contains("--conversation conv-9"));
        }
    }

    #[tokio::test]
    async fn a_failed_first_turn_keeps_the_guide_for_the_retry() {
        let root = tempfile::tempdir().unwrap();
        let binary = fake_agy(root.path(), "echo 'authentication required' >&2\nexit 1");
        let mut config = config(&binary, root.path());
        config.native_tool_bridge = Some(NativeToolBridge {
            server_name: "kybern".into(),
            endpoint: None,
            authorization: None,
            coordinator_instructions: None,
            guide: Some("GUIDE".into()),
            tools: vec![],
            restrictions: Default::default(),
        });
        let SpawnedSession { session, mut events } = AntigravityDriver::default().spawn(config).await.unwrap();
        session.send_message("m", &UserMessage::text("go")).await.unwrap();
        let ended = next_turn_end(&mut events).await;
        assert!(
            matches!(ended.last(), Some(DriverEvent::TurnFailed { error }) if error.contains("Settings → Agents → Antigravity")),
            "{ended:?}"
        );
        // Wait until the session frees itself, then send again.
        for _ in 0..100 {
            if session.send_message("m2", &UserMessage::text("again")).await.is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        next_turn_end(&mut events).await;
        let stdin = std::fs::read_to_string(root.path().join("stdin.log")).unwrap();
        assert_eq!(stdin.matches("GUIDE").count(), 2, "{stdin}");
    }

    /// `agy` on SIGINT writes its own interrupted result and takes its tool
    /// children down; here the sleep is a child in the same process group.
    #[tokio::test]
    async fn interrupt_sends_sigint_and_ends_the_turn_as_interrupted() {
        let root = tempfile::tempdir().unwrap();
        let script = format!(
            "trap 'printf \"%s\\n\" \"{{\\\"event\\\":\\\"result\\\",\\\"result\\\":{{\\\"status\\\":\\\"ERROR\\\",\\\"error\\\":\\\"interrupted\\\"}}}}\"; kill $child; exit 1' INT\nsleep 30 &\nchild=$!\necho $child > \"{root}/child\"\nprintf '%s\\n' '{{\"event\":\"init\",\"conversation_id\":\"c\",\"init\":{{}}}}'\nwait $child; wait $child",
            root = root.path().display()
        );
        let binary = fake_agy(root.path(), &script);
        let SpawnedSession { session, mut events } = AntigravityDriver::default().spawn(config(&binary, root.path())).await.unwrap();
        session.send_message("m", &UserMessage::text("sleep")).await.unwrap();
        let child_file = root.path().join("child");
        tokio::time::timeout(Duration::from_secs(10), async {
            while std::fs::read_to_string(&child_file).map_or(true, |text| text.trim().is_empty()) {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        let child: u32 = std::fs::read_to_string(&child_file).unwrap().trim().parse().unwrap();
        session.interrupt().await.unwrap();
        let ended = next_turn_end(&mut events).await;
        assert!(matches!(ended.last(), Some(DriverEvent::TurnCompleted { stop_reason: StopReason::Interrupted, .. })), "{ended:?}");
        assert!(!pid_alive(child).await, "the tool's child died with the tree");
    }

    /// A process that ignores SIGINT is taken down by the SIGTERM and SIGKILL steps.
    #[tokio::test]
    async fn a_process_that_ignores_sigint_is_escalated_to_a_stop() {
        let root = tempfile::tempdir().unwrap();
        let binary = fake_agy(root.path(), "trap '' INT\nsleep 30 &\necho $! > \"$(dirname \"$0\")/child\"\nwait");
        let SpawnedSession { session, mut events } = AntigravityDriver::default().spawn(config(&binary, root.path())).await.unwrap();
        session.send_message("m", &UserMessage::text("stuck")).await.unwrap();
        let child_file = root.path().join("child");
        tokio::time::timeout(Duration::from_secs(10), async {
            while std::fs::read_to_string(&child_file).map_or(true, |text| text.trim().is_empty()) {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        let child: u32 = std::fs::read_to_string(&child_file).unwrap().trim().parse().unwrap();
        session.interrupt().await.unwrap();
        let ended = tokio::time::timeout(Duration::from_secs(20), next_turn_end(&mut events)).await.expect("escalation ended the turn");
        assert!(matches!(ended.last(), Some(DriverEvent::TurnCompleted { stop_reason: StopReason::Interrupted, .. })), "{ended:?}");
        assert!(!pid_alive(child).await);
    }

    #[tokio::test]
    async fn a_second_message_during_a_turn_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let binary = fake_agy(root.path(), "sleep 30");
        let SpawnedSession { session, events: _events } = AntigravityDriver::default().spawn(config(&binary, root.path())).await.unwrap();
        session.send_message("m", &UserMessage::text("one")).await.unwrap();
        let Err(error) = session.send_message("m2", &UserMessage::text("two")).await else { panic!("a turn is running") };
        assert!(error.to_string().contains("still working"), "{error}");
        session.close().await.unwrap();
    }

    #[tokio::test]
    async fn probe_lists_models_and_checks_the_version() {
        let root = tempfile::tempdir().unwrap();
        let binary = fake_agy(root.path(), "true");
        let driver = AntigravityDriver::with_catalog_file(root.path().join("models.json"));
        let status = driver.probe(Some(&binary)).await;
        assert!(status.available, "{:?}", status.unavailable_reason);
        assert_eq!(status.version.as_deref(), Some("1.4.12"));
        assert_eq!(status.supported_permission_modes, vec![PermissionMode::FullAccess]);
        assert!(!status.supports_fork && status.supports_model_switch && status.supports_effort_switch);
        assert_eq!(status.supported_efforts, ["low", "medium", "high", "xhigh", "max"]);
        assert_eq!(status.models.len(), 2);
        assert!(status.models[0].is_default);
        // A restarted daemon lists the saved catalog when `agy models` fails.
        let broken = root.path().join("agy");
        std::fs::write(&broken, "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 1.4.12; exit 0; fi\nexit 1\n").unwrap();
        let restarted = AntigravityDriver::with_catalog_file(root.path().join("models.json"));
        assert_eq!(restarted.probe(Some(&broken)).await.models.len(), 2);
        // Too old is unavailable with the fix named.
        std::fs::write(&broken, "#!/bin/sh\necho 1.4.10\n").unwrap();
        let old = AntigravityDriver::default().probe(Some(&broken)).await;
        assert!(!old.available && old.unavailable_reason.unwrap().contains("agy update"));
        let missing = AntigravityDriver::default().probe(Some(&root.path().join("nope"))).await;
        assert!(!missing.available && missing.unavailable_reason.unwrap().contains("Install with"));
    }

    #[tokio::test]
    async fn one_shot_answers_from_the_result_in_plan_mode() {
        let root = tempfile::tempdir().unwrap();
        let reply = REPLY.replace("\"hi\"", "\"A short title\"");
        let binary = fake_agy(root.path(), &reply);
        let answer = AntigravityDriver::default().one_shot(root.path(), "title please", Some(&binary), &BTreeMap::new()).await.unwrap();
        assert_eq!(answer, "A short title");
        let args = std::fs::read_to_string(root.path().join("args.log")).unwrap();
        assert!(args.contains("--mode plan") && !args.contains("--dangerously-skip-permissions"), "{args}");
    }

    async fn pid_alive(pid: u32) -> bool {
        for _ in 0..100 {
            let output = tokio::process::Command::new("ps").args(["-o", "stat=", "-p", &pid.to_string()]).output().await.unwrap();
            let state = String::from_utf8_lossy(&output.stdout);
            if state.trim().is_empty() || state.trim_start().starts_with('Z') {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        true
    }
}
