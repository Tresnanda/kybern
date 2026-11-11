use super::*;
use std::time::Duration;

const DEADLINE: Duration = Duration::from_secs(2);

struct UiHarness {
    session: Arc<PiSession>,
    handle: Arc<Handle>,
    events: mpsc::Receiver<DriverEvent>,
}

impl UiHarness {
    fn new(event_capacity: usize) -> Self {
        Self::with_extension(event_capacity, false)
    }

    fn with_extension(event_capacity: usize, extension: bool) -> Self {
        let child = Arc::new(NdjsonChild::spawn(crate::test_process::echo()).unwrap());
        let (events, receiver) = mpsc::channel(event_capacity);
        let session = Arc::new(PiSession {
            flavor: Flavor::Pi,
            child: child.clone(),
            events,
            pending: Mutex::new(HashMap::new()),
            pending_approvals: Mutex::new(HashMap::new()),
            state: Mutex::new(State { active: true, generation: 1, ..State::default() }),
            ready: Mutex::new(None),
            initialized: tokio::sync::watch::channel(Some(Ok(()))).1,
            command_gate: Mutex::new(()),
            extension: extension.then(|| extension::StagedExtension::new(PermissionMode::FullAccess).unwrap()),
            _compaction_overlay: None,
            pending_app_tools: Mutex::new(HashMap::new()),
            app_tool_names: extension::APP_TOOL_NAMES.iter().map(|name| (*name).to_string()).collect(),
        });
        let handle = Arc::new(Handle(session.clone(), crate::ndjson::SessionLifetime::new(child)));
        Self { session, handle, events: receiver }
    }

    async fn wire(&self) -> Value {
        tokio::time::timeout(DEADLINE, async { self.session.child.lines.lock().await.recv().await })
            .await
            .expect("timed out waiting for dialog response")
            .expect("Pi fixture closed")
    }

    async fn next_event(&mut self) -> DriverEvent {
        tokio::time::timeout(DEADLINE, self.events.recv()).await.expect("timed out waiting for driver event").expect("event stream closed")
    }
}

fn kybern_permission_title() -> String {
    let request = json!({
        "version": 1,
        "requestId": "extension-request",
        "toolCallId": "tool-call",
        "toolName": "bash",
        "input": { "command": "true" },
    });
    format!("{}{}", extension::PERMISSION_TITLE_PREFIX, base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(request.to_string()))
}

#[tokio::test]
async fn dialogs_waiting_for_event_capacity_cannot_register_after_stop() {
    for request in [
        json!({ "type":"extension_ui_request", "id":"normal", "method":"confirm", "title":"Continue?" }),
        json!({ "type":"extension_ui_request", "id":"kybern", "method":"select", "title":kybern_permission_title() }),
    ] {
        let mut harness = UiHarness::new(1);
        harness
            .session
            .events
            .send(DriverEvent::Notice { level: NoticeLevel::Info, text: "fill event channel".into(), data: None })
            .await
            .unwrap();
        let session = harness.session.clone();
        let registration = tokio::spawn(async move { session.handle_ui_request(&request).await });
        tokio::task::yield_now().await;

        harness.session.state.lock().await.aborted = true;
        harness.session.withdraw_requests().await;
        assert!(matches!(harness.next_event().await, DriverEvent::Notice { .. }));
        tokio::time::timeout(DEADLINE, registration).await.expect("registration stayed blocked").unwrap();

        assert!(harness.session.pending_approvals.lock().await.is_empty());
        assert!(harness.events.try_recv().is_err(), "late permission event escaped after stop");
        let wire = harness.wire().await;
        assert_eq!(wire["type"], "extension_ui_response");
        assert_eq!(wire["cancelled"], true);
    }
}

#[tokio::test]
async fn an_old_timeout_cannot_withdraw_a_reused_dialog_id() {
    let mut harness = UiHarness::new(8);
    harness.session.handle_ui_request(&json!({ "id":"reused", "method":"input", "title":"First", "timeout":30 })).await;
    assert!(matches!(harness.next_event().await, DriverEvent::PermissionRequest { .. }));
    harness.handle.respond_permission("reused", &ApprovalDecision::Submit { response: json!({ "value":"first" }) }).await.unwrap();
    assert_eq!(harness.wire().await["value"], "first");

    harness.session.handle_ui_request(&json!({ "id":"reused", "method":"input", "title":"Second" })).await;
    assert!(matches!(harness.next_event().await, DriverEvent::PermissionRequest { .. }));
    tokio::time::sleep(Duration::from_millis(80)).await;

    assert!(harness.session.pending_approvals.lock().await.contains_key("reused"));
    assert!(harness.events.try_recv().is_err(), "old timeout withdrew the replacement dialog");
    harness.handle.respond_permission("reused", &ApprovalDecision::Submit { response: json!({ "value":"second" }) }).await.unwrap();
    assert_eq!(harness.wire().await["value"], "second");
}

#[tokio::test]
async fn permission_response_after_stop_is_rejected_and_withdrawal_owns_cancellation() {
    let mut harness = UiHarness::new(8);
    harness.session.handle_ui_request(&json!({ "id":"stopped", "method":"confirm", "title":"Continue?" })).await;
    assert!(matches!(harness.next_event().await, DriverEvent::PermissionRequest { .. }));
    harness.session.state.lock().await.aborted = true;

    let error = harness
        .handle
        .respond_permission("stopped", &ApprovalDecision::Submit { response: json!({ "confirmed":true }) })
        .await
        .unwrap_err();
    assert!(error.to_string().contains("finished turn"));
    assert!(harness.session.pending_approvals.lock().await.contains_key("stopped"));

    harness.session.withdraw_requests().await;
    let wire = harness.wire().await;
    assert_eq!(wire["id"], "stopped");
    assert_eq!(wire["cancelled"], true);
    assert!(matches!(harness.next_event().await, DriverEvent::PermissionWithdrawn { request_id } if request_id == "stopped"));
}

#[tokio::test]
async fn app_cards_survive_two_minutes_and_only_daemon_answers_or_stop_finish_them() {
    use base64::Engine;
    for name in ["kybern_ask_user", "kybern_request_pick", "kybern_request_secret", "kybern_html_publish", "kybern_note_create"] {
        let mut harness = UiHarness::with_extension(8, true);
        let title = format!(
            "{}{}",
            extension::APP_TOOL_TITLE_PREFIX,
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
                json!({
                    "version":1, "id":"wait", "name":name, "arguments":{}, "toolCallId":"tool-wait"
                })
                .to_string()
            )
        );
        harness.session.handle_ui_request(&json!({"id":"wait", "method":"input", "title":title})).await;
        assert!(matches!(harness.next_event().await, DriverEvent::AppToolRequest { .. }));
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(121)).await;
        tokio::task::yield_now().await;
        assert!(harness.session.pending_app_tools.lock().await.contains_key("wait"), "{name} was expired by the driver");
        tokio::time::resume();
        harness.handle.respond_app_tool("wait", Ok(json!({"status":"answered"}))).await.unwrap();
        assert!(harness.wire().await["value"].is_string());
        assert!(harness.session.pending_app_tools.lock().await.is_empty());
    }
}
