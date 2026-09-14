//! Integration tests against the real agent CLIs. Each test is skipped when
//! its binary is not on PATH, so CI without agents still passes. Run locally
//! with `cargo test -p kybern-drivers --test live_drivers -- --nocapture`.
//! Set KYBERN_LIVE_TESTS=1 to fail instead of skip when a binary is missing.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use kybern_drivers::registry::DriverRegistry;
use kybern_drivers::{DriverEvent, NativeToolBridge, NativeToolDefinition, NativeToolRestrictions, SessionConfig};
use kybern_protocol::*;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn skip_or_fail(kind: ProviderKind) -> bool {
    if which::which(kind.default_binary()).is_ok() {
        return false;
    }
    if std::env::var_os("KYBERN_LIVE_TESTS").is_some() {
        panic!("{} is not installed", kind.default_binary());
    }
    eprintln!("skipping {kind}: binary not found");
    true
}

async fn run_turn(kind: ProviderKind, mode: PermissionMode) -> Vec<DriverEvent> {
    let dir = tempfile::tempdir().unwrap();
    std::process::Command::new("git").arg("-C").arg(dir.path()).arg("init").arg("-q").status().unwrap();
    let registry = DriverRegistry::with_defaults();
    let driver = registry.get(kind).expect("driver registered");
    let status = driver.probe(None).await;
    assert!(status.available, "{kind} should probe as available: {:?}", status.unavailable_reason);

    let spawned = driver
        .spawn(SessionConfig {
            cwd: dir.path().to_path_buf(),
            model: None,
            effort: None,
            permission_mode: mode,
            native_tool_bridge: None,
            resume_session_id: None,
            fork: false,
            rewind: None,
            binary: None,
            env: HashMap::new(),
        })
        .await
        .expect("spawn");
    let session = spawned.session;
    let mut events = spawned.events;
    session.send_message(&uuid::Uuid::new_v4().to_string(), &UserMessage::text("Reply with exactly the word: pong")).await.expect("send");

    let mut seen = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
    loop {
        let ev = match tokio::time::timeout_at(deadline, events.recv()).await {
            Ok(Some(ev)) => ev,
            Ok(None) => break,
            Err(_) => panic!("{kind}: no turn completion within 180s; events so far: {seen:?}"),
        };
        let done = matches!(ev, DriverEvent::TurnCompleted { .. } | DriverEvent::TurnFailed { .. } | DriverEvent::Exited { .. });
        if let DriverEvent::PermissionRequest { request_id, .. } = &ev {
            session.respond_permission(request_id, &ApprovalDecision::AllowOnce).await.unwrap();
        }
        seen.push(ev);
        if done {
            break;
        }
    }
    session.close().await.ok();
    seen
}

fn assert_completed_with_text(kind: ProviderKind, events: &[DriverEvent]) {
    assert!(events.iter().any(|e| matches!(e, DriverEvent::SessionBound { .. })), "{kind}: no SessionBound");
    let text: String = events
        .iter()
        .filter_map(|e| match e {
            DriverEvent::MessageCompleted { text, .. } => Some(text.clone()),
            _ => None,
        })
        .collect();
    let deltas: String = events
        .iter()
        .filter_map(|e| match e {
            DriverEvent::TextDelta { delta, .. } => Some(delta.clone()),
            _ => None,
        })
        .collect();
    assert!(
        text.to_lowercase().contains("pong") || deltas.to_lowercase().contains("pong"),
        "{kind}: expected pong in output, got text={text:?} deltas={deltas:?}; events={events:?}"
    );
    assert!(
        events.iter().any(|e| matches!(e, DriverEvent::TurnCompleted { stop_reason: StopReason::Completed, .. })),
        "{kind}: turn did not complete: {events:?}"
    );
}

async fn spawn_probe_mcp() -> (String, Arc<Mutex<Vec<(Option<String>, String)>>>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/mcp", listener.local_addr().unwrap());
    let received = Arc::new(Mutex::new(Vec::new()));
    let server_received = received.clone();
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else { break };
            let received = server_received.clone();
            tokio::spawn(async move {
                let mut bytes = Vec::new();
                loop {
                    let mut chunk = [0_u8; 4096];
                    let Ok(count) = socket.read(&mut chunk).await else { return };
                    if count == 0 {
                        return;
                    }
                    bytes.extend_from_slice(&chunk[..count]);
                    let text = String::from_utf8_lossy(&bytes);
                    let Some(header_end) = text.find("\r\n\r\n") else { continue };
                    let length = text[..header_end]
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase().strip_prefix("content-length:").and_then(|value| value.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if bytes.len() >= header_end + 4 + length {
                        break;
                    }
                }
                let request = String::from_utf8_lossy(&bytes);
                let header_end = request.find("\r\n\r\n").unwrap();
                let authorization = request[..header_end]
                    .lines()
                    .find_map(|line| line.split_once(':').filter(|(name, _)| name.eq_ignore_ascii_case("authorization")))
                    .map(|(_, value)| value.trim().to_string());
                let Ok(value) = serde_json::from_str::<Value>(&request[header_end + 4..]) else { return };
                let method = value.get("method").and_then(Value::as_str).unwrap_or("").to_string();
                received.lock().unwrap().push((authorization, method.clone()));
                let Some(id) = value.get("id") else {
                    let _ = socket.write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                    return;
                };
                let result = match method.as_str() {
                    "initialize" => json!({
                        "protocolVersion": "2025-03-26",
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "kybern-live-probe", "version": "1"}
                    }),
                    "tools/list" => json!({"tools": [{
                        "name": "kybern_thread_context",
                        "description": "Return the Kybern native bridge acceptance sentinel.",
                        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false}
                    }]}),
                    "tools/call" => json!({"content": [{"type": "text", "text": "KYBERN_NATIVE_BRIDGE_OK"}]}),
                    _ => json!({}),
                };
                let response = json!({"jsonrpc": "2.0", "id": id, "result": result}).to_string();
                let headers = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    response.len()
                );
                let _ = socket.write_all(headers.as_bytes()).await;
                let _ = socket.write_all(response.as_bytes()).await;
            });
        }
    });
    (endpoint, received, task)
}

async fn run_native_bridge_turn(kind: ProviderKind) {
    if skip_or_fail(kind) {
        return;
    }
    let (endpoint, mcp_requests, mcp_task) = spawn_probe_mcp().await;
    let dir = tempfile::tempdir().unwrap();
    std::process::Command::new("git").arg("-C").arg(dir.path()).arg("init").arg("-q").status().unwrap();
    let strict = matches!(kind, ProviderKind::ClaudeCode | ProviderKind::Opencode | ProviderKind::Pi | ProviderKind::Omp);
    let bridge = NativeToolBridge {
        server_name: "kybern".into(),
        endpoint: Some(endpoint),
        authorization: Some("live-scoped-capability".into()),
        coordinator_instructions: Some(
            "You are the explicit Kybern test coordinator. Call kybern_thread_context exactly once before answering.".into(),
        ),
        tools: vec![NativeToolDefinition {
            name: "kybern_thread_context".into(),
            description: "Return the Kybern native bridge acceptance sentinel.".into(),
            input_schema: json!({"type": "object", "properties": {}, "additionalProperties": false}),
        }],
        restrictions: NativeToolRestrictions {
            allowed_tools: vec!["kybern_thread_context".into()],
            denied_tools: vec!["write".into(), "edit".into(), "bash".into()],
            require_enforcement: strict,
        },
    };
    let driver = DriverRegistry::with_defaults().get(kind).expect("driver registered");
    let spawned = driver
        .spawn(SessionConfig {
            cwd: dir.path().into(),
            model: None,
            effort: None,
            permission_mode: if kind == ProviderKind::Pi { PermissionMode::FullAccess } else { PermissionMode::Auto },
            native_tool_bridge: Some(bridge),
            resume_session_id: None,
            fork: false,
            rewind: None,
            binary: None,
            env: HashMap::new(),
        })
        .await
        .unwrap_or_else(|error| panic!("{kind}: native bridge spawn failed: {error}"));
    let session = spawned.session;
    let mut events = spawned.events;
    session
        .send_message(
            &uuid::Uuid::new_v4().to_string(),
            &UserMessage::text("Use the Kybern thread-context tool now. Then reply with exactly KYBERN_NATIVE_BRIDGE_OK."),
        )
        .await
        .unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
    let mut saw_app_tool = false;
    let mut completed_text = String::new();
    loop {
        let event = tokio::time::timeout_at(deadline, events.recv())
            .await
            .unwrap_or_else(|_| panic!("{kind}: native bridge turn timed out"))
            .unwrap_or_else(|| panic!("{kind}: native bridge event stream closed"));
        match event {
            DriverEvent::AppToolRequest { request_id, name, .. } => {
                assert_eq!(name, "kybern_thread_context");
                saw_app_tool = true;
                session.respond_app_tool(&request_id, Ok(json!({"sentinel": "KYBERN_NATIVE_BRIDGE_OK"}))).await.unwrap();
            }
            DriverEvent::MessageCompleted { text, .. } => completed_text.push_str(&text),
            DriverEvent::TextDelta { delta, .. } => completed_text.push_str(&delta),
            DriverEvent::TurnCompleted { .. } => break,
            DriverEvent::TurnFailed { error } => panic!("{kind}: native bridge turn failed: {error}"),
            DriverEvent::Exited { error, .. } => panic!("{kind}: native bridge provider exited: {error:?}"),
            _ => {}
        }
    }
    session.close().await.ok();
    let requests = mcp_requests.lock().unwrap().clone();
    let saw_mcp_call = requests.iter().any(|(_, method)| method == "tools/call");
    assert!(saw_app_tool || saw_mcp_call, "{kind}: model never called the native Kybern bridge; MCP requests: {requests:?}");
    if saw_mcp_call {
        assert!(
            requests.iter().all(|(authorization, _)| authorization.as_deref() == Some("Bearer live-scoped-capability")),
            "{kind}: MCP request did not preserve scoped authorization: {requests:?}"
        );
    }
    assert!(completed_text.contains("KYBERN_NATIVE_BRIDGE_OK"), "{kind}: missing sentinel response: {completed_text:?}");
    mcp_task.abort();
}

#[tokio::test]
async fn installed_harnesses_round_trip_a_scoped_native_bridge_tool() {
    let selected = std::env::var("KYBERN_LIVE_PROVIDER").ok();
    for kind in ProviderKind::ALL {
        if selected.as_deref().is_some_and(|name| name != kind.as_str()) {
            continue;
        }
        run_native_bridge_turn(kind).await;
    }
}

#[tokio::test]
async fn claude_code_completes_a_turn() {
    if skip_or_fail(ProviderKind::ClaudeCode) {
        return;
    }
    let events = run_turn(ProviderKind::ClaudeCode, PermissionMode::Supervised).await;
    assert_completed_with_text(ProviderKind::ClaudeCode, &events);
}

#[tokio::test]
async fn codex_completes_a_turn() {
    if skip_or_fail(ProviderKind::Codex) {
        return;
    }
    let events = run_turn(ProviderKind::Codex, PermissionMode::Auto).await;
    assert_completed_with_text(ProviderKind::Codex, &events);
}

#[tokio::test]
async fn opencode_completes_a_turn() {
    if skip_or_fail(ProviderKind::Opencode) {
        return;
    }
    let events = run_turn(ProviderKind::Opencode, PermissionMode::Auto).await;
    assert_completed_with_text(ProviderKind::Opencode, &events);
}

#[tokio::test]
async fn omp_completes_a_turn() {
    if skip_or_fail(ProviderKind::Omp) {
        return;
    }
    let events = run_turn(ProviderKind::Omp, PermissionMode::Auto).await;
    assert_completed_with_text(ProviderKind::Omp, &events);
}

#[tokio::test]
async fn cursor_completes_a_turn() {
    if skip_or_fail(ProviderKind::Cursor) {
        return;
    }
    let events = run_turn(ProviderKind::Cursor, PermissionMode::Auto).await;
    assert_completed_with_text(ProviderKind::Cursor, &events);
}

#[tokio::test]
async fn pi_completes_a_turn() {
    if skip_or_fail(ProviderKind::Pi) {
        return;
    }
    let events = run_turn(ProviderKind::Pi, PermissionMode::FullAccess).await;
    assert_completed_with_text(ProviderKind::Pi, &events);
}

#[allow(dead_code)]
fn _unused(_: PathBuf) {}
