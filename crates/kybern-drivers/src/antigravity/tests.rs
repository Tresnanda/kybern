use super::login::parse_login;
use super::stream::{TurnMapper, friendly_error};
use super::tools::{exited_nonzero, find_in_transcript, normalize};
use super::usage::{merge_buckets, parse_agy_usage, parse_load_code_assist, parse_quota_summary, plan_name, to_limits, user_agent};
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
{"event":"step_update","step_update":{"conversation_id":"4324f2c8-c69e-4505-a32a-b3849aeef895","step_index":8,"state":"DONE","step_type":"agent_response","duration_seconds":2.0,"usage":{"input_tokens":100,"output_tokens":20,"thinking_tokens":5,"cache_read_tokens":10,"total_tokens":120}}}

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
    assert_eq!(usage.output_tokens, 20 + 3, "output_tokens already includes thinking_tokens");
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
    let [DriverEvent::TurnFailed { error, problem }] = &events[..] else { panic!("{events:?}") };
    assert!(error.contains("Settings → Agents → Antigravity"), "{error}");
    // The friendly sentence is the headline text; the problem is what the buttons are keyed by.
    let problem = problem.as_ref().expect("a signed-out problem");
    assert_eq!((problem.kind, problem.subject.as_deref()), (kybern_protocol::rpc::ProblemKind::SignedOut, Some("antigravity")));
    assert_eq!(problem.detail.as_deref(), Some("authentication required"));

    // A crash with no result says what the process printed.
    let mut crashed = TurnMapper::new(None);
    let events = crashed.finish(Some(2), Some("authentication required"), false);
    assert!(matches!(&events[..], [DriverEvent::TurnFailed { error, .. }] if error.contains("Settings → Agents → Antigravity")));
    let mut other = TurnMapper::new(None);
    let events = other.finish(Some(3), Some("quota exhausted for today"), false);
    let [DriverEvent::TurnFailed { error, .. }] = &events[..] else { panic!() };
    assert!(error.starts_with("Antigravity stopped: quota exhausted for today."));
    assert!(error.ends_with("pick another agent."));
    // The structured `error` event is used when nothing was printed on stderr.
    let mut evented = TurnMapper::new(None);
    feed(&mut evented, r#"{"event":"error","error":"model not found"}"#);
    let events = evented.finish(Some(1), None, false);
    assert!(matches!(&events[..], [DriverEvent::TurnFailed { error, .. }] if error.contains("model not found")));
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

/// agy 1.5.12, recorded: a first turn that failed (here a model the run could not
/// load; in the field, a `NOT_FOUND (code 404)` from the model API) writes an
/// `error_message` step.
const FAILED_TURN: &str = r#"
{"event":"init","conversation_id":"3769f60d-02b2-4146-ad16-e8ce648d976d","init":{"cwd":"/work","permission_mode":"always-proceed","tools":["run_command","view_file"]}}
{"event":"step_update","step_update":{"conversation_id":"3769f60d-02b2-4146-ad16-e8ce648d976d","step_index":0,"state":"DONE","step_type":"user_input"}}
{"event":"step_update","step_update":{"conversation_id":"3769f60d-02b2-4146-ad16-e8ce648d976d","step_index":1,"state":"DONE","step_type":"error_message"}}
{"event":"result","result":{"conversation_id":"3769f60d-02b2-4146-ad16-e8ce648d976d","status":"ERROR","response":"","error":"failed to construct executor: plan model not specified; you must specify a valid model","duration_seconds":0,"num_turns":1,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0},"finished_reason":"error"}}
"#;

/// The next turn of that conversation, recorded: it answers and `agy` exits 0, yet
/// the result repeats the first turn's error. Every later turn does the same.
const ANSWERED_AFTER_A_FAILED_TURN: &str = r#"
{"event":"init","conversation_id":"3769f60d-02b2-4146-ad16-e8ce648d976d","init":{"model":"gemini-4-neon-low","cwd":"/work","permission_mode":"always-proceed","tools":["run_command","view_file"]}}
{"event":"step_update","step_update":{"conversation_id":"3769f60d-02b2-4146-ad16-e8ce648d976d","step_index":2,"state":"DONE","step_type":"user_input"}}
{"event":"step_update","step_update":{"conversation_id":"3769f60d-02b2-4146-ad16-e8ce648d976d","step_index":3,"state":"DONE","step_type":"system_message","duration_seconds":0.000115952}}
{"event":"step_update","step_update":{"conversation_id":"3769f60d-02b2-4146-ad16-e8ce648d976d","step_index":4,"state":"ACTIVE","step_type":"agent_response","text_delta":"hi"}}
{"event":"step_update","step_update":{"conversation_id":"3769f60d-02b2-4146-ad16-e8ce648d976d","step_index":4,"state":"DONE","step_type":"agent_response","text_delta":"\n","duration_seconds":3.636149031,"usage":{"input_tokens":13097,"output_tokens":22,"thinking_tokens":20,"cache_read_tokens":0,"total_tokens":13119}}}
{"event":"result","result":{"conversation_id":"3769f60d-02b2-4146-ad16-e8ce648d976d","status":"ERROR","response":"hi\n","error":"failed to construct executor: plan model not specified; you must specify a valid model","duration_seconds":10.773591171,"num_turns":2,"usage":{"input_tokens":13097,"output_tokens":22,"thinking_tokens":20,"cache_read_tokens":0,"total_tokens":13119},"finished_reason":"error"}}
"#;

#[test]
fn a_failed_turn_with_an_error_step_still_fails() {
    let mut mapper = TurnMapper::new(None);
    feed(&mut mapper, FAILED_TURN);
    let events = mapper.finish(Some(3), None, false);
    assert!(matches!(&events[..], [DriverEvent::TurnFailed { error, .. }] if error.contains("plan model not specified")), "{events:?}");
    // The field case: the model API's 404 on the first turn (before the model answered) is not retryable.
    let mut field = TurnMapper::new(None);
    feed(
        &mut field,
        &FAILED_TURN.replace(
            "failed to construct executor: plan model not specified; you must specify a valid model",
            "NOT_FOUND (code 404): Requested entity was not found.",
        ),
    );
    let events = field.finish(Some(1), None, false);
    let [DriverEvent::TurnFailed { error, problem }] = &events[..] else { panic!("{events:?}") };
    assert!(error.contains("NOT_FOUND"), "{error}");
    let problem = problem.as_ref().expect("404 problem");
    assert_eq!((problem.kind, problem.subject.as_deref()), (kybern_protocol::rpc::ProblemKind::NotFound, Some("antigravity")));
    assert_eq!(problem.title.as_deref(), Some("Antigravity couldn't use this model"));
    assert_eq!(problem.hint.as_deref(), Some("Choose another model, then send your message again."));
    let action = problem.action.as_ref().expect("model-picker action");
    assert_eq!((action.id.as_str(), action.label.as_str()), ("choose_model", "Choose another model"));
    assert_eq!(action.params, Some(json!({ "provider": "antigravity" })));
    assert!(!problem.retryable, "a 404 before reaching the model is not retryable: {problem:?}");

    // A 404 after the model already answered in this turn is a transient edge error and retryable.
    let mut mid_turn = TurnMapper::new(None);
    feed(
        &mut mid_turn,
        r#"
{"event":"init","conversation_id":"c-404","init":{"model":"gemini-4-neon-low"}}
{"event":"step_update","step_update":{"conversation_id":"c-404","step_index":0,"state":"DONE","step_type":"user_input"}}
{"event":"step_update","step_update":{"conversation_id":"c-404","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"checking"}}
{"event":"step_update","step_update":{"conversation_id":"c-404","step_index":2,"state":"DONE","step_type":"error_message"}}
{"event":"result","result":{"conversation_id":"c-404","status":"ERROR","response":"","error":"NOT_FOUND (code 404): Requested entity was not found.","finished_reason":"error"}}
"#,
    );
    let events = mid_turn.finish(Some(1), None, false);
    let [DriverEvent::TurnFailed { problem, .. }] = &events[..] else { panic!("{events:?}") };
    let problem = problem.as_ref().expect("mid-turn 404 problem");
    assert_eq!((problem.kind, problem.subject.as_deref()), (kybern_protocol::rpc::ProblemKind::Internal, Some("antigravity")));
    assert_eq!(problem.title.as_deref(), Some("Antigravity hit a temporary error"));
    assert_eq!(problem.hint.as_deref(), Some("Send your message again to continue."));
    assert!(problem.retryable, "a mid-turn 404 is retryable: {problem:?}");
    assert_eq!(problem.action.as_ref().map(|a| (a.id.as_str(), a.label.as_str())), Some(("retry", "Try again")));
}

#[test]
fn friendly_error_does_not_blame_sign_in_for_runtime_crashes() {
    assert!(!friendly_error("panic in oauth_client.go: nil pointer").contains("Settings → Agents → Antigravity"));
    assert!(!friendly_error("failed reading login.go").contains("Settings → Agents → Antigravity"));
    assert!(!friendly_error("credential store locked").contains("Settings → Agents → Antigravity"));
    assert!(!friendly_error("timed out after 401ms").contains("Settings → Agents → Antigravity"));
    assert!(friendly_error("Authentication required. Please visit the URL to log in:").contains("Settings → Agents → Antigravity"));
}

#[test]
fn invalid_thinking_signature_is_detected_and_poisons_the_mapper() {
    let missing = r#"Error 400, Message: {"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0.thinking.signature: Field required"}}, Status: INVALID_ARGUMENT"#;
    let invalid = r#"Error 400, Message: {"type":"error","error":{"type":"invalid_request_error","message":"messages.3.content.0: Invalid `signature` in `thinking` block"}}, Status: INVALID_ARGUMENT"#;
    assert!(is_invalid_thinking_signature(missing));
    assert!(is_invalid_thinking_signature(invalid));
    assert!(!is_invalid_thinking_signature("xmessages.1.content.0.thinking.signature: Field required"));
    assert!(!is_invalid_thinking_signature("Error 400, Message: Request contains an invalid argument."));

    let mut mapper = TurnMapper::resumed(None, Some("conv-old".into()));
    feed(
        &mut mapper,
        &serde_json::json!({
            "event": "result",
            "result": {"conversation_id": "conv-old", "status": "ERROR", "response": "", "error": invalid, "finished_reason": "error"}
        })
        .to_string(),
    );
    let events = mapper.finish(Some(1), None, false);
    assert!(mapper.conversation_poisoned());
    let [DriverEvent::TurnFailed { error, problem }] = &events[..] else { panic!("{events:?}") };
    assert!(error.contains("fresh conversation"), "{error}");
    let problem = problem.as_ref().expect("problem");
    assert!(problem.retryable);
    assert_eq!(problem.detail.as_deref(), Some(invalid));
}

#[test]
fn an_earlier_turns_error_repeated_after_an_answer_does_not_fail_the_turn() {
    let mut mapper = TurnMapper::resumed(None, Some("3769f60d-02b2-4146-ad16-e8ce648d976d".into()));
    let mut events = feed(&mut mapper, ANSWERED_AFTER_A_FAILED_TURN);
    events.extend(mapper.finish(Some(0), None, false));
    assert!(!events.iter().any(|event| matches!(event, DriverEvent::TurnFailed { .. })), "{events:?}");
    assert!(events.iter().any(|event| matches!(event, DriverEvent::MessageCompleted { text, .. } if text == "hi\n")));
    let Some(DriverEvent::TurnCompleted { stop_reason, usage, .. }) = events.last() else { panic!("{events:?}") };
    assert_eq!(*stop_reason, StopReason::Completed);
    assert_eq!((usage.input_tokens, usage.output_tokens), (13097, 22));

    // The same error with an error step of this turn's own is a real failure.
    let mut own = TurnMapper::new(None);
    let with_step = ANSWERED_AFTER_A_FAILED_TURN.replace(
        r#""step_index":3,"state":"DONE","step_type":"system_message""#,
        r#""step_index":3,"state":"DONE","step_type":"error_message""#,
    );
    feed(&mut own, &with_step);
    assert!(matches!(&own.finish(Some(1), None, false)[..], [DriverEvent::TurnFailed { .. }]));
    // A partial answer cut off by `--print-timeout` is not a complete answer.
    let mut timed_out = TurnMapper::new(None);
    feed(&mut timed_out, &ANSWERED_AFTER_A_FAILED_TURN.replace(r#""finished_reason":"error""#, r#""finished_reason":"print_timeout""#));
    assert!(matches!(&timed_out.finish(Some(1), None, false)[..], [DriverEvent::TurnFailed { .. }]));
    // An error with no answer at all still fails.
    let mut empty = TurnMapper::new(None);
    feed(
        &mut empty,
        r#"{"event":"result","result":{"conversation_id":"c","status":"ERROR","response":"","error":"boom","finished_reason":"error"}}"#,
    );
    assert!(matches!(&empty.finish(Some(1), None, false)[..], [DriverEvent::TurnFailed { .. }]));
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

/// `agy models` as 1.4.12 prints it on a signed-in Mac.
const TIERED_MODELS: &str = "Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\nclaude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n";

#[test]
fn tiers_of_one_model_become_one_row_with_efforts() {
    let models = parse_models(TIERED_MODELS);
    let rows: Vec<(&str, &str)> = models.iter().map(|model| (model.id.as_str(), model.display_name.as_str())).collect();
    assert_eq!(
        rows,
        [
            ("gemini-3.8-flash-high", "Gemini 3.8 Flash"),
            ("claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)"),
            ("claude-opus-4-6-thinking", "Claude Opus 4.6 (Thinking)"),
            // A single tier is just a model.
            ("gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"),
        ]
    );
    assert_eq!(models[0].efforts, ["low", "medium", "high"]);
    assert_eq!(models[0].default_effort.as_deref(), Some("high"));
    assert!(models[0].is_default);
    assert!(models[1..].iter().all(|model| model.efforts.is_empty() && model.default_effort.is_none() && !model.is_default));
}

#[test]
fn the_effort_picks_the_tier_slug() {
    let families = tier_families(&parse_models(TIERED_MODELS));
    assert_eq!(families, [TierFamily { base: "gemini-3.8-flash".into(), tiers: vec!["low".into(), "medium".into(), "high".into()] }]);
    let run = |model: Option<&str>, effort: Option<&str>| turn_model(model, effort, &families);
    let pair = |model: &str, effort: Option<&str>| (Some(model.to_string()), effort.map(str::to_string));
    // The row's id at low effort runs the low tier, without --effort.
    assert_eq!(run(Some("gemini-3.8-flash-high"), Some("low")), pair("gemini-3.8-flash-low", None));
    // A thread that picked a tier before rows were grouped follows the effort too.
    assert_eq!(run(Some("gemini-3.8-flash-medium"), Some("high")), pair("gemini-3.8-flash-high", None));
    // No tier for the effort (or no effort): the held tier.
    assert_eq!(run(Some("gemini-3.8-flash-medium"), Some("max")), pair("gemini-3.8-flash-medium", None));
    assert_eq!(run(Some("gemini-3.8-flash-low"), None), pair("gemini-3.8-flash-low", None));
    // Other models keep their effort; a look-alike prefix is not a tier.
    assert_eq!(run(Some("gpt-oss-120b-medium"), Some("high")), pair("gpt-oss-120b-medium", Some("high")));
    assert_eq!(run(Some("gemini-3.8-flash-highx"), Some("low")), pair("gemini-3.8-flash-highx", Some("low")));
    assert_eq!(run(None, Some("xhigh")), (None, Some("xhigh".to_string())));
    // Without a catalog the slug runs as listed.
    assert_eq!(turn_model(Some("gemini-3.8-flash-high"), Some("low"), &[]), pair("gemini-3.8-flash-high", Some("low")));
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
        compaction: Default::default(),
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
    assert_eq!(limits[0].used_percent, 25.0, "the metered (first) host reading wins even when less used");
    assert_eq!(limits[0].window_minutes, Some(300));
    assert_eq!(limits[0].resets_at, Some(1_793_534_400));
    assert_eq!(limits[1].name, "Gemini · Weekly");
    assert_eq!(limits[1].used_percent, 0.0);
    assert_eq!(limits[2].name, "Claude · Weekly");
    assert_eq!(limits[2].used_percent, 10.0);
    // Reversing the host order (Workspace/business accounts billed on prod) makes production win.
    let business = to_limits(&merge_buckets([parse_quota_summary(&production), parse_quota_summary(&daily)]));
    assert_eq!(business[0].used_percent, 50.0);
}

#[test]
fn an_unstarted_window_has_no_reset_time() {
    // Recorded 2026-11-19T14:58:55Z (Google AI Pro, nothing used): an untouched window's
    // `resetTime` is the read time plus the window, so every read moved it again.
    let recorded = json!({"groups": [{"buckets": [
        {"bucketId": "3p-weekly", "displayName": "Weekly Limit Remaining", "window": "weekly", "resetTime": "2026-11-26T14:58:55Z", "remainingFraction": 1},
        {"bucketId": "3p-5h", "displayName": "Five Hour Limit Remaining", "window": "5h", "resetTime": "2026-11-19T19:58:55Z", "remainingFraction": 1}],
        "displayName": "Claude and GPT models",
        "description": "Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B"}]});
    let limits = to_limits(&parse_quota_summary(&recorded));
    assert_eq!(limits.len(), 2);
    assert_eq!(limits[0].name, "Claude and GPT models · 5-hour", "the row names the models it covers");
    assert!(limits.iter().all(|limit| limit.used_percent == 0.0 && limit.resets_at.is_none()), "{limits:?}");
    // Once something is used the window has started, and its reset time is real.
    let started = json!({"groups": [{"displayName": "Claude and GPT models", "buckets": [
        {"bucketId": "3p-5h", "window": "5h", "resetTime": "2026-11-19T19:58:55Z", "remainingFraction": 0.96}]}]});
    assert_eq!(to_limits(&parse_quota_summary(&started))[0].resets_at, Some(1_795_118_335));
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

#[test]
fn env_home_prefers_platform_home_variable_and_skips_empty() {
    let both = BTreeMap::from([("HOME".into(), "/home/unix".into()), ("USERPROFILE".into(), r"C:\Users\win".into())]);
    #[cfg(windows)]
    assert_eq!(env_home_with(&both, |_| None), Some(PathBuf::from(r"C:\Users\win")));
    #[cfg(not(windows))]
    assert_eq!(env_home_with(&both, |_| None), Some(PathBuf::from("/home/unix")));
    let empty_primary = BTreeMap::from([("HOME".into(), String::new()), ("USERPROFILE".into(), r"C:\Users\win".into())]);
    assert_eq!(env_home_with(&empty_primary, |_| None), Some(PathBuf::from(r"C:\Users\win")));
    assert_eq!(
        env_home_with(&BTreeMap::new(), |key| (key == "USERPROFILE").then(|| r"C:\Users\fallback".into())),
        Some(PathBuf::from(r"C:\Users\fallback"))
    );
}

#[test]
fn one_shot_cleanup_only_deletes_summary_rows_for_its_scratch_workspace() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    let scratch_work = root.path().join("scratch/work");
    std::fs::create_dir_all(&scratch_work).unwrap();
    let agy_dir = home.join(".gemini/antigravity-cli");
    std::fs::create_dir_all(agy_dir.join("conversations")).unwrap();
    std::fs::create_dir_all(agy_dir.join("brain/conv-scratch")).unwrap();
    std::fs::create_dir_all(agy_dir.join("brain/conv-real")).unwrap();
    std::fs::write(agy_dir.join("conversations/conv-scratch.db"), "scratch").unwrap();
    std::fs::write(agy_dir.join("conversations/conv-real.db"), "real").unwrap();

    let slash = scratch_work.display().to_string().replace('\\', "/");
    let scratch_uri = if slash.starts_with('/') { format!("file://{slash}") } else { format!("file:///{slash}") };
    let db = rusqlite::Connection::open(agy_dir.join("conversation_summaries.db")).unwrap();
    db.execute_batch(
        "CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT, last_modified_time INTEGER, workspace_uris TEXT, parent_conversation_id TEXT);",
    )
    .unwrap();
    db.execute(
        "INSERT INTO conversation_summaries VALUES ('conv-scratch', 'Title', '', 1790000100, ?1, NULL)",
        [serde_json::to_string(&vec![scratch_uri]).unwrap()],
    )
    .unwrap();
    db.execute(
        "INSERT INTO conversation_summaries VALUES ('conv-real', 'Real', '', 1790000200, '[\"file:///work/real-project\"]', NULL)",
        [],
    )
    .unwrap();
    drop(db);

    // Matching scratch workspace: both the summary row and files are removed.
    cleanup_one_shot_conversation(&home, "conv-scratch", &scratch_work);
    assert!(!agy_dir.join("conversations/conv-scratch.db").exists());
    assert!(!agy_dir.join("brain/conv-scratch").exists());

    // Mismatched workspace: neither the summary row nor the files are touched.
    cleanup_one_shot_conversation(&home, "conv-real", &scratch_work);
    assert!(agy_dir.join("conversations/conv-real.db").exists());
    assert!(agy_dir.join("brain/conv-real").exists());

    let db = rusqlite::Connection::open(agy_dir.join("conversation_summaries.db")).unwrap();
    let remaining: Vec<String> = db
        .prepare("SELECT conversation_id FROM conversation_summaries ORDER BY conversation_id")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(std::result::Result::unwrap)
        .collect();
    assert_eq!(remaining, ["conv-real"]);
}

#[cfg(unix)]
mod process {
    use super::*;

    /// A stand-in `agy`: records its arguments and stdin, then plays a script.
    fn fake_agy(root: &Path, script: &str) -> PathBuf {
        let binary = root.join("agy");
        kybern_protocol::process::write_executable(
            &binary,
            format!(
                "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 1.4.12; exit 0; fi\nif [ \"$1\" = models ]; then printf 'Fetching available models...\\ngemini-3.8-flash-low\\tGemini 3.8 Flash (Low)\\nclaude-sonnet-4-6\\tClaude Sonnet 4.6\\n'; exit 0; fi\nprintf '%s\\n' \"$*\" >> \"{root}/args.log\"\nIFS= read -r line\nprintf '%s\\n' \"$line\" >> \"{root}/stdin.log\"\n{script}\n",
                root = root.display()
            ),
        )
        .unwrap();
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
        assert!(matches!(&first[0], DriverEvent::CommandsUpdated(commands) if commands.iter().any(|c| c.name == "goal")));
        assert!(matches!(&first[1], DriverEvent::SessionBound { session_id, .. } if session_id == "conv-1"));
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
            matches!(ended.last(), Some(DriverEvent::TurnFailed { error, .. }) if error.contains("Settings → Agents → Antigravity")),
            "{ended:?}"
        );
        session.send_message("m2", &UserMessage::text("again")).await.unwrap();
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

    #[tokio::test]
    async fn one_shot_cleans_up_its_temporary_conversation_and_leaves_others_alone() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let agy_dir = home.join(".gemini/antigravity-cli");
        std::fs::create_dir_all(agy_dir.join("conversations")).unwrap();
        std::fs::create_dir_all(agy_dir.join("annotations")).unwrap();
        std::fs::create_dir_all(agy_dir.join("presence")).unwrap();
        // Seed an existing real conversation that must survive one-shot cleanup.
        let keep_logs = agy_dir.join("brain/keep-conv/.system_generated/logs");
        std::fs::create_dir_all(&keep_logs).unwrap();
        std::fs::write(keep_logs.join("transcript.jsonl"), "{\"step_index\":0,\"type\":\"USER_INPUT\",\"content\":\"keep\"}\n").unwrap();
        std::fs::write(agy_dir.join("conversations/keep-conv.db"), "keep").unwrap();
        let db = rusqlite::Connection::open(agy_dir.join("conversation_summaries.db")).unwrap();
        db.execute_batch(
            "CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT, last_modified_time INTEGER, workspace_uris TEXT, parent_conversation_id TEXT);
             INSERT INTO conversation_summaries VALUES ('keep-conv', 'Keep me', '', 1790000000, '[\"file:///work\"]', NULL);",
        )
        .unwrap();
        drop(db);

        // Fake `agy` writes all the artifacts a real `-p=` run creates for `conv-temp`.
        let script = format!(
            r#"mkdir -p "{agy}/brain/conv-temp/.system_generated/logs"
printf '{{"step_index":0,"type":"USER_INPUT","content":"title"}}\n' > "{agy}/brain/conv-temp/.system_generated/logs/transcript.jsonl"
printf 'x' > "{agy}/conversations/conv-temp.db"
printf 'x' > "{agy}/conversations/conv-temp.db-wal"
printf 'x' > "{agy}/annotations/conv-temp.pbtxt"
printf 'x' > "{agy}/presence/conv-temp.lock"
printf '%s\n\n' '{{"event":"init","conversation_id":"conv-temp","init":{{"model":"gemini-3.8-flash-low"}}}}'
printf '%s\n\n' '{{"event":"result","result":{{"conversation_id":"conv-temp","status":"SUCCESS","response":"Short title"}}}}'"#,
            agy = agy_dir.display()
        );
        let binary = fake_agy(root.path(), &script);

        let env = BTreeMap::from([("HOME".to_string(), home.display().to_string())]);
        let answer = AntigravityDriver::default().one_shot(root.path(), "title please", Some(&binary), &env).await.unwrap();
        assert_eq!(answer, "Short title");
        assert!(!agy_dir.join("conversations/conv-temp.db").exists());
        assert!(!agy_dir.join("conversations/conv-temp.db-wal").exists());
        assert!(!agy_dir.join("brain/conv-temp").exists());
        assert!(!agy_dir.join("annotations/conv-temp.pbtxt").exists());
        assert!(!agy_dir.join("presence/conv-temp.lock").exists());
        // The real conversation stays intact and is the only one listed by the session scanner.
        assert!(agy_dir.join("conversations/keep-conv.db").exists());
        assert!(keep_logs.join("transcript.jsonl").exists());
        let listed = crate::sessions::list(ProviderKind::Antigravity, &ProbeContext { env, ..Default::default() }, None, "").await.unwrap();
        let ids: Vec<&str> = listed.sessions.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["keep-conv"]);
    }

    #[tokio::test]
    async fn a_poisoned_thinking_signature_drops_the_conversation_id_for_the_next_turn() {
        let root = tempfile::tempdir().unwrap();
        let flag = root.path().join("failed-once");
        let script = format!(
            r#"if [ ! -e "{flag}" ]; then
  touch "{flag}"
  printf '%s\n\n' '{{"event":"init","conversation_id":"conv-poisoned","init":{{"model":"claude-sonnet-4-6"}}}}'
  printf '%s\n\n' '{{"event":"result","result":{{"conversation_id":"conv-poisoned","status":"ERROR","response":"","error":"Error 400, Message: {{\"type\":\"error\",\"error\":{{\"message\":\"messages.1.content.0.thinking.signature: Field required\"}}}}, Status: INVALID_ARGUMENT","finished_reason":"error"}}}}'
  exit 1
fi
printf '%s\n\n' '{{"event":"init","conversation_id":"conv-fresh","init":{{"model":"claude-sonnet-4-6"}}}}'
printf '%s\n\n' '{{"event":"result","result":{{"conversation_id":"conv-fresh","status":"SUCCESS","response":"recovered"}}}}'"#,
            flag = flag.display()
        );
        let binary = fake_agy(root.path(), &script);
        let mut cfg = config(&binary, root.path());
        cfg.resume_session_id = Some("conv-poisoned".into());
        let SpawnedSession { session, mut events } = AntigravityDriver::default().spawn(cfg).await.unwrap();
        session.send_message("m1", &UserMessage::text("first")).await.unwrap();
        let failed = next_turn_end(&mut events).await;
        assert!(matches!(failed.last(), Some(DriverEvent::TurnFailed { .. })), "{failed:?}");
        session.send_message("m2", &UserMessage::text("retry")).await.unwrap();
        let recovered = next_turn_end(&mut events).await;
        assert!(matches!(recovered.last(), Some(DriverEvent::TurnCompleted { stop_reason: StopReason::Completed, .. })), "{recovered:?}");
        let args = std::fs::read_to_string(root.path().join("args.log")).unwrap();
        let lines: Vec<&str> = args.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("--conversation conv-poisoned"), "{}", lines[0]);
        assert!(!lines[1].contains("--conversation"), "poisoned conversation must be dropped: {}", lines[1]);
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

/// Recorded 2026-11-19 from the daily host with the CLI User-Agent (Google AI Pro).
fn three_group_summary() -> serde_json::Value {
    json!({"groups": [
        {"displayName": "Gemini Models", "description": "Models within this group: Gemini 4 Neon, Gemini 4 Hydrogen, Gemini 3.8 Flash",
         "buckets": [
            {"bucketId": "gemini-weekly", "displayName": "Weekly Limit Remaining", "window": "weekly", "resetTime": "2026-11-26T14:43:26Z", "remainingFraction": 0.915},
            {"bucketId": "gemini-5h", "displayName": "Five Hour Limit Remaining", "window": "5h", "resetTime": "2026-11-19T19:43:26Z", "remainingFraction": 0.769}]},
        {"displayName": "Claude and GPT models", "buckets": [
            {"bucketId": "3p-weekly", "window": "weekly", "resetTime": "2026-11-26T16:10:27Z", "remainingFraction": 1},
            {"bucketId": "3p-5h", "window": "5h", "resetTime": "2026-11-19T21:10:27Z", "remainingFraction": 1}]},
        {"displayName": "Gemini 4 Argon", "description": "For paid Pro plans, Argon quota is separate.",
         "buckets": [{"bucketId": "gemini-argon-wtu-weekly", "displayName": "Gemini 4 Argon Weekly Limit", "window": "weekly", "resetTime": "2026-11-26T16:10:27Z", "remainingFraction": 1}]}]})
}

/// The same account through `agy -p "/usage" --output-format json` (trimmed to the parts Kybern reads).
fn agy_usage_json() -> serde_json::Value {
    json!({"conversation_id": "", "status": "SUCCESS", "num_turns": 0, "command": {"name": "usage", "data": {"groups": [
        {"name": "Gemini Models", "description": "Models within this group: Gemini 4 Neon", "buckets": [
            {"id": "gemini-weekly", "name": "Weekly Limit Remaining", "window": "weekly", "remaining_fraction": 0.9127, "reset_time": "2026-11-26T14:43:26Z"},
            {"id": "gemini-5h", "name": "Five Hour Limit Remaining", "window": "5h", "remaining_fraction": 0.7545, "reset_time": "2026-11-19T19:43:26Z"}]},
        {"name": "Claude and GPT models", "buckets": [
            {"id": "3p-weekly", "name": "Weekly Limit Remaining", "window": "weekly", "remaining_fraction": 1, "reset_time": "2026-11-26T16:10:27Z"},
            {"id": "3p-5h", "name": "Five Hour Limit Remaining", "window": "5h", "remaining_fraction": 1, "reset_time": "2026-11-19T21:10:27Z"}]},
        {"name": "Gemini 4 Argon", "buckets": [
            {"id": "gemini-argon-wtu-weekly", "name": "Gemini 4 Argon Weekly Limit", "window": "weekly", "remaining_fraction": 1, "reset_time": "2026-11-26T16:10:27Z"}]}]}}})
}

#[test]
fn every_group_becomes_rows_gemini_first() {
    let limits = to_limits(&parse_quota_summary(&three_group_summary()));
    let rows: Vec<_> = limits.iter().map(|limit| (limit.name.as_str(), limit.used_percent, limit.window_minutes)).collect();
    assert_eq!(
        rows,
        [
            ("Gemini Models · 5-hour", 23.1, Some(300)),
            ("Gemini Models · Weekly", 8.5, Some(10080)),
            ("Gemini 4 Argon · Weekly", 0.0, Some(10080)),
            ("Claude and GPT models · 5-hour", 0.0, Some(300)),
            ("Claude and GPT models · Weekly", 0.0, Some(10080)),
        ]
    );
    // Used windows keep Google's reset time; untouched ones have none (the next test).
    assert_eq!(limits[0].resets_at, Some(1_795_117_406));
    assert!(limits[2..].iter().all(|limit| limit.resets_at.is_none()), "{limits:?}");
}

#[test]
fn agy_usage_json_parses_into_the_same_rows() {
    let from_agy = to_limits(&parse_agy_usage(&agy_usage_json()));
    let names: Vec<_> = from_agy.iter().map(|limit| limit.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "Gemini Models · 5-hour",
            "Gemini Models · Weekly",
            "Gemini 4 Argon · Weekly",
            "Claude and GPT models · 5-hour",
            "Claude and GPT models · Weekly"
        ]
    );
    assert_eq!(from_agy[0].used_percent, 24.6);
    assert_eq!(from_agy[1].used_percent, 8.7);
    assert!(from_agy[2..].iter().all(|limit| limit.used_percent == 0.0 && limit.resets_at.is_none()));
    assert!(parse_agy_usage(&json!({"response": "no command data"})).is_empty());
}

#[test]
fn the_old_claude_only_summary_has_no_gemini_row_and_agy_fills_it_in() {
    let claude_only = json!({"groups": [{"displayName": "Claude and GPT models", "buckets": [
        {"bucketId": "3p-5h", "window": "5h", "resetTime": "2026-11-19T21:10:27Z", "remainingFraction": 0.96},
        {"bucketId": "3p-weekly", "window": "weekly", "resetTime": "2026-11-26T16:10:27Z", "remainingFraction": 1}]}]});
    let summary = parse_quota_summary(&claude_only);
    assert!(!to_limits(&summary).iter().any(|limit| limit.name.starts_with("Gemini")));
    // Merged by bucket id: the summary's Claude rows stay (the most-used reading wins) and Gemini arrives.
    let merged = to_limits(&merge_buckets([summary, parse_agy_usage(&agy_usage_json())]));
    let names: Vec<_> = merged.iter().map(|limit| (limit.name.as_str(), limit.used_percent)).collect();
    assert_eq!(names[0], ("Gemini Models · 5-hour", 24.6));
    assert!(names.contains(&("Claude and GPT models · 5-hour", 4.0)), "{names:?}");
    assert_eq!(merged.len(), 5);
}

#[test]
fn the_user_agent_names_the_cli_and_its_platform() {
    let agent = user_agent("1.5.12");
    let expected_os = if cfg!(target_os = "macos") { "darwin" } else { std::env::consts::OS };
    let expected_arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "amd64",
        other => other,
    };
    assert_eq!(agent, format!("antigravity/cli/1.5.12 {expected_os}/{expected_arch}"));
    assert!(agent.starts_with("antigravity/cli/"), "the plain `antigravity/<version>` name gets no Gemini group");
}

#[cfg(unix)]
#[tokio::test]
async fn agy_usage_runs_once_without_a_turn_and_is_reused() {
    use super::usage::read_agy_usage;
    let dir = tempfile::tempdir().unwrap();
    let binary = dir.path().join("agy");
    let calls = dir.path().join("calls");
    let answer = dir.path().join("answer.json");
    std::fs::write(&answer, agy_usage_json().to_string()).unwrap();
    kybern_protocol::process::write_executable(
        &binary,
        format!(
            "#!/bin/sh\necho \"$*\" >> '{}'\n[ \"$*\" = '-p /usage --output-format json' ] || exit 3\ncat '{}'\n",
            calls.display(),
            answer.display()
        ),
    )
    .unwrap();
    let env = std::collections::BTreeMap::new();
    let first = read_agy_usage(Some(&binary), &env, dir.path(), None).await;
    assert_eq!(first.len(), 5);
    let second = read_agy_usage(Some(&binary), &env, dir.path(), None).await;
    assert_eq!(second.len(), 5);
    let log = std::fs::read_to_string(&calls).unwrap();
    assert_eq!(log.lines().collect::<Vec<_>>(), ["-p /usage --output-format json"], "one call, then the cached answer");
}

#[cfg(unix)]
#[tokio::test]
async fn a_failing_agy_usage_reads_as_nothing() {
    use super::usage::read_agy_usage;
    let dir = tempfile::tempdir().unwrap();
    let binary = dir.path().join("agy");
    kybern_protocol::process::write_executable(&binary, "#!/bin/sh\necho 'not json'\nexit 1\n").unwrap();
    assert!(read_agy_usage(Some(&binary), &std::collections::BTreeMap::new(), dir.path(), None).await.is_empty());
}

/// What a signed-out `agy 1.5.13 -p /usage --output-format json` writes (sign-in URL cut short).
const AGY_SIGNED_OUT_STDERR: &str = "Authentication required. Please visit the URL to log in:\n  https://accounts.google.com/o/oauth2/auth?access_type=offline&state=x\n\nWaiting for authentication (timeout 60s)...\nOr, paste the authorization code here and press Enter:\n";
const AGY_SIGNED_OUT_STDOUT: &str = r#"{"conversation_id":"","status":"ERROR","response":"","error":"authentication failed or timed out","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0},"finished_reason":"error"}"#;

#[test]
fn a_signed_out_agy_is_told_from_its_output() {
    use super::usage::agy_signed_out;
    // The sign-in prompt arrives at once; the JSON error only after agy's own minute.
    assert!(agy_signed_out(b"", AGY_SIGNED_OUT_STDERR.as_bytes()));
    assert!(agy_signed_out(AGY_SIGNED_OUT_STDOUT.as_bytes(), b""));
    assert!(!agy_signed_out(agy_usage_json().to_string().as_bytes(), b""));
    assert!(!agy_signed_out(b"", b"dial tcp: lookup failed"));
}

/// A home with `agy`'s token file, expiring `hours` from now (negative: already expired).
#[cfg(all(unix, not(target_os = "macos")))]
fn home_with_token(hours: i64) -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    let dir = home.path().join(".gemini/antigravity-cli");
    std::fs::create_dir_all(&dir).unwrap();
    let expiry = (chrono::Utc::now() + chrono::Duration::hours(hours)).to_rfc3339();
    std::fs::write(dir.join("oauth_creds.json"), json!({"access_token": "ya29.test", "expiry": expiry}).to_string()).unwrap();
    home
}

/// A fake `agy` that logs each call and answers `/usage` from `$HOME/answer.json`, or
/// with the signed-out prompt (and then waits, as the real one does) while `$HOME/signed-out` exists.
/// `agy models` lists a model, or says to sign in while `$HOME/signed-out` exists.
#[cfg(all(unix, not(target_os = "macos")))]
fn fake_agy(dir: &std::path::Path, calls: &std::path::Path) -> std::path::PathBuf {
    let binary = dir.join("agy");
    kybern_protocol::process::write_executable(
        &binary,
        format!(
            "#!/bin/sh\necho \"$HOME $*\" >> '{}'\n\
             if [ \"$*\" = 'models' ]; then echo 'Fetching available models...'; \
             if [ -e \"$HOME/signed-out\" ]; then echo 'Error: Please sign in to view available models.'; \
             else printf 'gemini-4-neon-high\\tGemini 4 Neon\\n'; fi; exit 0; fi\n\
             [ \"$*\" = '-p /usage --output-format json' ] || exit 3\n\
             if [ -e \"$HOME/signed-out\" ]; then printf '%s' '{}' >&2; exec sleep 30; fi\ncat \"$HOME/answer.json\"\n",
            calls.display(),
            AGY_SIGNED_OUT_STDERR.replace('\'', "")
        ),
    )
    .unwrap();
    binary
}

#[cfg(all(unix, not(target_os = "macos")))]
fn env_for(home: &std::path::Path) -> std::collections::BTreeMap<String, String> {
    std::collections::BTreeMap::from([("HOME".to_string(), home.display().to_string())])
}

#[cfg(all(unix, not(target_os = "macos")))]
/// How many times `agy -p /usage` ran.
fn call_count(calls: &std::path::Path) -> usize {
    std::fs::read_to_string(calls).map(|log| log.lines().filter(|line| line.contains("/usage")).count()).unwrap_or(0)
}

/// How many times `agy models` ran.
#[cfg(all(unix, not(target_os = "macos")))]
fn models_count(calls: &std::path::Path) -> usize {
    std::fs::read_to_string(calls).map(|log| log.lines().filter(|line| line.ends_with(" models")).count()).unwrap_or(0)
}

#[cfg(all(unix, not(target_os = "macos")))]
#[tokio::test]
async fn an_expired_token_reads_the_limits_from_agy_instead_of_going_stale() {
    use super::usage::read_account_usage;
    let tools = tempfile::tempdir().unwrap();
    let calls = tools.path().join("calls");
    let binary = fake_agy(tools.path(), &calls);
    let home = home_with_token(-1);
    std::fs::write(home.path().join("answer.json"), agy_usage_json().to_string()).unwrap();
    let (limits, plan) = read_account_usage(home.path(), Some(&binary), &env_for(home.path())).await.unwrap();
    assert_eq!(limits.len(), 5);
    assert_eq!(limits[0].name, "Gemini Models · 5-hour");
    // `/usage` has no plan: the daemon keeps the last known one when this is `None`.
    assert_eq!(plan, None);
    assert_eq!(call_count(&calls), 1);
}

#[cfg(all(unix, not(target_os = "macos")))]
#[tokio::test]
async fn a_token_kybern_cannot_find_reads_the_limits_from_agy_too() {
    use super::usage::read_account_usage;
    let tools = tempfile::tempdir().unwrap();
    let calls = tools.path().join("calls");
    let binary = fake_agy(tools.path(), &calls);
    // The login lives in a keyring Kybern doesn't read: no token file at all.
    let home = tempfile::tempdir().unwrap();
    std::fs::write(home.path().join("answer.json"), agy_usage_json().to_string()).unwrap();
    let (limits, _) = read_account_usage(home.path(), Some(&binary), &env_for(home.path())).await.unwrap();
    assert_eq!(limits.len(), 5);
    assert_eq!(call_count(&calls), 1);
}

#[cfg(all(unix, not(target_os = "macos")))]
#[tokio::test]
async fn accounts_keep_their_own_agy_answers_and_pauses() {
    use super::usage::read_account_usage;
    use kybern_protocol::methods::LimitsStale;
    let tools = tempfile::tempdir().unwrap();
    let calls = tools.path().join("calls");
    let binary = fake_agy(tools.path(), &calls);
    let (first, second) = (home_with_token(-1), home_with_token(-1));
    let mut one = agy_usage_json();
    one.pointer_mut("/command/data/groups/0/buckets/1/remaining_fraction").unwrap().clone_from(&json!(0.5));
    std::fs::write(first.path().join("answer.json"), one.to_string()).unwrap();
    std::fs::write(second.path().join("answer.json"), agy_usage_json().to_string()).unwrap();
    let (a, _) = read_account_usage(first.path(), Some(&binary), &env_for(first.path())).await.unwrap();
    let (b, _) = read_account_usage(second.path(), Some(&binary), &env_for(second.path())).await.unwrap();
    assert_ne!(a[0].used_percent, b[0].used_percent, "one account's cached answer must not serve the other");
    assert_eq!(call_count(&calls), 2);
    // A repeat inside a minute is served from the account's own cache.
    read_account_usage(first.path(), Some(&binary), &env_for(first.path())).await.unwrap();
    assert_eq!(call_count(&calls), 2);
    // One account failing must not pause the other: `fake_agy` exits 3 for any other arguments,
    // so a third account with no answer file fails, and the first two still read.
    let third = tempfile::tempdir().unwrap();
    let failed = read_account_usage(third.path(), Some(&binary), &env_for(third.path())).await.unwrap_err();
    assert_eq!(failed.reason, LimitsStale::Unavailable);
    let paused = read_account_usage(third.path(), Some(&binary), &env_for(third.path())).await.unwrap_err();
    assert_eq!(paused.reason, LimitsStale::Throttled);
    std::fs::remove_file(second.path().join("answer.json")).unwrap();
    assert!(
        read_account_usage(second.path(), Some(&binary), &env_for(second.path())).await.is_ok(),
        "cached, and not paused by the third account"
    );
}

#[cfg(all(unix, not(target_os = "macos")))]
#[tokio::test]
async fn a_signed_out_agy_is_asked_once_and_remembered_until_a_login_appears() {
    use super::usage::read_account_usage;
    use kybern_protocol::methods::LimitsStale;
    let tools = tempfile::tempdir().unwrap();
    let calls = tools.path().join("calls");
    let binary = fake_agy(tools.path(), &calls);
    let home = tempfile::tempdir().unwrap();
    std::fs::write(home.path().join("signed-out"), "").unwrap();
    std::fs::write(home.path().join("answer.json"), agy_usage_json().to_string()).unwrap();
    let first = read_account_usage(home.path(), Some(&binary), &env_for(home.path())).await.unwrap_err();
    assert_eq!(first.reason, LimitsStale::SignedOut);
    // A signed-out `/usage` opens a browser sign-in: `agy models` said so first, so `/usage` never ran.
    assert_eq!(models_count(&calls), 1);
    assert_eq!(call_count(&calls), 0);
    let again = read_account_usage(home.path(), Some(&binary), &env_for(home.path())).await.unwrap_err();
    assert_eq!(again.reason, LimitsStale::SignedOut);
    assert_eq!(models_count(&calls), 1, "remembered: not asked again right away");
    // Signing in leaves a token file (expired here, so `agy` is asked once more): the pause lifts.
    std::fs::remove_file(home.path().join("signed-out")).unwrap();
    let dir = home.path().join(".gemini/antigravity-cli");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("oauth_creds.json"), json!({"access_token": "ya29.test", "expiry": "2020-01-01T00:00:00Z"}).to_string())
        .unwrap();
    let (limits, _) = read_account_usage(home.path(), Some(&binary), &env_for(home.path())).await.unwrap();
    assert_eq!(limits.len(), 5);
    assert_eq!(call_count(&calls), 1);
}

#[test]
fn a_signed_out_agy_models_is_told_from_its_output() {
    use super::usage::models_signed_out;
    assert!(models_signed_out(
        b"Fetching available models...\nError: Please sign in to view available models. Launch the CLI without arguments to sign in.\n",
        b""
    ));
    assert!(!models_signed_out(b"Fetching available models...\ngemini-4-neon-high\tGemini 4 Neon\n", b""));
    assert!(!models_signed_out(b"", b"dial tcp: lookup failed"));
}

/// What happened to a friend on macOS: `agy` keeps a login that `agy models` accepts, but the
/// `/usage` Kybern starts in the background can't renew it and opens Google's sign-in page each
/// time. Kybern read the limits again every couple of minutes and left ten sign-in tabs, and said
/// "signed out" while `agy` in a terminal was signed in.
#[cfg(all(unix, not(target_os = "macos")))]
#[tokio::test]
async fn a_usage_that_asks_to_sign_in_opens_no_browser_and_is_not_repeated_for_the_same_login() {
    use super::usage::{read_account_usage, read_agy_usage};
    use kybern_protocol::methods::LimitsStale;
    crate::no_browser::set_test_root();
    let tools = tempfile::tempdir().unwrap();
    let calls = tools.path().join("calls");
    // The person's real browser, found through PATH the way Go's browser helpers find it.
    let browser = tools.path().join("browser");
    std::fs::create_dir_all(&browser).unwrap();
    let opened = tools.path().join("opened");
    for name in ["open", "xdg-open"] {
        kybern_protocol::process::write_executable(&browser.join(name), format!("#!/bin/sh\necho \"$*\" >> '{}'\n", opened.display()))
            .unwrap();
    }
    let binary = tools.path().join("agy");
    kybern_protocol::process::write_executable(
        &binary,
        format!(
            "#!/bin/sh\necho \"$HOME $*\" >> '{}'\n\
             if [ \"$*\" = 'models' ]; then echo 'Fetching available models...'; printf 'gemini-4-neon-high\\tGemini 4 Neon\\n'; exit 0; fi\n\
             [ \"$*\" = '-p /usage --output-format json' ] || exit 3\n\
             xdg-open 'https://accounts.google.com/o/oauth2/auth' || open 'https://accounts.google.com/o/oauth2/auth'\n\
             printf '%s' '{}' >&2; exec sleep 30\n",
            calls.display(),
            AGY_SIGNED_OUT_STDERR.replace('\'', "")
        ),
    )
    .unwrap();
    let home = home_with_token(-1);
    let mut env = env_for(home.path());
    env.insert("PATH".into(), format!("{}:/usr/bin:/bin", browser.display()));

    let first = read_account_usage(home.path(), Some(&binary), &env).await.unwrap_err();
    assert_eq!(first.reason, LimitsStale::Throttled, "`agy models` is signed in, so this is not a sign-out: {first:?}");
    assert!(first.retry_at.is_some(), "the caption says when the next check is");
    assert_eq!(call_count(&calls), 1);
    assert!(!opened.exists(), "no browser opened: {:?}", std::fs::read_to_string(&opened).ok());

    // The next reads, and the Gemini top-up a working token would run, don't start `/usage` again.
    let again = read_account_usage(home.path(), Some(&binary), &env).await.unwrap_err();
    assert_eq!(again.reason, LimitsStale::Throttled);
    assert!(read_agy_usage(Some(&binary), &env, home.path(), None).await.is_empty());
    let login = crate::antigravity::read_login(Some(home.path())).await.unwrap();
    assert!(read_agy_usage(Some(&binary), &env, home.path(), Some(login.fingerprint())).await.is_empty());
    assert_eq!(call_count(&calls), 1, "asked once for this login");

    // `agy` stored a new login (signed in again, or renewed in a terminal): read at once.
    let dir = home.path().join(".gemini/antigravity-cli");
    std::fs::write(dir.join("oauth_creds.json"), json!({"access_token": "ya29.renewed", "expiry": "2020-01-01T00:00:00Z"}).to_string())
        .unwrap();
    std::fs::write(home.path().join("answer.json"), agy_usage_json().to_string()).unwrap();
    let after = read_account_usage(home.path(), Some(&binary), &env).await.unwrap_err();
    assert_eq!(call_count(&calls), 2, "the new login gets `/usage` back: {after:?}");
    assert!(!opened.exists());
}

/// A stand-in for Google's quota hosts: `loadCodeAssist` and `retrieveUserQuotaSummary` for the token
/// `accepted`, 401 for any other.
#[cfg(all(unix, not(target_os = "macos")))]
async fn quota_host(accepted: &'static str) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut request = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    let Ok(read) = socket.read(&mut chunk).await else { return };
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&chunk[..read]);
                    let text = String::from_utf8_lossy(&request).to_lowercase();
                    if let Some(end) = text.find("\r\n\r\n") {
                        let length = text[..end]
                            .lines()
                            .find_map(|line| line.strip_prefix("content-length:").and_then(|value| value.trim().parse::<usize>().ok()))
                            .unwrap_or(0);
                        if request.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                let text = String::from_utf8_lossy(&request).to_string();
                let (status, body) = if !text.to_lowercase().contains(&format!("authorization: bearer {accepted}")) {
                    ("401 Unauthorized", json!({"error": {"code": 401}}))
                } else if text.starts_with("POST /v1internal:loadCodeAssist") {
                    ("200 OK", json!({"cloudaicompanionProject": "project-1", "paidTier": {"id": "g1-pro-tier"}}))
                } else {
                    (
                        "200 OK",
                        json!({"groups": [
                            {"displayName": "Gemini Models", "buckets": [
                                {"bucketId": "gemini-5h", "window": "5h", "resetTime": "2026-11-22T05:00:00Z", "remainingFraction": 0.75},
                                {"bucketId": "gemini-weekly", "window": "weekly", "resetTime": "2026-11-28T05:00:00Z", "remainingFraction": 0.9}]},
                            {"displayName": "Claude and GPT models", "buckets": [
                                {"bucketId": "3p-5h", "window": "5h", "resetTime": "2026-11-22T05:00:00Z", "remainingFraction": 0.5}]}]}),
                    )
                };
                let body = body.to_string();
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.shutdown().await;
            });
        }
    });
    format!("http://{address}")
}

/// The reliable path: an expired (or refused) login is renewed by `agy models`, which never opens a
/// browser, and Kybern then asks Google itself. `agy -p /usage` never runs.
#[cfg(all(unix, not(target_os = "macos")))]
#[tokio::test]
async fn an_expired_login_is_renewed_by_agy_models_and_read_without_usage() {
    use super::usage::{TEST_HOST, read_account_usage};
    *TEST_HOST.lock().unwrap() = Some(quota_host("ya29.fresh").await);
    let tools = tempfile::tempdir().unwrap();
    let calls = tools.path().join("calls");
    let binary = tools.path().join("agy");
    // Like the real `agy`: any start renews an expired saved login and saves it. `/usage` must not run.
    kybern_protocol::process::write_executable(
        &binary,
        format!(
            "#!/bin/sh\necho \"$HOME $*\" >> '{}'\n\
             [ \"$*\" = 'models' ] || exit 3\n\
             printf '{{\"access_token\":\"ya29.fresh\",\"expiry\":\"2099-01-01T00:00:00Z\"}}' > \"$HOME/.gemini/antigravity-cli/oauth_creds.json\"\n\
             echo 'Fetching available models...'; printf 'gemini-4-neon-high\\tGemini 4 Neon\\n'\n",
            calls.display()
        ),
    )
    .unwrap();
    let home = home_with_token(-1);
    let env = env_for(home.path());

    let (limits, plan) = read_account_usage(home.path(), Some(&binary), &env).await.unwrap();
    assert_eq!(limits[0].name, "Gemini Models · 5-hour");
    assert_eq!(limits[0].used_percent, 25.0);
    assert_eq!(limits.len(), 3);
    assert_eq!(plan.as_deref(), Some("Google AI Pro"), "asked of Google directly, so the plan comes too");
    assert_eq!(models_count(&calls), 1, "one `agy models` renewed the login");
    assert_eq!(call_count(&calls), 0, "`/usage` never ran");

    // The renewed login is good for its hour: the next reads start no process for the limits.
    read_account_usage(home.path(), Some(&binary), &env).await.unwrap();
    assert_eq!(models_count(&calls), 1);

    // A login Google refuses before it expires is renewed the same way.
    let token = home.path().join(".gemini/antigravity-cli/oauth_creds.json");
    std::fs::write(&token, json!({"access_token": "ya29.revoked", "expiry": "2099-01-01T00:00:00Z"}).to_string()).unwrap();
    let (limits, _) = read_account_usage(home.path(), Some(&binary), &env).await.unwrap();
    assert_eq!(limits.len(), 3);
    assert_eq!(models_count(&calls), 2);
    assert_eq!(call_count(&calls), 0);
}

#[test]
fn a_keyring_value_is_read_in_each_of_go_keyrings_wrappers() {
    let json = r#"{"token":{"access_token":"ya29.a","expiry":"2026-11-22T09:05:27+08:00"},"id_token_email":"a@example.com"}"#;
    let hex: String = json.bytes().map(|byte| format!("{byte:02x}")).collect();
    for text in [json.to_string(), format!("go-keyring-encoded:{hex}")] {
        let login = parse_login(&text).expect("a login");
        assert_eq!(login.email.as_deref(), Some("a@example.com"));
    }
    assert!(parse_login("go-keyring-encoded:zz").is_none());
    assert!(parse_login("go-keyring-encoded:abc").is_none());
}

#[test]
fn business_and_consumer_accounts_are_distinguished_for_quota_host_order() {
    use super::usage::is_business_account;
    assert!(!is_business_account(Some("consumer"), &json!({})));
    assert!(!is_business_account(Some("oauth-personal"), &json!({"paidTier": {"id": "enterprise-tier"}})));
    assert!(is_business_account(Some("oauth-business"), &json!({"paidTier": {"id": "g1-pro-tier"}})));
    assert!(is_business_account(Some("workspace"), &json!({})));
    assert!(!is_business_account(Some("oauth"), &json!({"paidTier": {"id": "g1-pro-tier"}, "currentTier": {"id": "free-tier"}})));
    assert!(!is_business_account(None, &json!({"currentTier": {"id": "standard-tier"}})));
    assert!(is_business_account(Some("oauth"), &json!({"paidTier": {"id": "enterprise-tier"}})));
    assert!(is_business_account(None, &json!({"currentTier": {"id": "standard-tier", "userDefinedCloudaicompanionProject": true}})));
}

#[cfg(all(unix, not(target_os = "macos")))]
#[tokio::test]
async fn workspace_and_personal_accounts_read_their_own_metered_quota_host() {
    use super::usage::{TEST_HOSTS, read_account_usage};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn mock_host(load_body: Value, summary_body: Value) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let (load_body, summary_body) = (load_body.clone(), summary_body.clone());
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    let mut chunk = [0u8; 4096];
                    loop {
                        let Ok(read) = socket.read(&mut chunk).await else { return };
                        if read == 0 {
                            break;
                        }
                        request.extend_from_slice(&chunk[..read]);
                        let text = String::from_utf8_lossy(&request).to_lowercase();
                        if let Some(end) = text.find("\r\n\r\n") {
                            let length = text[..end]
                                .lines()
                                .find_map(|line| line.strip_prefix("content-length:").and_then(|v| v.trim().parse::<usize>().ok()))
                                .unwrap_or(0);
                            if request.len() >= end + 4 + length {
                                break;
                            }
                        }
                    }
                    let text = String::from_utf8_lossy(&request);
                    let body = if text.starts_with("POST /v1internal:loadCodeAssist") { load_body } else { summary_body }.to_string();
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        format!("http://{address}")
    }

    let daily_summary = json!({"groups": [
        {"displayName": "Gemini Models", "buckets": [
            {"bucketId": "gemini-5h", "window": "5h", "resetTime": "2099-01-01T05:00:00Z", "remainingFraction": 0.8},
            {"bucketId": "gemini-weekly", "window": "weekly", "resetTime": "2099-01-07T00:00:00Z", "remainingFraction": 0.2}
        ]}
    ]});
    let prod_summary = json!({"groups": [
        {"displayName": "Gemini Models", "buckets": [
            {"bucketId": "gemini-5h", "window": "5h", "resetTime": "2099-01-01T05:00:00Z", "remainingFraction": 0.4},
            {"bucketId": "gemini-weekly", "window": "weekly", "resetTime": "2099-01-07T00:00:00Z", "remainingFraction": 0.9}
        ]},
        {"displayName": "Claude and GPT models", "buckets": [
            {"bucketId": "3p-5h", "window": "5h", "resetTime": "2099-01-01T05:00:00Z", "remainingFraction": 0.6}
        ]}
    ]});

    // Business account: production host wins even when daily shows more usage (weekly 80% vs 10%).
    let daily_url = mock_host(json!({}), daily_summary.clone()).await;
    let prod_url =
        mock_host(json!({"cloudaicompanionProject": "proj-biz", "paidTier": {"id": "enterprise-tier"}}), prod_summary.clone()).await;
    *TEST_HOSTS.lock().unwrap() = Some((daily_url, prod_url));
    let biz_home = home_with_token(2);
    let (biz_limits, biz_plan) = read_account_usage(biz_home.path(), None, &env_for(biz_home.path())).await.unwrap();
    assert_eq!(biz_plan.as_deref(), Some("Enterprise"));
    assert_eq!(biz_limits[0].used_percent, 60.0, "production 5h wins for business account");
    assert_eq!(biz_limits[1].used_percent, 10.0, "production weekly wins even though daily is higher");
    assert_eq!(biz_limits[2].used_percent, 40.0);

    // Consumer account: daily host wins even when production shows more usage (5h 20% vs 60%),
    // while production still fills in groups daily omitted (`Claude and GPT models`).
    let daily_url = mock_host(json!({}), daily_summary).await;
    let prod_url = mock_host(json!({"cloudaicompanionProject": "proj-personal", "paidTier": {"id": "g1-pro-tier"}}), prod_summary).await;
    *TEST_HOSTS.lock().unwrap() = Some((daily_url, prod_url));
    let personal_home = home_with_token(2);
    let (personal_limits, personal_plan) = read_account_usage(personal_home.path(), None, &env_for(personal_home.path())).await.unwrap();
    *TEST_HOSTS.lock().unwrap() = None;
    assert_eq!(personal_plan.as_deref(), Some("Google AI Pro"));
    assert_eq!(personal_limits[0].used_percent, 20.0, "daily 5h wins even though production is higher");
    assert_eq!(personal_limits[1].used_percent, 80.0, "daily weekly wins for personal account");
    assert_eq!(personal_limits[2].used_percent, 40.0, "missing group is still filled in from fallback host");
}
