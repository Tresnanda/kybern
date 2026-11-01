//! A login another machine lent, through the real Claude and Codex drivers (ADE-86 S4, design §9.4).
//!
//! The harnesses are fake: a shell script for Claude and a Python app-server for Codex. They record what
//! they were given and check the credential the way the real ones would: Claude reads
//! `CLAUDE_CODE_OAUTH_TOKEN` and rejects a token that is not the valid one; Codex' app-server is given the
//! tokens over `account/login/start` and asks the host for new ones with `account/chatgptAuthTokens/refresh`.
//! No real login is read or written.
#![cfg(unix)]

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use kybern_drivers::login_lend::{self, BORROW_ENV, CLAUDE_HOTSWAP_ENV, LoginSource, RenewReason};
use kybern_drivers::{AgentDriver, DriverEvent, SessionConfig};
use kybern_protocol::{BorrowedLogin, PermissionMode, UserMessage};

/// A source that lends `current` and, when asked to renew, moves on to the next token in `next`.
struct Scripted {
    current: Mutex<BorrowedLogin>,
    next: Mutex<Vec<BorrowedLogin>>,
    renewals: Mutex<Vec<RenewReason>>,
}

impl Scripted {
    fn claude(token: &str, next: &[&str]) -> Arc<Self> {
        let claude = |token: &str| BorrowedLogin::Claude { access_token: token.into(), expires_at_ms: None };
        Arc::new(Self {
            current: Mutex::new(claude(token)),
            next: Mutex::new(next.iter().rev().map(|token| claude(token)).collect()),
            renewals: Mutex::new(Vec::new()),
        })
    }

    fn codex(token: &str, next: &[&str]) -> Arc<Self> {
        let codex = |token: &str| BorrowedLogin::Codex {
            access_token: token.into(),
            account_id: "acct-1".into(),
            plan_type: Some("pro".into()),
            id_token: None,
        };
        Arc::new(Self {
            current: Mutex::new(codex(token)),
            next: Mutex::new(next.iter().rev().map(|token| codex(token)).collect()),
            renewals: Mutex::new(Vec::new()),
        })
    }
}

#[async_trait]
impl LoginSource for Scripted {
    async fn current(&self) -> Result<BorrowedLogin, String> {
        Ok(self.current.lock().unwrap().clone())
    }

    async fn renew(&self, reason: RenewReason) -> Result<BorrowedLogin, String> {
        self.renewals.lock().unwrap().push(reason);
        let next = self.next.lock().unwrap().pop().ok_or("the broker is offline")?;
        *self.current.lock().unwrap() = next.clone();
        Ok(next)
    }
}

fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, body).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

/// A `claude` that records its environment and answers every user message: with success when
/// `CLAUDE_CODE_OAUTH_TOKEN` is the token in `$FAKE_OUT/valid`, with Claude's own rejection when it is not,
/// and (when the host can answer) by asking for a new token first, as the SDK hook does.
const FAKE_CLAUDE: &str = r#"#!/bin/sh
printf '%s' "$CLAUDE_CODE_OAUTH_TOKEN" > "$FAKE_OUT/token"
printf '%s|%s|%s' "${KYBERN_BORROWED_LOGIN:-unset}" "${CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH:-unset}" "${CLAUDE_CODE_ENTRYPOINT:-unset}" > "$FAKE_OUT/other"
token="$CLAUDE_CODE_OAUTH_TOKEN"
while IFS= read -r line; do
  case "$line" in
    *'"type":"user"'*)
      valid=$(cat "$FAKE_OUT/valid")
      if [ "$token" != "$valid" ] && [ "$CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH" = "1" ]; then
        echo '{"type":"control_request","request_id":"refresh-1","request":{"subtype":"oauth_token_refresh"}}'
        IFS= read -r answer
        echo "$answer" > "$FAKE_OUT/refresh-answer"
        token=$(printf '%s' "$answer" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
      fi
      if [ "$token" = "$valid" ]; then
        echo '{"type":"result","subtype":"success","is_error":false,"result":"ok","duration_ms":1,"total_cost_usd":0,"usage":{}}'
      else
        echo '{"type":"assistant","error":"authentication_failed","message":{"id":"m1","content":[]}}'
        echo '{"type":"result","subtype":"success","is_error":true,"result":"Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.","duration_ms":1,"total_cost_usd":0,"usage":{}}'
      fi;;
  esac
done
"#;

fn config(binary: &Path, cwd: &Path, env: HashMap<String, String>) -> SessionConfig {
    SessionConfig {
        cwd: cwd.to_path_buf(),
        model: None,
        effort: None,
        permission_mode: PermissionMode::Supervised,
        native_tool_bridge: None,
        resume_session_id: None,
        resume_lacks_instructions: false,
        fork: false,
        rewind: None,
        binary: Some(binary.to_path_buf()),
        env,
    }
}

async fn next_turn_end(events: &mut tokio::sync::mpsc::Receiver<DriverEvent>) -> DriverEvent {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        match tokio::time::timeout_at(deadline, events.recv()).await {
            Ok(Some(event @ (DriverEvent::TurnCompleted { .. } | DriverEvent::TurnFailed { .. }))) => return event,
            Ok(Some(_)) => {}
            Ok(None) => panic!("the session ended without finishing the turn"),
            Err(_) => panic!("no turn end within 20s"),
        }
    }
}

fn read(dir: &Path, name: &str) -> String {
    std::fs::read_to_string(dir.join(name)).unwrap_or_default()
}

#[tokio::test]
async fn claude_runs_on_the_lent_token_and_a_rejected_one_fails_the_turn() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("out");
    std::fs::create_dir_all(&out).unwrap();
    std::fs::write(out.join("valid"), "tok-A").unwrap();
    let binary = script(dir.path(), "claude", FAKE_CLAUDE);
    let source = Scripted::claude("tok-A", &[]);
    let handle = login_lend::register(source.clone());
    // A named account blanks the token variable; the lent one must come after it.
    let env = HashMap::from([
        (BORROW_ENV.to_string(), handle.clone()),
        ("CLAUDE_CODE_OAUTH_TOKEN".to_string(), String::new()),
        ("FAKE_OUT".to_string(), out.to_string_lossy().into_owned()),
    ]);
    let spawned = kybern_drivers::claude::ClaudeDriver::default().spawn(config(&binary, dir.path(), env)).await.unwrap();
    let (session, mut events) = (spawned.session, spawned.events);
    session.send_message("m1", &UserMessage::text("hello")).await.unwrap();
    assert!(matches!(next_turn_end(&mut events).await, DriverEvent::TurnCompleted { .. }));
    assert_eq!(read(&out, "token"), "tok-A", "the harness got the lent token");
    assert_eq!(
        read(&out, "other"),
        "unset|unset|kybern",
        "the handle never reaches the harness, the hot swap is off by default, and requests are labelled as Kybern"
    );

    // The broker rotated: the token the process holds is no longer valid, and the turn fails with Claude's words.
    std::fs::write(out.join("valid"), "tok-B").unwrap();
    session.send_message("m2", &UserMessage::text("again")).await.unwrap();
    match next_turn_end(&mut events).await {
        DriverEvent::TurnFailed { error } => {
            assert!(error.contains("OAuth token revoked"), "{error}");
            assert!(login_lend::is_login_failure(kybern_protocol::ProviderKind::ClaudeCode, &error));
        }
        other => panic!("expected a failed turn, got {other:?}"),
    }
    session.close().await.unwrap();
    login_lend::unregister(&handle);
}

#[tokio::test]
async fn a_session_that_is_not_lent_keeps_the_ordinary_behaviour() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("out");
    std::fs::create_dir_all(&out).unwrap();
    std::fs::write(out.join("valid"), "other").unwrap();
    let binary = script(dir.path(), "claude", FAKE_CLAUDE);
    let env = HashMap::from([
        ("CLAUDE_CODE_OAUTH_TOKEN".to_string(), "mine".to_string()),
        ("FAKE_OUT".to_string(), out.to_string_lossy().into_owned()),
    ]);
    let spawned = kybern_drivers::claude::ClaudeDriver::default().spawn(config(&binary, dir.path(), env)).await.unwrap();
    let (session, mut events) = (spawned.session, spawned.events);
    session.send_message("m1", &UserMessage::text("hello")).await.unwrap();
    // The same words on a session that borrowed nothing are an ordinary result, as before this change.
    assert!(matches!(next_turn_end(&mut events).await, DriverEvent::TurnCompleted { .. }));
    assert_eq!(read(&out, "token"), "mine");
    session.close().await.unwrap();
}

#[tokio::test]
async fn the_optional_hot_swap_answers_oauth_token_refresh_from_a_fresh_borrow() {
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("out");
    std::fs::create_dir_all(&out).unwrap();
    std::fs::write(out.join("valid"), "tok-A").unwrap();
    let binary = script(dir.path(), "claude", FAKE_CLAUDE);
    let source = Scripted::claude("tok-A", &["tok-B"]);
    let handle = login_lend::register(source.clone());
    let env = HashMap::from([
        (BORROW_ENV.to_string(), handle.clone()),
        (CLAUDE_HOTSWAP_ENV.to_string(), "1".to_string()),
        ("FAKE_OUT".to_string(), out.to_string_lossy().into_owned()),
    ]);
    let spawned = kybern_drivers::claude::ClaudeDriver::default().spawn(config(&binary, dir.path(), env)).await.unwrap();
    let (session, mut events) = (spawned.session, spawned.events);
    session.send_message("m1", &UserMessage::text("one")).await.unwrap();
    assert!(matches!(next_turn_end(&mut events).await, DriverEvent::TurnCompleted { .. }));
    assert_eq!(read(&out, "other"), "unset|1|claude-vscode");

    // The broker rotates; the same process asks the host for a token and the same turn goes on.
    std::fs::write(out.join("valid"), "tok-B").unwrap();
    session.send_message("m2", &UserMessage::text("two")).await.unwrap();
    assert!(matches!(next_turn_end(&mut events).await, DriverEvent::TurnCompleted { .. }), "the swap kept the turn alive");
    assert!(read(&out, "refresh-answer").contains("\"accessToken\":\"tok-B\""), "{}", read(&out, "refresh-answer"));
    assert_eq!(source.renewals.lock().unwrap().len(), 1, "one renewal, no restart");
    session.close().await.unwrap();
}

/// A Codex app-server that is given tokens by the host. On `turn/start` it behaves as if the API answered 401:
/// it asks the host for new tokens with the typed server request and finishes the turn once it has them.
const FAKE_CODEX: &str = r#"#!/usr/bin/env python3
import json, os, sys

out = os.environ["FAKE_OUT"]
borrowed_env = os.environ.get("KYBERN_BORROWED_LOGIN")
open(os.path.join(out, "env"), "w").write(borrowed_env or "unset")

def send(frame):
    sys.stdout.write(json.dumps(frame) + "\n")
    sys.stdout.flush()

def log(name, value):
    with open(os.path.join(out, name), "w") as handle:
        handle.write(json.dumps(value))

for line in sys.stdin:
    frame = json.loads(line)
    method = frame.get("method")
    ident = frame.get("id")
    if method is None:
        # A response to our server request: the host's answer to the refresh.
        if ident == 900:
            log("refresh_answer", frame.get("result"))
            send({"method": "turn/completed", "params": {"threadId": "t1", "turn": {"id": "turn1", "status": "completed"}}})
        continue
    if method == "initialize":
        send({"id": ident, "result": {}})
    elif method == "account/login/start":
        log("login", frame["params"])
        send({"id": ident, "result": {"type": "chatgptAuthTokens"}})
    elif method == "thread/start":
        send({"id": ident, "result": {"thread": {"id": "t1"}, "model": "gpt-test"}})
    elif method == "turn/start":
        send({"id": ident, "result": {"turn": {"id": "turn1"}}})
        send({"id": 900, "method": "account/chatgptAuthTokens/refresh", "params": {"reason": "unauthorized", "previousAccountId": "acct-1"}})
    elif ident is not None:
        send({"id": ident, "error": {"code": -32601, "message": "not supported in the fake"}})
"#;

#[tokio::test]
async fn codex_gets_its_tokens_over_the_app_server_and_answers_the_refresh_request() {
    if std::process::Command::new("python3").arg("--version").output().is_err() {
        eprintln!("skipped: python3 is not installed");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("out");
    std::fs::create_dir_all(&out).unwrap();
    let binary = script(dir.path(), "codex", FAKE_CODEX);
    let source = Scripted::codex("access-1", &["access-2"]);
    let handle = login_lend::register(source.clone());
    let env = HashMap::from([(BORROW_ENV.to_string(), handle.clone()), ("FAKE_OUT".to_string(), out.to_string_lossy().into_owned())]);
    let spawned = kybern_drivers::codex::CodexDriver.spawn(config(&binary, dir.path(), env)).await.unwrap();
    let (session, mut events) = (spawned.session, spawned.events);
    assert_eq!(read(&out, "env"), "unset", "the handle never reaches the app-server");
    let login: serde_json::Value = serde_json::from_str(&read(&out, "login")).unwrap();
    assert_eq!(login["type"], "chatgptAuthTokens");
    assert_eq!(login["accessToken"], "access-1");
    assert_eq!(login["chatgptAccountId"], "acct-1");
    assert_eq!(login["chatgptPlanType"], "pro");
    assert!(!dir.path().join("out").join("auth.json").exists(), "no auth.json is written");

    session.send_message("m1", &UserMessage::text("hello")).await.unwrap();
    assert!(matches!(next_turn_end(&mut events).await, DriverEvent::TurnCompleted { .. }), "the turn finishes after the host answered");
    let answer: serde_json::Value = serde_json::from_str(&read(&out, "refresh_answer")).unwrap();
    assert_eq!(answer["accessToken"], "access-2", "a fresh borrow, not the old token");
    assert_eq!(answer["chatgptAccountId"], "acct-1");
    assert_eq!(*source.renewals.lock().unwrap(), vec![RenewReason::Unauthorized]);
    session.close().await.unwrap();
    login_lend::unregister(&handle);
}

#[tokio::test]
async fn a_lent_login_that_cannot_be_borrowed_fails_the_spawn_with_the_sentence_to_show() {
    struct Offline;
    #[async_trait]
    impl LoginSource for Offline {
        async fn current(&self) -> Result<BorrowedLogin, String> {
            Err("Claude Code signs in through vps, which is offline · Sign in here instead".into())
        }
        async fn renew(&self, _: RenewReason) -> Result<BorrowedLogin, String> {
            Err("offline".into())
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let binary = script(dir.path(), "claude", FAKE_CLAUDE);
    let handle = login_lend::register(Arc::new(Offline));
    let env =
        HashMap::from([(BORROW_ENV.to_string(), handle.clone()), ("FAKE_OUT".to_string(), dir.path().to_string_lossy().into_owned())]);
    let error = match kybern_drivers::claude::ClaudeDriver::default().spawn(config(&binary, dir.path(), env)).await {
        Ok(_) => panic!("a session started without a login"),
        Err(error) => error.to_string(),
    };
    assert!(error.contains("which is offline · Sign in here instead"), "{error}");
    login_lend::unregister(&handle);
}
