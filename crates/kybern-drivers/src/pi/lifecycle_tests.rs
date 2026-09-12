use super::*;
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
        let child = Arc::new(NdjsonChild::spawn(Command::new("cat")).unwrap());
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
            pending_app_tools: Mutex::new(HashMap::new()),
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
    assert!(matches!(exhausted.settle().await, DriverEvent::TurnFailed { error } if error == "quota remained exhausted"));
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
