//! Integration tests against the real agent CLIs. Each test is skipped when
//! its binary is not on PATH, so CI without agents still passes. Run locally
//! with `cargo test -p kybern-drivers --test live_drivers -- --nocapture`.
//! Set KYBERN_LIVE_TESTS=1 to fail instead of skip when a binary is missing.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use kybern_drivers::registry::DriverRegistry;
use kybern_drivers::{DriverEvent, SessionConfig};
use kybern_protocol::*;

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
