use super::*;
use crate::{RewindPoint, TurnAnchors};
use std::sync::Arc;
use std::time::Duration;

const DEADLINE: Duration = Duration::from_secs(2);

struct Harness {
    session: Arc<PiSession>,
    handle: Arc<Handle>,
    events: mpsc::Receiver<DriverEvent>,
}

impl Harness {
    fn new(flavor: Flavor) -> Self {
        Self::with_initialization(flavor, Some(Ok(()))).0
    }

    fn uninitialized(flavor: Flavor) -> (Self, tokio::sync::watch::Sender<Option<std::result::Result<(), String>>>) {
        Self::with_initialization(flavor, None)
    }

    fn with_initialization(
        flavor: Flavor,
        initial: Option<std::result::Result<(), String>>,
    ) -> (Self, tokio::sync::watch::Sender<Option<std::result::Result<(), String>>>) {
        let child = Arc::new(NdjsonChild::spawn(crate::test_process::echo()).unwrap());
        let (events, rx) = mpsc::channel(64);
        let (initialized_tx, initialized) = tokio::sync::watch::channel(initial);
        let session = Arc::new(PiSession {
            flavor,
            child: child.clone(),
            events,
            pending: Mutex::new(HashMap::new()),
            pending_approvals: Mutex::new(HashMap::new()),
            state: Mutex::new(State::default()),
            ready: Mutex::new(None),
            initialized,
            command_gate: Mutex::new(()),
            extension: None,
            _compaction_overlay: None,
            pending_app_tools: Mutex::new(HashMap::new()),
            app_tool_names: extension::DEFAULT_APP_TOOL_NAMES.iter().map(|name| (*name).to_string()).collect(),
            compaction_ended: tokio::sync::Notify::new(),
        });
        let handle = Arc::new(Handle(session.clone(), crate::ndjson::SessionLifetime::new(child)));
        (Self { session, handle, events: rx }, initialized_tx)
    }

    async fn wire(&self, expected_type: &str) -> Value {
        let value = tokio::time::timeout(DEADLINE, async { self.session.child.lines.lock().await.recv().await })
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for {expected_type}"))
            .unwrap_or_else(|| panic!("RPC process closed while waiting for {expected_type}"));
        assert_eq!(value["type"], expected_type, "unexpected RPC request: {value}");
        value
    }

    async fn reply(&self, request: &Value, data: Value) {
        self.session
            .handle_frame(json!({
                "type": "response",
                "id": request["id"],
                "success": true,
                "data": data,
            }))
            .await;
    }

    async fn reject(&self, request: &Value, error: &str) {
        self.session
            .handle_frame(json!({
                "type": "response",
                "id": request["id"],
                "success": false,
                "error": error,
            }))
            .await;
    }

    async fn next_event(&mut self) -> DriverEvent {
        tokio::time::timeout(DEADLINE, self.events.recv()).await.expect("timed out waiting for driver event").expect("event stream closed")
    }

    async fn next_completion(&mut self) -> DriverEvent {
        loop {
            let event = self.next_event().await;
            if matches!(event, DriverEvent::TurnCompleted { .. } | DriverEvent::TurnFailed { .. }) {
                return event;
            }
        }
    }

    async fn settle(&mut self) -> DriverEvent {
        self.session.schedule_finish().await;
        let state = self.wire("get_state").await;
        self.reply(&state, json!({ "isStreaming": false, "isCompacting": false, "pendingMessageCount": 0 })).await;
        let messages = self.wire("get_fork_messages").await;
        self.reply(&messages, json!({ "messages": [] })).await;
        let completion = self.next_completion().await;
        let stats = self.wire("get_session_stats").await;
        self.reply(&stats, json!({})).await;
        completion
    }
}

async fn active_turn(session: &PiSession) {
    let admitted_at = session.admission_revision().await;
    session.begin_turn(false, admitted_at).await.unwrap().unwrap();
    let mut state = session.state.lock().await;
    state.prompt_pending = false;
    state.native_started = true;
}

fn text_message(text: &str) -> UserMessage {
    UserMessage { parts: vec![ContentPart::Text { text: text.into() }] }
}

#[tokio::test]
async fn retry_success_clears_a_transient_error_but_exhaustion_fails_the_turn() {
    let mut recovered = Harness::new(Flavor::Pi);
    active_turn(&recovered.session).await;
    recovered.session.state.lock().await.turn_error = Some("first attempt failed".into());
    recovered.session.handle_frame(json!({ "type": "auto_retry_start", "errorMessage": "retrying" })).await;
    recovered.session.handle_frame(json!({ "type": "auto_retry_end", "success": true })).await;
    assert!(matches!(recovered.settle().await, DriverEvent::TurnCompleted { stop_reason: StopReason::Completed, .. }));

    let mut exhausted = Harness::new(Flavor::Pi);
    active_turn(&exhausted.session).await;
    exhausted.session.handle_frame(json!({ "type": "auto_retry_end", "success": false, "finalError": "quota remained exhausted" })).await;
    assert!(matches!(exhausted.settle().await, DriverEvent::TurnFailed { error, .. } if error == "quota remained exhausted"));
}

#[tokio::test]
async fn late_compaction_invalidates_the_first_idle_probe_after_agent_settled() {
    let mut harness = Harness::new(Flavor::Pi);
    active_turn(&harness.session).await;
    harness.session.handle_frame(json!({ "type": "agent_settled" })).await;

    let first_probe = harness.wire("get_state").await;
    harness.session.handle_frame(json!({ "type": "compaction_start", "reason": "threshold" })).await;
    harness.reply(&first_probe, json!({ "isStreaming": false, "isCompacting": false, "pendingMessageCount": 0 })).await;
    assert!(!matches!(harness.events.try_recv(), Ok(DriverEvent::TurnCompleted { .. } | DriverEvent::TurnFailed { .. })));
    harness.session.handle_frame(json!({ "type": "compaction_end" })).await;

    let second_probe = harness.wire("get_state").await;
    harness.reply(&second_probe, json!({ "isStreaming": false, "isCompacting": false, "pendingMessageCount": 0 })).await;
    let messages = harness.wire("get_fork_messages").await;
    harness.reply(&messages, json!({ "messages": [] })).await;
    assert!(matches!(harness.next_completion().await, DriverEvent::TurnCompleted { .. }));
    let stats = harness.wire("get_session_stats").await;
    harness.reply(&stats, json!({})).await;
}

#[tokio::test]
async fn compaction_start_after_idle_probe_still_blocks_terminalization() {
    let mut harness = Harness::new(Flavor::Pi);
    active_turn(&harness.session).await;
    harness.session.handle_frame(json!({ "type": "agent_settled" })).await;

    let idle = harness.wire("get_state").await;
    harness.reply(&idle, json!({ "isStreaming": false, "isCompacting": false, "pendingMessageCount": 0 })).await;
    let stale_anchor = harness.wire("get_fork_messages").await;
    harness.session.handle_frame(json!({ "type": "compaction_start", "reason": "threshold" })).await;
    harness.reply(&stale_anchor, json!({ "messages": [] })).await;
    harness.session.handle_frame(json!({ "type": "compaction_end" })).await;

    let fresh_idle = harness.wire("get_state").await;
    harness.reply(&fresh_idle, json!({ "isStreaming": false, "isCompacting": false, "pendingMessageCount": 0 })).await;
    let fresh_anchor = harness.wire("get_fork_messages").await;
    harness.reply(&fresh_anchor, json!({ "messages": [] })).await;
    assert!(matches!(harness.next_completion().await, DriverEvent::TurnCompleted { .. }));
    let stats = harness.wire("get_session_stats").await;
    harness.reply(&stats, json!({})).await;
}

#[tokio::test]
async fn retry_backoff_after_agent_settled_invalidates_an_idle_probe() {
    let mut harness = Harness::new(Flavor::Pi);
    active_turn(&harness.session).await;
    harness.session.handle_frame(json!({ "type": "agent_settled" })).await;

    let stale_idle = harness.wire("get_state").await;
    harness.session.handle_frame(json!({ "type": "auto_retry_start", "errorMessage": "transient" })).await;
    harness.reply(&stale_idle, json!({ "isStreaming": false, "isCompacting": false, "pendingMessageCount": 0 })).await;
    harness.session.handle_frame(json!({ "type": "auto_retry_end", "success": true })).await;

    let fresh_idle = harness.wire("get_state").await;
    harness.reply(&fresh_idle, json!({ "isStreaming": false, "isCompacting": false, "pendingMessageCount": 0 })).await;
    let messages = harness.wire("get_fork_messages").await;
    harness.reply(&messages, json!({ "messages": [] })).await;
    assert!(matches!(harness.next_completion().await, DriverEvent::TurnCompleted { .. }));
    let stats = harness.wire("get_session_stats").await;
    harness.reply(&stats, json!({})).await;
}

#[tokio::test]
async fn runless_prompt_waits_for_dialog_and_idle_ack_before_completing() {
    let mut harness = Harness::new(Flavor::Pi);
    let handle = harness.handle.clone();
    let sending = tokio::spawn(async move { handle.send_message("m1", &text_message("configure extension")).await });
    let prompt = harness.wire("prompt").await;

    harness
        .session
        .handle_frame(json!({ "type": "extension_ui_request", "id": "startup", "method": "confirm", "title": "Configure extension?" }))
        .await;
    assert!(matches!(harness.next_event().await, DriverEvent::PermissionRequest { request_id, .. } if request_id == "startup"));
    harness.handle.respond_permission("startup", &ApprovalDecision::Submit { response: json!({ "confirmed": false }) }).await.unwrap();
    let dialog = harness.wire("extension_ui_response").await;
    assert_eq!(dialog["confirmed"], false);

    harness.reply(&prompt, Value::Null).await;
    let acknowledgement = harness.wire("get_state").await;
    harness.reply(&acknowledgement, json!({ "isStreaming": false, "isCompacting": false })).await;
    tokio::time::timeout(DEADLINE, sending).await.expect("send hung").unwrap().unwrap();

    let finishing_probe = harness.wire("get_state").await;
    harness.reply(&finishing_probe, json!({ "isStreaming": false, "isCompacting": false, "pendingMessageCount": 0 })).await;
    let messages = harness.wire("get_fork_messages").await;
    harness.reply(&messages, json!({ "messages": [] })).await;
    assert!(matches!(harness.next_completion().await, DriverEvent::TurnCompleted { .. }));
    let stats = harness.wire("get_session_stats").await;
    harness.reply(&stats, json!({})).await;
}

#[tokio::test]
async fn stop_during_prompt_preflight_clears_queue_and_reaborts_a_late_run() {
    let mut harness = Harness::new(Flavor::Pi);
    let handle = harness.handle.clone();
    let sending = tokio::spawn(async move { handle.send_message("m1", &text_message("start later")).await });
    let prompt = harness.wire("prompt").await;

    harness.handle.interrupt().await.unwrap();
    for expected in ["clear_queue", "abort_retry", "abort"] {
        harness.wire(expected).await;
    }
    harness.session.handle_frame(json!({ "type": "agent_start" })).await;
    for expected in ["clear_queue", "abort_retry", "abort"] {
        harness.wire(expected).await;
    }
    harness.reply(&prompt, Value::Null).await;
    tokio::time::timeout(DEADLINE, sending).await.expect("send hung").unwrap().unwrap();

    harness.session.handle_frame(json!({ "type": "agent_settled" })).await;
    assert!(matches!(harness.settle().await, DriverEvent::TurnCompleted { stop_reason: StopReason::Interrupted, .. }));
}

#[tokio::test]
async fn stopped_prompt_rejection_settles_as_interrupted_instead_of_delivery_failure() {
    let mut harness = Harness::new(Flavor::Pi);
    let handle = harness.handle.clone();
    let sending = tokio::spawn(async move { handle.send_message("m1", &text_message("stop during preflight")).await });
    let prompt = harness.wire("prompt").await;

    harness.handle.interrupt().await.unwrap();
    for expected in ["clear_queue", "abort_retry", "abort"] {
        harness.wire(expected).await;
    }
    harness.reject(&prompt, "aborted").await;
    tokio::time::timeout(DEADLINE, sending).await.expect("send hung after abort rejection").unwrap().unwrap();

    assert!(matches!(harness.settle().await, DriverEvent::TurnCompleted { stop_reason: StopReason::Interrupted, .. }));
}

#[tokio::test]
async fn stop_during_initialization_cancels_a_waiting_prompt_admission() {
    let (mut harness, initialized) = Harness::uninitialized(Flavor::Pi);
    let handle = harness.handle.clone();
    let sending = tokio::spawn(async move { handle.send_message("m1", &text_message("must not start")).await });
    tokio::task::yield_now().await;

    harness.handle.interrupt().await.unwrap();
    for expected in ["clear_queue", "abort_retry", "abort"] {
        harness.wire(expected).await;
    }
    initialized.send(Some(Ok(()))).unwrap();

    tokio::time::timeout(DEADLINE, sending).await.expect("send stayed blocked after initialization").unwrap().unwrap();
    assert!(matches!(harness.next_completion().await, DriverEvent::TurnCompleted { stop_reason: StopReason::Interrupted, .. }));
    assert!(harness.session.child.lines.lock().await.try_recv().is_err());
}

#[tokio::test]
async fn stop_during_initialization_cancels_a_waiting_compaction_admission() {
    let (mut harness, initialized) = Harness::uninitialized(Flavor::Pi);
    let handle = harness.handle.clone();
    let compacting = tokio::spawn(async move { handle.compact().await });
    tokio::task::yield_now().await;

    harness.handle.interrupt().await.unwrap();
    for expected in ["clear_queue", "abort_retry", "abort"] {
        harness.wire(expected).await;
    }
    initialized.send(Some(Ok(()))).unwrap();

    tokio::time::timeout(DEADLINE, compacting).await.expect("compact stayed blocked after initialization").unwrap().unwrap();
    assert!(matches!(harness.next_completion().await, DriverEvent::TurnCompleted { stop_reason: StopReason::Interrupted, .. }));
    assert!(harness.session.child.lines.lock().await.try_recv().is_err());
}

#[tokio::test]
async fn rejected_compaction_returns_one_delivery_error_without_native_completion() {
    let mut harness = Harness::new(Flavor::Pi);
    let handle = harness.handle.clone();
    let compacting = tokio::spawn(async move { handle.compact().await });
    let request = harness.wire("compact").await;
    harness.reject(&request, "context is too small to compact").await;

    let error = tokio::time::timeout(DEADLINE, compacting).await.expect("compact stayed pending after rejection").unwrap().unwrap_err();
    assert!(error.to_string().contains("context is too small to compact"));
    assert!(matches!(harness.next_event().await, DriverEvent::Notice { .. }));
    tokio::task::yield_now().await;
    assert!(!matches!(harness.events.try_recv(), Ok(DriverEvent::TurnCompleted { .. } | DriverEvent::TurnFailed { .. })));
    let state = harness.session.state.lock().await;
    assert!(!state.active);
    assert!(!state.settling);
}

#[tokio::test]
async fn stop_cancels_an_admission_waiting_for_the_command_gate() {
    let mut harness = Harness::new(Flavor::Pi);
    let gate = harness.session.command_gate.lock().await;
    let handle = harness.handle.clone();
    let sending = tokio::spawn(async move { handle.send_message("m1", &text_message("must not start")).await });
    tokio::task::yield_now().await;

    harness.handle.interrupt().await.unwrap();
    for expected in ["clear_queue", "abort_retry", "abort"] {
        harness.wire(expected).await;
    }
    drop(gate);

    tokio::time::timeout(DEADLINE, sending).await.expect("send stayed blocked on gate").unwrap().unwrap();
    assert!(matches!(harness.next_completion().await, DriverEvent::TurnCompleted { stop_reason: StopReason::Interrupted, .. }));
    assert!(harness.session.child.lines.lock().await.try_recv().is_err());
}

#[tokio::test]
async fn a_new_prompt_after_a_cancelled_admission_is_still_allowed() {
    let (mut harness, initialized) = Harness::uninitialized(Flavor::Pi);
    let handle = harness.handle.clone();
    let cancelled = tokio::spawn(async move { handle.send_message("m1", &text_message("cancelled")).await });
    tokio::task::yield_now().await;
    harness.handle.interrupt().await.unwrap();
    for expected in ["clear_queue", "abort_retry", "abort"] {
        harness.wire(expected).await;
    }
    initialized.send(Some(Ok(()))).unwrap();
    tokio::time::timeout(DEADLINE, cancelled).await.unwrap().unwrap().unwrap();
    assert!(matches!(harness.next_completion().await, DriverEvent::TurnCompleted { stop_reason: StopReason::Interrupted, .. }));

    let handle = harness.handle.clone();
    let next = tokio::spawn(async move { handle.send_message("m2", &text_message("allowed")).await });
    let prompt = harness.wire("prompt").await;
    harness.session.handle_frame(json!({ "type": "agent_start" })).await;
    harness.reply(&prompt, Value::Null).await;
    tokio::time::timeout(DEADLINE, next).await.unwrap().unwrap().unwrap();
}

#[tokio::test]
async fn cumulative_tool_output_emits_only_extensions_and_keeps_final_output_authoritative() {
    let mut harness = Harness::new(Flavor::Pi);
    harness.session.handle_frame(json!({ "type": "tool_execution_start", "toolCallId": "tool-1", "toolName": "bash", "args": {} })).await;
    for text in ["abc", "abc", "abcdef", "rewritten"] {
        harness
            .session
            .handle_frame(json!({
                "type": "tool_execution_update",
                "toolCallId": "tool-1",
                "partialResult": { "content": [{ "type": "text", "text": text }] }
            }))
            .await;
    }
    harness
        .session
        .handle_frame(json!({
            "type": "tool_execution_end",
            "toolCallId": "tool-1",
            "result": { "content": [{ "type": "text", "text": "final authoritative output" }], "details": { "exitCode": 0 } }
        }))
        .await;

    assert!(matches!(harness.next_event().await, DriverEvent::ToolStarted(_)));
    assert!(matches!(harness.next_event().await, DriverEvent::ToolOutputDelta { delta, .. } if delta == "abc"));
    assert!(matches!(harness.next_event().await, DriverEvent::ToolOutputDelta { delta, .. } if delta == "def"));
    assert!(matches!(harness.next_event().await, DriverEvent::ToolCompleted { output, .. }
        if output.pointer("/content/0/text").and_then(Value::as_str) == Some("final authoritative output")));
    assert!(harness.events.try_recv().is_err());
}

#[tokio::test]
async fn thinking_validation_uses_the_selected_models_actual_levels() {
    let harness = Harness::new(Flavor::Pi);
    {
        let mut state = harness.session.state.lock().await;
        state.model = json!({
            "provider": "custom",
            "id": "reasoner",
            "reasoning": true,
            "thinkingLevelMap": { "medium": null, "xhigh": "extra_high" }
        });
        state.default_effort = Some("medium".into());
    }
    let rejected = harness.handle.set_effort("medium").await.unwrap_err();
    assert!(matches!(rejected, DriverError::Unsupported(_)));

    let handle = harness.handle.clone();
    let resetting = tokio::spawn(async move { handle.set_effort("").await });
    let request = harness.wire("set_thinking_level").await;
    assert_eq!(request["level"], "high");
    harness.reply(&request, Value::Null).await;
    tokio::time::timeout(DEADLINE, resetting).await.unwrap().unwrap().unwrap();

    harness.session.state.lock().await.model = json!({ "reasoning": false });
    assert!(matches!(harness.handle.set_effort("high").await.unwrap_err(), DriverError::Unsupported(_)));
}

#[tokio::test]
async fn rejected_prompt_and_steer_leave_the_active_turn_unchanged() {
    let harness = Harness::new(Flavor::Pi);
    active_turn(&harness.session).await;
    let generation = harness.session.state.lock().await.generation;

    assert!(matches!(harness.handle.send_message("m2", &text_message("second prompt")).await.unwrap_err(), DriverError::Protocol(_)));
    harness.session.state.lock().await.settling = true;
    assert!(matches!(harness.handle.steer("m3", &text_message("late steer")).await.unwrap_err(), DriverError::Unsupported(_)));

    let state = harness.session.state.lock().await;
    assert!(state.active);
    assert_eq!(state.generation, generation);
    assert!(!state.aborted);
    assert!(harness.session.child.lines.lock().await.try_recv().is_err());
}

#[tokio::test]
async fn stale_stats_cannot_overwrite_the_next_turn() {
    let mut harness = Harness::new(Flavor::Pi);
    active_turn(&harness.session).await;
    harness.session.schedule_finish().await;
    let state = harness.wire("get_state").await;
    harness.reply(&state, json!({ "isStreaming": false, "isCompacting": false, "pendingMessageCount": 0 })).await;
    let messages = harness.wire("get_fork_messages").await;
    harness.reply(&messages, json!({ "messages": [] })).await;
    assert!(matches!(harness.next_completion().await, DriverEvent::TurnCompleted { .. }));
    let stats = harness.wire("get_session_stats").await;

    // Force the stats publisher to await channel capacity after it has read
    // generation one. It must recheck before publishing into generation two.
    for index in 0..64 {
        harness.session.emit(DriverEvent::Notice { level: NoticeLevel::Info, text: format!("filler {index}"), data: None }).await;
    }
    harness.reply(&stats, json!({ "contextUsage": { "tokens": 999, "contextWindow": 1000 } })).await;
    tokio::task::yield_now().await;
    let admitted_at = harness.session.admission_revision().await;
    harness.session.begin_turn(false, admitted_at).await.unwrap().unwrap();
    for _ in 0..64 {
        assert!(matches!(harness.next_event().await, DriverEvent::Notice { .. }));
    }
    tokio::task::yield_now().await;
    assert!(harness.events.try_recv().is_err());
    assert_eq!(harness.session.state.lock().await.generation, 2);
}

#[tokio::test]
async fn omp_handoff_emits_one_compaction_notice_only_on_success() {
    for (aborted, failed, already_noticed, expected) in
        [(false, false, false, 1), (false, false, true, 0), (true, false, false, 0), (false, true, false, 0)]
    {
        let mut harness = Harness::new(Flavor::Omp);
        {
            let mut state = harness.session.state.lock().await;
            state.active = true;
            state.native_command = Some("handoff".into());
            state.aborted = aborted;
            state.turn_error = failed.then(|| "handoff failed".into());
            state.compaction_noticed = already_noticed;
        }
        harness.session.handle_frame(json!({ "type": "agent_end", "isTerminal": true })).await;
        let messages = harness.wire("get_branch_messages").await;
        harness.reply(&messages, json!({ "messages": [] })).await;
        let mut notices = 0;
        loop {
            match harness.next_event().await {
                DriverEvent::Notice { text, .. } if text == "Context compacted" => notices += 1,
                DriverEvent::TurnCompleted { .. } | DriverEvent::TurnFailed { .. } => break,
                _ => {}
            }
        }
        assert_eq!(notices, expected);
        let stats = harness.wire("get_session_stats").await;
        harness.reply(&stats, json!({})).await;
    }
}

/// Steers the turn with `message`, the way the orchestrator does, and lets Pi accept it.
async fn steer_with(harness: &Harness, message: UserMessage) {
    let handle = harness.handle.clone();
    let steering = tokio::spawn(async move { handle.steer("s", &message).await });
    let prompt = harness.wire("prompt").await;
    assert_eq!(prompt["streamingBehavior"], "steer");
    harness.reply(&prompt, json!({ "disposition": "queued" })).await;
    tokio::time::timeout(DEADLINE, steering).await.expect("steer hung").unwrap().unwrap();
}

#[tokio::test]
async fn the_notice_for_unread_steers_quotes_what_the_user_sent() {
    let mut harness = Harness::new(Flavor::Pi);
    active_turn(&harness.session).await;
    steer_with(&harness, text_message("already read")).await;
    steer_with(&harness, text_message("use tabs\nnot spaces")).await;
    // A skill: Pi's copy of this one holds the whole skill file; the user's holds the command.
    steer_with(
        &harness,
        UserMessage {
            parts: vec![
                ContentPart::Skill { name: "review".into(), path: "/home/me/.pi/skills/review/SKILL.md".into() },
                ContentPart::Text { text: "the diff".into() },
            ],
        },
    )
    .await;
    steer_with(&harness, UserMessage { parts: vec![ContentPart::Image { media_type: "image/png".into(), data: "AAAA".into() }] }).await;

    harness.handle.interrupt().await.unwrap();
    let clear = harness.wire("clear_queue").await;
    harness.wire("abort_retry").await;
    harness.wire("abort").await;
    // Pi had read the first steer; its answer holds the expanded text of the other three.
    let expanded = "<skill name=\"review\" location=\"/home/me/.pi/skills/review/SKILL.md\">\n".to_string() + &"x".repeat(5000);
    harness.reply(&clear, json!({ "steering": ["use tabs\nnot spaces", expanded, ""], "followUp": [] })).await;

    let DriverEvent::Notice { level, text, data } = harness.next_event().await else { panic!("expected a notice") };
    assert_eq!(level, NoticeLevel::Warning);
    assert!(text.starts_with("Pi had not read 3 queued messages when the turn was interrupted."), "{text}");
    assert!(!text.contains("Stop cleared"), "an interrupt Kybern started is not the user's Stop: {text}");
    assert!(text.contains("> use tabs\n> not spaces"), "{text}");
    assert!(text.contains("> the diff"), "{text}");
    assert!(text.contains("> [image]"), "an image-only steer is counted and shown: {text}");
    assert!(!text.contains("already read"), "{text}");
    assert!(!text.contains("<skill") && !text.contains("/home/me"), "Pi's expansion leaked: {text}");
    assert!(text.len() < 400, "{}", text.len());
    assert_eq!(data.unwrap()["clearedQueue"], json!(["use tabs\nnot spaces", "the diff", "[image]"]));
}

#[test]
fn the_notice_is_capped_and_counts_what_it_cannot_quote() {
    let steered: Vec<String> = (0..8).map(|n| format!("steer {n} {}", "y".repeat(4000))).collect();
    let cleared = json!({ "steering": (0..8).map(|n| format!("steer {n}")).collect::<Vec<_>>() });
    let DriverEvent::Notice { text, data, .. } = cleared_queue_notice(&cleared, &steered).unwrap() else { panic!("expected a notice") };
    assert!(text.contains("not read 8 queued messages"), "{text}");
    assert_eq!(text.matches("\n> ").count(), MAX_CLEARED_MESSAGES, "{text}");
    assert!(text.ends_with("…and 3 more"), "{text}");
    assert_eq!(data.unwrap()["clearedQueue"].as_array().unwrap().len(), MAX_CLEARED_MESSAGES);
    assert!(cleared_queue_notice(&json!({ "steering": [], "followUp": [] }), &steered).is_none());
    // Steers from before the driver started keeping its own copy are counted, not invented.
    let DriverEvent::Notice { text, .. } = cleared_queue_notice(&json!({ "steering": ["a", "b"] }), &[]).unwrap() else {
        panic!("expected a notice")
    };
    assert!(text.contains("not read 2 queued messages") && text.ends_with("…and 2 more"), "{text}");
}

#[tokio::test]
async fn nothing_queued_or_an_old_pi_stays_quiet() {
    for answer in [Ok(json!({ "steering": [], "followUp": [] })), Err("Unknown command: clear_queue")] {
        let mut harness = Harness::new(Flavor::Pi);
        active_turn(&harness.session).await;
        harness.handle.interrupt().await.unwrap();
        let clear = harness.wire("clear_queue").await;
        match answer {
            Ok(data) => harness.reply(&clear, data).await,
            Err(error) => harness.reject(&clear, error).await,
        }
        // The answer is collected from `pending` whether or not it says anything. Wait for
        // that, then for the notice task to have finished with it.
        wait_until(|| async { harness.session.pending.lock().await.is_empty() }).await;
        harness.wire("abort_retry").await;
        harness.wire("abort").await;
        // Completing the turn queues its event behind any notice the answer produced.
        harness.session.schedule_finish().await;
        let idle = harness.wire("get_state").await;
        harness.reply(&idle, json!({ "isStreaming": false, "isCompacting": false, "pendingMessageCount": 0 })).await;
        let listing = harness.wire("get_fork_messages").await;
        harness.reply(&listing, json!({ "messages": [] })).await;
        assert!(matches!(harness.next_event().await, DriverEvent::TurnCompleted { .. }), "an answer with nothing to report said something");
    }
}

/// Polls `condition` until it holds, giving up after [`DEADLINE`].
async fn wait_until<F, Fut>(mut condition: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    tokio::time::timeout(DEADLINE, async {
        while !condition().await {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("condition never held");
}

#[test]
fn a_turn_starts_at_the_first_user_entry_after_the_previous_turn() {
    let entries = |ids: &[&str]| ids.iter().map(|id| id.to_string()).collect::<Vec<_>>();
    let all = entries(&["u1", "u2", "u3"]);
    // u2 is the prompt, u3 a steer: the turn is still u2.
    assert_eq!(turn_anchor(&all, Some(&Some("u1".into()))).as_deref(), Some("u2"));
    assert_eq!(turn_anchor(&all, Some(&None)).as_deref(), Some("u1"));
    // Nothing new since the baseline: this turn added no user entry.
    assert_eq!(turn_anchor(&all, Some(&Some("u3".into()))), None);
    // No baseline, or one that is gone: the newest entry is the best guess.
    assert_eq!(turn_anchor(&all, None).as_deref(), Some("u3"));
    assert_eq!(turn_anchor(&all, Some(&Some("gone".into()))).as_deref(), Some("u3"));
    assert_eq!(turn_anchor(&[], Some(&None)), None);
}

#[tokio::test]
async fn rewinding_a_turn_that_had_a_steer_drops_from_its_first_prompt() {
    let mut harness = Harness::new(Flavor::Pi);
    harness.session.state.lock().await.user_entry_baseline = Some(Some("u1".into()));
    active_turn(&harness.session).await;
    harness.session.schedule_finish().await;
    let idle = harness.wire("get_state").await;
    harness.reply(&idle, json!({ "isStreaming": false, "isCompacting": false, "pendingMessageCount": 0 })).await;
    let listing = harness.wire("get_fork_messages").await;
    // u2 started the turn; the user steered it with u3.
    harness
        .reply(&listing, json!({ "messages": [{ "entryId": "u1", "text": "old" }, { "entryId": "u2", "text": "prompt" }, { "entryId": "u3", "text": "steer" }] }))
        .await;
    let DriverEvent::TurnCompleted { anchors, .. } = harness.next_completion().await else { panic!("turn did not complete") };
    assert_eq!(anchors.turn_id.as_deref(), Some("u2"));
    let stats = harness.wire("get_session_stats").await;
    harness.reply(&stats, json!({})).await;

    // The next turn starts after the steer.
    assert_eq!(harness.session.state.lock().await.user_entry_baseline, Some(Some("u3".into())));
    active_turn_again(&harness.session).await;
    harness.session.schedule_finish().await;
    let idle = harness.wire("get_state").await;
    harness.reply(&idle, json!({ "isStreaming": false, "isCompacting": false, "pendingMessageCount": 0 })).await;
    let listing = harness.wire("get_fork_messages").await;
    harness
        .reply(&listing, json!({ "messages": [{ "entryId": "u1" }, { "entryId": "u2" }, { "entryId": "u3" }, { "entryId": "u4" }] }))
        .await;
    let DriverEvent::TurnCompleted { anchors, .. } = harness.next_completion().await else { panic!("turn did not complete") };
    assert_eq!(anchors.turn_id.as_deref(), Some("u4"));
}

async fn active_turn_again(session: &PiSession) {
    // The previous turn's stats may still be in flight; start the next like a send would.
    tokio::task::yield_now().await;
    active_turn(session).await;
}

#[tokio::test]
async fn a_session_an_extension_switched_to_becomes_the_threads_session() {
    let mut harness = Harness::new(Flavor::Pi);
    harness.session.state.lock().await.session_id = Some("original".into());
    active_turn(&harness.session).await;
    harness.session.schedule_finish().await;
    let idle = harness.wire("get_state").await;
    harness
        .reply(
            &idle,
            json!({ "isStreaming": false, "isCompacting": false, "pendingMessageCount": 0, "sessionId": "switched", "sessionFile": "/sessions/switched.jsonl" }),
        )
        .await;
    // The daemon is told which session the thread left, to keep it out of imports and rewinds.
    let DriverEvent::Notice { data, .. } = harness.next_event().await else { panic!("the switch was not announced") };
    assert_eq!(data.unwrap()[SESSION_SWITCH_KEY], json!({ "from": "original", "to": "switched" }));
    assert!(matches!(harness.next_event().await, DriverEvent::SessionBound { session_id, .. } if session_id == "switched"));
    assert_eq!(harness.session.state.lock().await.session_id.as_deref(), Some("switched"));

    // The same session again is not news.
    let messages = harness.wire("get_fork_messages").await;
    harness.reply(&messages, json!({ "messages": [] })).await;
    assert!(matches!(harness.next_completion().await, DriverEvent::TurnCompleted { .. }));
    let stats = harness.wire("get_session_stats").await;
    harness.reply(&stats, json!({})).await;
}

#[tokio::test]
async fn tools_called_through_another_tool_nest_under_their_caller() {
    let mut harness = Harness::new(Flavor::Pi);
    harness
        .session
        .handle_frame(json!({ "type": "tool_execution_start", "toolCallId": "outer", "toolName": "codemode", "args": {} }))
        .await;
    harness
        .session
        .handle_frame(
            json!({ "type": "tool_execution_start", "toolCallId": "inner", "toolName": "read", "args": {}, "parentToolCallId": "outer" }),
        )
        .await;
    assert!(matches!(harness.next_event().await, DriverEvent::ToolStarted(call) if call.id == "outer" && call.parent_id.is_none()));
    assert!(
        matches!(harness.next_event().await, DriverEvent::ToolStarted(call) if call.id == "inner" && call.parent_id.as_deref() == Some("outer"))
    );
}

/// A send that is waiting for compaction has said so.
async fn wait_for_hold(session: &PiSession, hold: PromptHold) {
    wait_until(|| async { session.state.lock().await.prompt_hold == hold }).await;
}

#[tokio::test]
async fn a_prompt_waits_for_compaction_that_started_after_the_last_turn() {
    let harness = Harness::new(Flavor::Pi);
    harness.session.handle_frame(json!({ "type": "compaction_start", "reason": "threshold" })).await;
    let handle = harness.handle.clone();
    let sending = tokio::spawn(async move { handle.send_message("m1", &text_message("hello")).await });
    wait_for_hold(&harness.session, PromptHold::Waiting).await;
    assert!(harness.session.child.lines.lock().await.try_recv().is_err(), "the prompt was sent while Pi compacted");
    assert!(!sending.is_finished());

    harness.session.handle_frame(json!({ "type": "compaction_end" })).await;
    let prompt = harness.wire("prompt").await;
    assert_eq!(prompt["message"], "hello");
    harness.session.handle_frame(json!({ "type": "agent_start" })).await;
    harness.reply(&prompt, Value::Null).await;
    tokio::time::timeout(DEADLINE, sending).await.expect("send hung").unwrap().unwrap();
}

#[tokio::test]
async fn a_prompt_rejected_by_compaction_is_sent_again_when_it_ends() {
    let harness = Harness::new(Flavor::Pi);
    let handle = harness.handle.clone();
    let sending = tokio::spawn(async move { handle.send_message("m1", &text_message("hello")).await });
    let first = harness.wire("prompt").await;
    // Compaction began just before Pi read the prompt.
    harness.session.handle_frame(json!({ "type": "compaction_start", "reason": "threshold" })).await;
    harness.reject(&first, "Cannot submit a prompt while compaction is in progress. Wait for it to finish.").await;
    wait_for_hold(&harness.session, PromptHold::HoldingGate).await;
    assert!(harness.session.child.lines.lock().await.try_recv().is_err());

    harness.session.handle_frame(json!({ "type": "compaction_end" })).await;
    let second = harness.wire("prompt").await;
    assert_eq!(second["message"], "hello");
    harness.session.handle_frame(json!({ "type": "agent_start" })).await;
    harness.reply(&second, Value::Null).await;
    tokio::time::timeout(DEADLINE, sending).await.expect("send hung").unwrap().unwrap();
}

#[tokio::test]
async fn compaction_that_begins_between_the_wait_and_the_prompt_is_not_forgotten() {
    // The compaction_start lands after the wait found Pi idle and before the turn begins.
    // begin_turn used to reset the flag, so the wait after Pi's rejection ended at once and
    // the prompt failed.
    let harness = Harness::new(Flavor::Pi);
    let admitted_at = harness.session.admission_revision().await;
    harness.session.handle_frame(json!({ "type": "compaction_start", "reason": "threshold" })).await;
    harness.session.begin_turn(false, admitted_at).await.unwrap().unwrap();
    assert!(harness.session.state.lock().await.compacting, "the compaction that began is gone");

    let deadline = tokio::time::Instant::now() + DEADLINE;
    assert!(harness.session.compaction_blocks(admitted_at, deadline).await);
    let session = harness.session.clone();
    let waiting = tokio::spawn(async move { session.wait_for_compaction_end(admitted_at, deadline).await });
    harness.session.handle_frame(json!({ "type": "compaction_end" })).await;
    tokio::time::timeout(DEADLINE, waiting).await.expect("wait hung").unwrap();
    assert!(!harness.session.compaction_blocks(admitted_at, deadline).await);
}

#[tokio::test]
async fn a_lost_compaction_end_is_given_up_on_once_and_for_the_whole_send() {
    let harness = Harness::new(Flavor::Pi);
    harness.session.handle_frame(json!({ "type": "compaction_start", "reason": "threshold" })).await;
    let admitted_at = harness.session.admission_revision().await;
    // A deadline that has passed: the wait does not start another one of its own.
    let passed = tokio::time::Instant::now();
    tokio::time::timeout(DEADLINE, harness.session.wait_for_compaction_end(admitted_at, passed)).await.expect("waited past the deadline");
    assert!(!harness.session.state.lock().await.compacting, "the lost end is dropped so the prompt goes out");
    assert!(!harness.session.compaction_blocks(admitted_at, passed).await);
}

#[tokio::test]
async fn stop_alone_ends_the_wait_for_compaction_without_sending_the_prompt() {
    let mut harness = Harness::new(Flavor::Pi);
    harness.session.handle_frame(json!({ "type": "compaction_start", "reason": "threshold" })).await;
    let handle = harness.handle.clone();
    let sending = tokio::spawn(async move { handle.send_message("m1", &text_message("never sent")).await });
    wait_for_hold(&harness.session, PromptHold::Waiting).await;

    // Pi's compaction goes on (an extension may delay it); no compaction_end is sent.
    harness.handle.interrupt().await.unwrap();
    for expected in ["clear_queue", "abort_retry", "abort"] {
        harness.wire(expected).await;
    }
    tokio::time::timeout(DEADLINE, sending).await.expect("send stayed blocked").unwrap().unwrap();
    assert!(harness.session.state.lock().await.compacting, "the test must not have ended the compaction");
    assert!(matches!(harness.next_completion().await, DriverEvent::TurnCompleted { stop_reason: StopReason::Interrupted, .. }));
    assert!(harness.session.child.lines.lock().await.try_recv().is_err());
}

#[tokio::test]
async fn closing_the_session_ends_the_wait_for_compaction() {
    let harness = Harness::new(Flavor::Pi);
    harness.session.handle_frame(json!({ "type": "compaction_start", "reason": "threshold" })).await;
    let handle = harness.handle.clone();
    let sending = tokio::spawn(async move { handle.send_message("m1", &text_message("never sent")).await });
    wait_for_hold(&harness.session, PromptHold::Waiting).await;
    harness.handle.close().await.unwrap();
    // The held prompt ends (with whatever answer a closed session gives) instead of waiting 10 minutes.
    let _ = tokio::time::timeout(DEADLINE, sending).await.expect("send stayed blocked after close");
}

#[tokio::test]
async fn a_steer_and_stop_are_not_blocked_by_a_prompt_waiting_for_compaction() {
    let mut harness = Harness::new(Flavor::Pi);
    harness.session.handle_frame(json!({ "type": "compaction_start", "reason": "threshold" })).await;
    let handle = harness.handle.clone();
    let sending = tokio::spawn(async move { handle.send_message("m1", &text_message("held")).await });
    wait_for_hold(&harness.session, PromptHold::Waiting).await;

    // The orchestrator awaits the steer while holding the lock Stop needs first.
    let steer = tokio::time::timeout(DEADLINE, harness.handle.steer("s1", &text_message("also this")))
        .await
        .expect("steer queued behind the held prompt");
    assert!(steer.is_err(), "a steer has no running turn to join");
    // Commands that are not about the prompt are not held up either: Pi decides.
    let handle = harness.handle.clone();
    let model = tokio::spawn(async move { handle.set_model("google/gemini-3.5-flash").await });
    let available = harness.wire("get_available_models").await;
    harness.reply(&available, json!({ "models": [] })).await;
    let set = harness.wire("set_model").await;
    harness.reply(&set, json!({})).await;
    let state = harness.wire("get_state").await;
    harness.reply(&state, json!({})).await;
    tokio::time::timeout(DEADLINE, model).await.expect("set_model queued behind the held prompt").unwrap().unwrap();

    tokio::time::timeout(DEADLINE, harness.handle.interrupt()).await.expect("stop hung").unwrap();
    for expected in ["clear_queue", "abort_retry", "abort"] {
        harness.wire(expected).await;
    }
    tokio::time::timeout(DEADLINE, sending).await.expect("send stayed blocked").unwrap().unwrap();
    assert!(matches!(harness.next_completion().await, DriverEvent::TurnCompleted { stop_reason: StopReason::Interrupted, .. }));
}

#[tokio::test]
async fn nothing_waits_behind_a_prompt_that_holds_the_gate_for_compaction() {
    let mut harness = Harness::new(Flavor::Pi);
    let handle = harness.handle.clone();
    let sending = tokio::spawn(async move { handle.send_message("m1", &text_message("hello")).await });
    let first = harness.wire("prompt").await;
    harness.session.handle_frame(json!({ "type": "compaction_start", "reason": "threshold" })).await;
    harness.reject(&first, "Cannot submit a prompt while compaction is in progress.").await;
    wait_for_hold(&harness.session, PromptHold::HoldingGate).await;

    let refused = |result: Result<()>| match result {
        Err(error) => assert!(error.to_string().contains("compacting"), "{error}"),
        other => panic!("expected an immediate refusal, got {other:?}"),
    };
    let handle = harness.handle.clone();
    refused(tokio::time::timeout(DEADLINE, handle.steer("s1", &text_message("steer"))).await.expect("steer waited for the gate"));
    refused(tokio::time::timeout(DEADLINE, handle.set_model("google/gemini-3.5-flash")).await.expect("set_model waited for the gate"));
    refused(tokio::time::timeout(DEADLINE, handle.set_effort("high")).await.expect("set_effort waited for the gate"));
    refused(tokio::time::timeout(DEADLINE, handle.set_permission_mode(PermissionMode::Auto)).await.expect("set_permission_mode waited"));
    refused(tokio::time::timeout(DEADLINE, handle.compact()).await.expect("compact waited for the gate"));

    // Stop reaches Pi and ends the wait, without compaction ending.
    tokio::time::timeout(DEADLINE, handle.interrupt()).await.expect("stop hung").unwrap();
    for expected in ["clear_queue", "abort_retry", "abort"] {
        harness.wire(expected).await;
    }
    tokio::time::timeout(DEADLINE, sending).await.expect("send stayed blocked").unwrap().unwrap();
    // Pi aborts the compaction too, once Stop reaches it; only then can the stopped turn settle.
    harness.session.handle_frame(json!({ "type": "compaction_end", "aborted": true })).await;
    // The stopped turn settles. Its idle probe is asked again after the compaction frame
    // changed the session's activity; any other request, such as the prompt sent again, fails the test.
    loop {
        let request = tokio::time::timeout(DEADLINE, async { harness.session.child.lines.lock().await.recv().await })
            .await
            .expect("the stopped turn never settled")
            .expect("RPC process closed");
        match request["type"].as_str().unwrap() {
            "get_state" => harness.reply(&request, json!({ "isStreaming": false, "isCompacting": false, "pendingMessageCount": 0 })).await,
            "get_fork_messages" => {
                harness.reply(&request, json!({ "messages": [] })).await;
                break;
            }
            other => panic!("unexpected request after Stop: {request} ({other})"),
        }
    }
    assert!(matches!(harness.next_completion().await, DriverEvent::TurnCompleted { stop_reason: StopReason::Interrupted, .. }));
}

#[tokio::test]
async fn model_selectors_follow_the_split_pi_reports() {
    let harness = Harness::new(Flavor::Pi);
    let handle = harness.handle.clone();
    let hub = "hub=https://hub.example:8318/v1";
    let selecting = tokio::spawn(async move { handle.set_model(&format!("{hub}/claude-haiku-4-5")).await });
    let available = harness.wire("get_available_models").await;
    harness.reply(&available, json!({ "models": [{ "provider": hub, "id": "claude-haiku-4-5" }] })).await;
    let set = harness.wire("set_model").await;
    assert_eq!(set["provider"], hub);
    assert_eq!(set["modelId"], "claude-haiku-4-5");
    harness.reply(&set, json!({})).await;
    let state = harness.wire("get_state").await;
    harness.reply(&state, json!({})).await;
    tokio::time::timeout(DEADLINE, selecting).await.expect("set_model hung").unwrap().unwrap();
}

#[tokio::test]
async fn context_usage_moves_while_pi_streams_an_answer() {
    let mut harness = Harness::new(Flavor::Pi);
    harness.session.state.lock().await.context_window = Some(200_000);
    harness.session.handle_frame(json!({ "type": "message_start", "message": { "role": "assistant" } })).await;
    let update = |tokens: u64| {
        json!({
            "type": "message_update",
            "usage": { "input": tokens - 5, "output": 5, "totalTokens": tokens },
            "assistantMessageEvent": { "type": "text_delta", "delta": "x" }
        })
    };
    for tokens in [1_000, 1_000, 1_200] {
        harness.session.handle_frame(update(tokens)).await;
    }
    let mut used = Vec::new();
    while let Ok(event) = harness.events.try_recv() {
        if let DriverEvent::UsageUpdated(usage) = event {
            let context = usage.context.unwrap();
            assert_eq!(context.window_tokens, 200_000);
            used.push(context.used_tokens);
        }
    }
    assert_eq!(used, [1_000, 1_200], "an unchanged reading is not repeated");
}

#[tokio::test]
async fn rewinding_to_a_turn_of_a_session_the_thread_left_is_refused_before_forking() {
    let harness = Harness::new(Flavor::Pi);
    let config = SessionConfig {
        cwd: std::env::temp_dir(),
        model: None,
        effort: None,
        permission_mode: PermissionMode::Supervised,
        native_tool_bridge: None,
        resume_session_id: Some("current".into()),
        resume_lacks_instructions: false,
        fork: true,
        rewind: Some(RewindPoint {
            drop_from: TurnAnchors { turn_id: Some("entry-of-the-old-session".into()), previous_end: None },
            keep_through: None,
        }),
        binary: None,
        env: HashMap::new(),
        compaction: Default::default(),
    };
    let session = harness.session.clone();
    let (_ready, ready_rx) = oneshot::channel();
    let initializing = tokio::spawn(async move { session.initialize(config, "new".into(), ready_rx).await });
    let listing = harness.wire("get_fork_messages").await;
    harness.reply(&listing, json!({ "messages": [{ "entryId": "u1" }, { "entryId": "u2" }] })).await;
    let error = tokio::time::timeout(DEADLINE, initializing).await.expect("initialize hung").unwrap().unwrap_err();
    assert_eq!(error.to_string(), REWIND_ACROSS_SESSIONS);
    assert!(harness.session.child.lines.lock().await.try_recv().is_err(), "fork was sent for an entry the session does not have");
}

#[tokio::test]
async fn rewinding_to_a_turn_of_this_session_still_forks() {
    let harness = Harness::new(Flavor::Pi);
    let config = SessionConfig {
        cwd: std::env::temp_dir(),
        model: None,
        effort: None,
        permission_mode: PermissionMode::Supervised,
        native_tool_bridge: None,
        resume_session_id: Some("current".into()),
        resume_lacks_instructions: false,
        fork: true,
        rewind: Some(RewindPoint { drop_from: TurnAnchors { turn_id: Some("u2".into()), previous_end: None }, keep_through: None }),
        binary: None,
        env: HashMap::new(),
        compaction: Default::default(),
    };
    let session = harness.session.clone();
    let (_ready, ready_rx) = oneshot::channel();
    let _initializing = tokio::spawn(async move { session.initialize(config, "new".into(), ready_rx).await });
    let listing = harness.wire("get_fork_messages").await;
    harness.reply(&listing, json!({ "messages": [{ "entryId": "u1" }, { "entryId": "u2" }] })).await;
    let fork = harness.wire("fork").await;
    assert_eq!(fork["entryId"], "u2");
}
