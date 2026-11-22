//! Tests for what both OpenCode APIs share (event framing, silence, start-up
//! retries) and for the 1.x driver's subagent rules, mode changes and turn
//! recovery. The 2.x equivalents are in `v2/tests.rs`; both use [`Mock`].

use super::*;
use serde_json::{Value, json};
use std::sync::Mutex as StdMutex;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// What a [`Mock`] answers one request with.
pub(super) enum Reply {
    Json(u16, Value),
    /// Wait, then answer.
    After(Duration, u16, Value),
    /// An event stream: each chunk, with a pause between, then silence.
    Stream(Vec<Vec<u8>>),
}

#[derive(Clone, Debug)]
pub(super) struct Seen {
    pub method: String,
    pub path: String,
    pub query: String,
    pub body: Value,
}

type Router = Arc<dyn Fn(&str, &str, usize) -> Reply + Send + Sync>;

/// A small HTTP server that records every request and answers by `route(method, path, nth)`.
pub(super) struct Mock {
    pub base: String,
    pub seen: Arc<StdMutex<Vec<Seen>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Mock {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Mock {
    pub(super) async fn start(route: impl Fn(&str, &str, usize) -> Reply + Send + Sync + 'static) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen: Arc<StdMutex<Vec<Seen>>> = Arc::default();
        let router: Router = Arc::new(route);
        let log = seen.clone();
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { return };
                let (router, log) = (router.clone(), log.clone());
                tokio::spawn(async move {
                    let mut bytes = Vec::new();
                    loop {
                        let mut chunk = [0; 4096];
                        let Ok(count) = socket.read(&mut chunk).await else { return };
                        if count == 0 {
                            return;
                        }
                        bytes.extend_from_slice(&chunk[..count]);
                        let text = String::from_utf8_lossy(&bytes).to_string();
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
                    let text = String::from_utf8_lossy(&bytes).to_string();
                    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
                    let mut line = head.lines().next().unwrap_or("").split_whitespace();
                    let (method, target) = (line.next().unwrap_or("").to_string(), line.next().unwrap_or("").to_string());
                    let (path, query) = target.split_once('?').unwrap_or((&target, ""));
                    let (path, query) = (path.to_string(), query.to_string());
                    let nth = {
                        let mut log = log.lock().unwrap();
                        log.push(Seen {
                            method: method.clone(),
                            path: path.clone(),
                            query,
                            body: serde_json::from_str(body).unwrap_or(Value::Null),
                        });
                        log.iter().filter(|seen| seen.method == method && seen.path == path).count() - 1
                    };
                    let json_reply = |status: u16, body: &Value| {
                        let body = body.to_string();
                        format!(
                            "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        )
                    };
                    match router(&method, &path, nth) {
                        Reply::Json(status, body) => {
                            let _ = socket.write_all(json_reply(status, &body).as_bytes()).await;
                        }
                        Reply::After(wait, status, body) => {
                            tokio::time::sleep(wait).await;
                            let _ = socket.write_all(json_reply(status, &body).as_bytes()).await;
                        }
                        Reply::Stream(chunks) => {
                            let _ =
                                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await;
                            for chunk in chunks {
                                let _ = socket.write_all(&chunk).await;
                                let _ = socket.flush().await;
                                tokio::time::sleep(Duration::from_millis(40)).await;
                            }
                            std::future::pending::<()>().await;
                        }
                    }
                });
            }
        });
        Self { base, seen, task }
    }

    pub(super) fn requests(&self, method: &str, path: &str) -> Vec<Seen> {
        self.seen.lock().unwrap().iter().filter(|seen| seen.method == method && seen.path == path).cloned().collect()
    }
}

/// `data: <json>\n\n` as bytes.
pub(super) fn frame(value: Value) -> Vec<u8> {
    format!("data: {value}\n\n").into_bytes()
}

// --- Shared: framing, silence, start-up retries -------------------------------------------------------

#[test]
fn a_character_split_across_two_chunks_is_not_corrupted() {
    let event = json!({"type": "message.part.delta", "properties": {"delta": "caf\u{e9} \u{1f980} \u{4e2d}\u{6587}"}});
    let bytes = frame(event.clone());
    // Cut inside every multibyte character in turn.
    for cut in 1..bytes.len() {
        let mut frames = SseFrames::default();
        let mut payloads = frames.push(&bytes[..cut]);
        payloads.extend(frames.push(&bytes[cut..]));
        assert_eq!(payloads, vec![event.clone()], "split at byte {cut}");
    }
}

#[test]
fn events_are_cut_at_blank_lines_and_a_partial_one_waits() {
    let mut frames = SseFrames::default();
    let payloads = frames.push(b"data: {\"a\":1}\n\ndata: {\"b\":2}\n\ndata: {\"c\"");
    assert_eq!(payloads, vec![json!({"a": 1}), json!({"b": 2})]);
    assert_eq!(frames.push(b":3}\n\n"), vec![json!({"c": 3})]);
    assert!(frames.push(b": heartbeat\n\n").is_empty(), "comments and non-JSON carry no event");
}

#[tokio::test]
async fn reading_stops_when_the_stream_ends_breaks_or_goes_silent() {
    use futures::stream;
    let chunk = |value: Value| Ok::<_, std::io::Error>(frame(value));
    let seen = std::sync::Mutex::new(Vec::new());
    let end = read_frames(stream::iter([chunk(json!({"n": 1}))]), Duration::from_secs(5), |event| {
        seen.lock().unwrap().push(event);
        async {}
    })
    .await;
    assert_eq!((end, seen.lock().unwrap().len()), (StreamEnd::Closed, 1));
    let broken = stream::iter([Err::<Vec<u8>, _>(std::io::Error::other("reset"))]);
    assert_eq!(read_frames(broken, Duration::from_secs(5), |_| async {}).await, StreamEnd::Closed);
    // One event, then nothing: not even a heartbeat.
    let stuck = stream::iter([chunk(json!({"n": 1}))]).chain(stream::pending());
    let started = std::time::Instant::now();
    assert_eq!(read_frames(stuck, Duration::from_millis(120), |_| async {}).await, StreamEnd::Silent);
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[test]
fn the_silence_limit_outlasts_heartbeats_and_a_stuck_subscribe_is_cut_off() {
    assert!(SILENT_STREAM_TIMEOUT >= Duration::from_secs(30), "heartbeats arrive every 10-15 seconds");
    assert!(SILENT_STREAM_TIMEOUT <= Duration::from_secs(60));
    assert_eq!(SUBSCRIBE_TIMEOUT, Duration::from_secs(10));
}

/// `retry_locked_start` over attempts that fail as `outcome(n)` says; returns the result and the tries made.
async fn tries(outcome: fn(usize) -> std::result::Result<usize, StartFailure>) -> (Result<usize>, usize) {
    let attempts = std::sync::atomic::AtomicUsize::new(0);
    let result = retry_locked_start(|| {
        let n = attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        std::future::ready(outcome(n))
    })
    .await;
    (result, attempts.load(std::sync::atomic::Ordering::SeqCst))
}

fn failure(database_locked: bool) -> StartFailure {
    StartFailure { error: DriverError::Protocol("no address".into()), database_locked }
}

#[tokio::test]
async fn a_database_lock_at_start_up_is_retried_and_other_failures_are_not() {
    let (result, made) = tries(|n| if n < 3 { Err(failure(true)) } else { Ok(n) }).await;
    assert_eq!((result.unwrap(), made), (3, 3));
    let (result, made) = tries(|_| Err(failure(true))).await;
    assert!(result.is_err());
    assert_eq!(made, 4, "the first try and three more, then it gives up");
    let (result, made) = tries(|_| Err(failure(false))).await;
    assert!(result.is_err());
    assert_eq!(made, 1, "only a lock is worth another try");
}

#[test]
fn a_locked_database_is_recognised_in_either_wording() {
    assert!(is_database_locked("error: SQLITE_BUSY: database is locked"));
    assert!(is_database_locked("Error: database is locked"));
    assert!(is_database_locked("sqlite_busy"));
    assert!(!is_database_locked("config error: unknown provider"));
}

#[test]
fn the_window_is_the_input_limit_before_the_whole_context() {
    assert_eq!(model_window(&json!({"context": 1_048_576, "input": 983_040, "output": 65_536})), Some(983_040));
    assert_eq!(model_window(&json!({"context": 200_000, "output": 8_000})), Some(200_000));
    assert_eq!(model_window(&json!({"context": 200_000, "input": 0})), Some(200_000));
    assert_eq!(model_window(&json!({"output": 8_000})), None);
}

// --- A fake `opencode` binary ---------------------------------------------------------------------------

/// A script that answers `--version` and otherwise starts "serving" `base`,
/// failing with `stderr` for its first `failures` starts.
#[cfg(unix)]
pub(super) fn fake_opencode(dir: &Path, version: &str, base: &str, failures: usize, stderr: &str) -> PathBuf {
    let script = dir.join("opencode");
    let counter = dir.join("starts");
    kybern_protocol::process::write_executable(
        &script,
        format!(
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo {version}; exit 0; fi\n\
             n=$(cat '{counter}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '{counter}'\n\
             if [ $n -le {failures} ]; then echo '{stderr}' >&2; exit 1; fi\n\
             echo 'opencode server listening on {base}'\nexec sleep 60\n",
            counter = counter.display()
        ),
    )
    .unwrap();
    script
}

#[cfg(unix)]
pub(super) fn session_config(binary: PathBuf, dir: &Path) -> SessionConfig {
    SessionConfig {
        cwd: dir.to_path_buf(),
        model: None,
        effort: None,
        permission_mode: PermissionMode::Supervised,
        native_tool_bridge: None,
        resume_session_id: None,
        resume_lacks_instructions: false,
        fork: false,
        rewind: None,
        binary: Some(binary),
        env: HashMap::new(),
        compaction: crate::CompactionLaunch::default(),
    }
}

#[cfg(unix)]
#[tokio::test]
async fn a_server_that_cannot_open_its_database_is_started_again() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().to_path_buf();
    let mock = Mock::start(|_, _, _| Reply::Json(200, json!({}))).await;
    let script = fake_opencode(&dir, "2.3.0", &mock.base, 2, "SQLITE_BUSY: database is locked");
    let server = v2::Server::start(&script, Some(&dir), std::iter::empty(), &[]).await.unwrap();
    assert_eq!(std::fs::read_to_string(dir.join("starts")).unwrap().trim(), "3");
    assert_eq!(server.base, mock.base);

    // The 1.x launch retries the same way.
    std::fs::write(dir.join("starts"), "0").unwrap();
    let script = fake_opencode(&dir, "1.20.0", &mock.base, 1, "Error: database is locked");
    let env = HashMap::new();
    let (mut child, _tree, base) = retry_locked_start(|| start_server(&script, &dir, &env, None)).await.unwrap();
    assert_eq!(base, mock.base);
    assert_eq!(std::fs::read_to_string(dir.join("starts")).unwrap().trim(), "2");
    let _ = child.kill().await;
    drop(server);

    // Any other failure is final: one start, not four.
    std::fs::write(dir.join("starts"), "0").unwrap();
    let script = fake_opencode(&dir, "1.20.0", &mock.base, 9, "Error: bad config");
    assert!(retry_locked_start(|| start_server(&script, &dir, &env, None)).await.is_err());
    assert_eq!(std::fs::read_to_string(dir.join("starts")).unwrap().trim(), "1");
}

/// 1.x subscribes to `/event` before it creates the session, so a fast first
/// turn cannot finish before the stream is attached.
#[cfg(unix)]
#[tokio::test]
async fn the_event_stream_is_subscribed_before_the_session_is_created() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().to_path_buf();
    let mock = Mock::start(|method, path, _| match (method, path) {
        ("GET", "/event") => Reply::Stream(vec![frame(json!({"type": "server.connected", "properties": {}}))]),
        ("POST", "/session") => Reply::Json(200, json!({"id": "ses_new"})),
        _ => Reply::Json(200, json!({})),
    })
    .await;
    let script = fake_opencode(&dir, "1.20.0", &mock.base, 0, "");
    let spawned = crate::opencode::OpencodeDriver.spawn(session_config(script, &dir)).await.unwrap();
    let order: Vec<String> = mock.seen.lock().unwrap().iter().map(|seen| format!("{} {}", seen.method, seen.path)).collect();
    let subscribed = order.iter().position(|request| request == "GET /event").expect("the stream is subscribed");
    let created = order.iter().position(|request| request == "POST /session").expect("the session is created");
    assert!(subscribed < created, "{order:?}");
    spawned.session.close().await.unwrap();
}

// --- 1.x: rules ------------------------------------------------------------------------------------------

/// The action OpenCode takes for `permission`: the last rule that matches.
fn action(rules: &[Value], permission: &str) -> String {
    rules
        .iter()
        .rev()
        .find(|rule| rule["permission"] == "*" || rule["permission"] == permission)
        .map(|rule| rule["action"].as_str().unwrap().to_string())
        .unwrap_or_default()
}

#[test]
fn the_modes_decide_the_same_as_before_and_start_with_denies() {
    let rules = |mode| rule_list(&ruleset(mode));
    let decide = |mode, permissions: &[&str]| permissions.iter().map(|permission| action(&rules(mode), permission)).collect::<Vec<_>>();
    assert_eq!(decide(PermissionMode::Supervised, &["read", "edit", "bash", "task", "webfetch"]), ["allow", "ask", "ask", "allow", "ask"]);
    assert_eq!(
        decide(PermissionMode::AcceptEdits, &["read", "edit", "bash", "webfetch", "external_directory"]),
        ["allow", "allow", "ask", "ask", "ask"]
    );
    assert_eq!(decide(PermissionMode::Auto, &["edit", "bash", "external_directory", "doom_loop"]), ["allow", "allow", "ask", "ask"]);
    assert_eq!(decide(PermissionMode::FullAccess, &["edit", "bash", "external_directory"]), ["allow", "allow", "allow"]);
    // A subagent copies only the denies and `external_directory`: in every mode
    // that asks, that is a session that denies everything until it is updated.
    for mode in [PermissionMode::Supervised, PermissionMode::AcceptEdits, PermissionMode::Auto] {
        let copied: Vec<Value> = rules(mode).into_iter().filter(v1_inherits).collect();
        assert_eq!(action(&copied, "bash"), "deny", "{mode:?}");
        assert_eq!(action(&copied, "edit"), "deny", "{mode:?}");
        assert_eq!(copied[0], json!({"permission": "*", "pattern": "*", "action": "deny"}));
    }
    // Full access has no denies to copy; it must pass external directories on.
    let copied: Vec<Value> = rules(PermissionMode::FullAccess).into_iter().filter(v1_inherits).collect();
    assert_eq!(copied, [json!({"permission": "external_directory", "pattern": "*", "action": "allow"})]);
}

#[test]
fn a_subagent_keeps_its_own_restrictions_after_the_parents_rules() {
    let parent = rule_list(&ruleset(PermissionMode::Supervised));
    let own = json!({"permission": "todowrite", "pattern": "*", "action": "deny"});
    let copied: Vec<Value> = parent.iter().filter(|rule| v1_inherits(rule)).cloned().collect();
    let child: Vec<Value> = copied.iter().cloned().chain([own.clone()]).collect();
    let merged = merge_child_rules(&parent, &child);
    assert_eq!(&merged[..parent.len()], parent.as_slice());
    assert_eq!(&merged[parent.len()..], std::slice::from_ref(&own), "the copied denies are not kept twice");
    // A mode change replaces the parent's part and keeps the child's own.
    let next = rule_list(&ruleset(PermissionMode::FullAccess));
    let again = merge_child_rules(&next, &merged);
    assert_eq!(again, next.iter().cloned().chain([own]).collect::<Vec<_>>());
}

fn v1_session(base: &str, mode: PermissionMode) -> (Arc<OpencodeSession>, mpsc::Receiver<DriverEvent>) {
    let (events, rx) = mpsc::channel(64);
    let mut command = crate::test_process::sleep();
    command.arg("30").kill_on_drop(true);
    let session = Arc::new(OpencodeSession {
        http: reqwest::Client::new(),
        base: base.into(),
        dir: "/work".into(),
        child: Mutex::new(command.spawn().unwrap()),
        events,
        state: Mutex::new(State {
            compact_operation: None,
            commands: vec![kybern_protocol::ProviderCommand { name: "review".into(), description: "Review".into(), ..Default::default() }],
            context_windows: HashMap::new(),
            session_id: Some("ses_root".into()),
            model: Some("p/m".into()),
            coordinator_instructions: None,
            mode,
            parts: HashMap::new(),
            message_roles: HashMap::new(),
            pending_images: HashMap::new(),
            turn_usage: Usage::default(),
            turn_cost: 0.0,
            turn_started: None,
            active: false,
            pending: HashMap::new(),
            current_message_id: None,
            context_overflow: None,
            children: HashMap::new(),
            rule_locks: HashMap::new(),
        }),
    });
    (session, rx)
}

fn event(ty: &str, properties: Value) -> Value {
    json!({"type": ty, "properties": properties})
}

fn drain(rx: &mut mpsc::Receiver<DriverEvent>) -> Vec<DriverEvent> {
    std::iter::from_fn(|| rx.try_recv().ok()).collect()
}

fn child_created(id: &str, permission: Value) -> Value {
    event(
        "session.created",
        json!({"info": {"id": id, "parentID": "ses_root", "title": "Look around (@general subagent)", "agent": "general", "permission": permission}}),
    )
}

#[tokio::test]
async fn a_subagent_gets_this_threads_rules_before_it_is_announced() {
    let mock = Mock::start(|_, _, _| Reply::Json(200, json!({}))).await;
    let (session, mut rx) = v1_session(&mock.base, PermissionMode::Supervised);
    let parent = rule_list(&ruleset(PermissionMode::Supervised));
    // What OpenCode 1 gives the child: the parent's denies and the child's own.
    let copied: Vec<Value> = parent.iter().filter(|rule| v1_inherits(rule)).cloned().collect();
    let own = json!({"permission": "task", "pattern": "*", "action": "deny"});
    let given: Vec<Value> = copied.iter().cloned().chain([own.clone()]).collect();
    session.handle_event(&child_created("ses_kid", json!(given))).await;

    let patches = mock.requests("PATCH", "/session/ses_kid");
    assert_eq!(patches.len(), 1);
    let written = patches[0].body["permission"].as_array().unwrap().clone();
    assert_eq!(written, parent.iter().cloned().chain([own]).collect::<Vec<_>>());
    assert!(matches!(drain(&mut rx).as_slice(), [DriverEvent::RuntimeTaskStarted(task)] if task.id == "opencode:ses_kid"));

    // The parent's task tool part announces it again; its rules are not written twice.
    session
        .handle_event(&event(
            "message.part.updated",
            json!({"sessionID": "ses_root", "part": {"id": "p0", "type": "tool", "tool": "task", "callID": "call-1", "messageID": "m",
                "state": {"status": "running", "input": {"description": "Look around"}, "metadata": {"sessionId": "ses_kid"}}}}),
        ))
        .await;
    assert_eq!(mock.requests("PATCH", "/session/ses_kid").len(), 1);
}

fn running_task_part(status: &str) -> Value {
    event(
        "message.part.updated",
        json!({"sessionID": "ses_root", "part": {"id": "p0", "type": "tool", "tool": "task", "callID": "call-1", "messageID": "m",
            "state": {"status": status, "input": {}, "metadata": {"sessionId": "ses_kid"}}}}),
    )
}

fn notices(events: &[DriverEvent]) -> Vec<(NoticeLevel, String)> {
    events
        .iter()
        .filter_map(|event| match event {
            DriverEvent::Notice { level, text, .. } => Some((*level, text.clone())),
            _ => None,
        })
        .collect()
}

/// A subagent that cannot be given this thread's rules must not run: it is stopped, once, and
/// still announced first so its stop has a task to end.
#[tokio::test]
async fn a_subagent_that_cannot_be_updated_is_stopped_and_says_so_once() {
    let mock =
        Mock::start(|method, _, _| if method == "PATCH" { Reply::Json(500, json!({"error": "no"})) } else { Reply::Json(200, json!({})) })
            .await;
    let (session, mut rx) = v1_session(&mock.base, PermissionMode::Supervised);
    session.handle_event(&child_created("ses_kid", json!([]))).await;
    session.handle_event(&running_task_part("running")).await;
    let events = drain(&mut rx);
    assert_eq!(
        notices(&events),
        [(NoticeLevel::Warning, "Stopped a subagent that couldn't switch to Supervised. Ask the agent to run it again.".to_string())],
        "{events:?}"
    );
    assert_eq!(mock.requests("POST", "/session/ses_kid/abort").len(), 1, "the subagent was told to stop");
    let kinds: Vec<&str> = events
        .iter()
        .filter_map(|event| match event {
            DriverEvent::RuntimeTaskStarted(_) => Some("started"),
            DriverEvent::RuntimeTaskCompleted(update) if update.status == Some(RuntimeTaskStatus::Stopped) => Some("stopped"),
            _ => None,
        })
        .collect();
    assert_eq!(&kinds[..2], ["started", "stopped"], "announced before it is stopped: {kinds:?}");
}

#[tokio::test]
async fn the_permission_mode_changes_in_place_for_the_thread_and_its_running_subagents() {
    let mock = Mock::start(|_, _, _| Reply::Json(200, json!({}))).await;
    let (session, _rx) = v1_session(&mock.base, PermissionMode::Supervised);
    let handle = Handle(session.clone(), std::sync::Mutex::new(None), None);
    let own = json!({"permission": "task", "pattern": "*", "action": "deny"});
    let parent = rule_list(&ruleset(PermissionMode::Supervised));
    let given: Vec<Value> = parent.iter().filter(|rule| v1_inherits(rule)).cloned().chain([own.clone()]).collect();
    session.handle_event(&child_created("ses_kid", json!(given))).await;
    // A finished subagent is rewritten as well.
    session.handle_event(&child_created("ses_done", json!([]))).await;
    session.handle_event(&event("session.idle", json!({"sessionID": "ses_done"}))).await;

    handle.set_permission_mode(PermissionMode::FullAccess).await.expect("OpenCode 1 can change rules in place");

    let full = rule_list(&ruleset(PermissionMode::FullAccess));
    assert_eq!(session.state.lock().await.mode, PermissionMode::FullAccess);
    let root = mock.requests("PATCH", "/session/ses_root");
    assert_eq!(root.len(), 1);
    assert_eq!(root[0].body["permission"], json!(full));
    let kid = mock.requests("PATCH", "/session/ses_kid");
    assert_eq!(kid.len(), 2, "written when it appeared, and again for the new mode");
    assert_eq!(kid[1].body["permission"], json!(full.iter().cloned().chain([own]).collect::<Vec<_>>()));
    // A finished subagent can be resumed: it is rewritten too, so it never holds an older mode.
    let done = mock.requests("PATCH", "/session/ses_done");
    assert_eq!(done.len(), 2, "written when it appeared, and again for the new mode");
    assert_eq!(done[1].body["permission"], json!(full));
}

#[tokio::test]
async fn a_failed_mode_change_is_reported_and_leaves_the_mode_as_it_was() {
    let mock = Mock::start(|_, _, _| Reply::Json(400, json!({"error": "bad"}))).await;
    let (session, _rx) = v1_session(&mock.base, PermissionMode::Supervised);
    let handle = Handle(session.clone(), std::sync::Mutex::new(None), None);
    assert!(matches!(handle.set_permission_mode(PermissionMode::Auto).await, Err(DriverError::Protocol(_))));
    // The thread's rules were not written, and the daemon keeps the old mode:
    // the driver must not hand later subagents the new one.
    assert_eq!(session.state.lock().await.mode, PermissionMode::Supervised);
}

/// The thread is in the new mode once its own rules are written. A running subagent that
/// cannot be updated is stopped rather than left on the older mode.
#[tokio::test]
async fn a_running_subagent_that_cannot_follow_a_mode_change_is_stopped_and_the_mode_still_changes() {
    let mock = Mock::start(|method, path, _| {
        if (method, path) == ("PATCH", "/session/ses_kid") { Reply::Json(500, json!({"error": "no"})) } else { Reply::Json(200, json!({})) }
    })
    .await;
    let (session, mut rx) = v1_session(&mock.base, PermissionMode::FullAccess);
    let handle = Handle(session.clone(), std::sync::Mutex::new(None), None);
    // Registered without a write: the first write is the one that fails.
    session.state.lock().await.children.insert("ses_kid".into(), ChildRuntime { task_id: "opencode:ses_kid".into(), ..Default::default() });
    handle.set_permission_mode(PermissionMode::Supervised).await.expect("the thread itself changed mode");
    assert_eq!(session.state.lock().await.mode, PermissionMode::Supervised);
    let root = mock.requests("PATCH", "/session/ses_root");
    assert_eq!(root[0].body["permission"], json!(rule_list(&ruleset(PermissionMode::Supervised))));
    assert_eq!(mock.requests("POST", "/session/ses_kid/abort").len(), 1, "the subagent was stopped");
    assert!(session.state.lock().await.children["ses_kid"].terminal);
    let events = drain(&mut rx);
    assert_eq!(
        notices(&events),
        [(NoticeLevel::Warning, "Stopped a subagent that couldn't switch to Supervised. Ask the agent to run it again.".to_string())]
    );
}

/// A finished subagent cannot be stopped. Its rules stay marked to be written again, and when it
/// resumes and that fails too, it is stopped before it can run.
#[tokio::test]
async fn a_finished_subagent_whose_rewrite_fails_is_stopped_when_it_resumes() {
    let fail = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let failing = fail.clone();
    let mock = Mock::start(move |method, path, _| {
        if (method, path) == ("PATCH", "/session/ses_kid") && failing.load(std::sync::atomic::Ordering::SeqCst) {
            Reply::Json(500, json!({"error": "no"}))
        } else {
            Reply::Json(200, json!({"id": "ses_kid", "permission": []}))
        }
    })
    .await;
    let (session, mut rx) = v1_session(&mock.base, PermissionMode::FullAccess);
    let handle = Handle(session.clone(), std::sync::Mutex::new(None), None);
    session.handle_event(&task_part("call-1", "running")).await;
    session.handle_event(&event("session.idle", json!({"sessionID": "ses_kid"}))).await;
    fail.store(true, std::sync::atomic::Ordering::SeqCst);
    drain(&mut rx);

    handle.set_permission_mode(PermissionMode::Supervised).await.unwrap();
    assert!(mock.requests("POST", "/session/ses_kid/abort").is_empty(), "a finished subagent is not stopped");
    assert!(session.state.lock().await.children["ses_kid"].rules.is_none(), "it is marked to be written again");
    assert!(notices(&drain(&mut rx)).is_empty());

    session.handle_event(&task_part("call-2", "running")).await;
    assert_eq!(mock.requests("POST", "/session/ses_kid/abort").len(), 1, "stopped before it can run under the older mode");
    let events = drain(&mut rx);
    assert_eq!(
        notices(&events),
        [(NoticeLevel::Warning, "Stopped a subagent that couldn't switch to Supervised. Ask the agent to run it again.".to_string())]
    );
}

/// A subagent that can neither be updated nor stopped is one the person has to act on.
#[tokio::test]
async fn a_subagent_that_can_neither_be_updated_nor_stopped_is_an_error() {
    let mock = Mock::start(|method, _, _| if method == "GET" { Reply::Json(200, json!({})) } else { Reply::Json(500, json!({})) }).await;
    let (session, mut rx) = v1_session(&mock.base, PermissionMode::Supervised);
    session.state.lock().await.children.insert("ses_kid".into(), ChildRuntime { task_id: "opencode:ses_kid".into(), ..Default::default() });
    session.rewrite_child_rules(Vec::new()).await;
    let found = notices(&drain(&mut rx));
    assert!(matches!(found.as_slice(), [(NoticeLevel::Error, text)] if text.contains("is still running")), "{found:?}");
    assert!(!session.state.lock().await.children["ses_kid"].terminal);
}

/// After a restart the driver has seen none of the subagents: the server's list is all there is.
#[tokio::test]
async fn subagents_the_driver_never_saw_are_found_on_the_server_and_rewritten_at_a_mode_change() {
    let stored = json!([{"permission": "*", "pattern": "*", "action": "allow"}]);
    let mock = Mock::start(move |method, path, _| match (method, path) {
        ("GET", "/session/ses_root/children") => Reply::Json(200, json!([{"id": "ses_old"}])),
        ("GET", "/session/ses_old/children") => Reply::Json(200, json!([{"id": "ses_nested"}])),
        ("GET", "/session/ses_old") | ("GET", "/session/ses_nested") => Reply::Json(200, json!({"permission": stored})),
        _ => Reply::Json(200, json!({})),
    })
    .await;
    let (session, _rx) = v1_session(&mock.base, PermissionMode::FullAccess);
    let handle = Handle(session.clone(), std::sync::Mutex::new(None), None);
    handle.set_permission_mode(PermissionMode::Supervised).await.unwrap();
    for id in ["ses_old", "ses_nested"] {
        let writes = mock.requests("PATCH", &format!("/session/{id}"));
        assert_eq!(writes.len(), 1, "{id}");
        let written: Vec<Value> = writes[0].body["permission"].as_array().unwrap().clone();
        assert_eq!((action(&written, "bash"), action(&written, "edit")), ("ask".to_string(), "ask".to_string()), "{id}");
    }
}

#[tokio::test]
async fn a_mode_change_that_cannot_list_the_subagents_changes_nothing() {
    let mock = Mock::start(|method, _, _| if method == "GET" { Reply::Json(500, json!({})) } else { Reply::Json(200, json!({})) }).await;
    let (session, _rx) = v1_session(&mock.base, PermissionMode::FullAccess);
    let handle = Handle(session.clone(), std::sync::Mutex::new(None), None);
    assert!(handle.set_permission_mode(PermissionMode::Supervised).await.is_err());
    assert_eq!(session.state.lock().await.mode, PermissionMode::FullAccess);
    assert!(mock.requests("PATCH", "/session/ses_root").is_empty(), "the thread was not changed half way");
}

/// When the mode will not hold still the write must not report success on a stale one.
#[tokio::test]
async fn a_write_that_never_settles_on_the_current_mode_is_an_error_and_stops_a_running_child() {
    let mock = Mock::start(|method, _, _| {
        if method == "PATCH" {
            Reply::After(Duration::from_millis(60), 200, json!({}))
        } else {
            Reply::Json(200, json!({"permission": []}))
        }
    })
    .await;
    let (session, mut rx) = v1_session(&mock.base, PermissionMode::Supervised);
    session.state.lock().await.children.insert("ses_kid".into(), ChildRuntime { task_id: "opencode:ses_kid".into(), ..Default::default() });
    // Flip the mode every time a write to the child lands.
    let flipper = tokio::spawn({
        let session = session.clone();
        let seen = mock.seen.clone();
        async move {
            let mut flips = 0;
            loop {
                let writes = seen.lock().unwrap().iter().filter(|seen| seen.method == "PATCH" && seen.path == "/session/ses_kid").count();
                if writes > flips {
                    flips = writes;
                    let mut state = session.state.lock().await;
                    state.mode =
                        if state.mode == PermissionMode::Supervised { PermissionMode::FullAccess } else { PermissionMode::Supervised };
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }
    });
    let result = session.refresh_child_rules("ses_kid", None).await;
    flipper.abort();
    let error = result.expect_err("the last write to land was for a mode that was already gone");
    session.child_rules_failed("ses_kid", &error).await;
    assert_eq!(mock.requests("POST", "/session/ses_kid/abort").len(), 1);
    assert_eq!(notices(&drain(&mut rx)).len(), 1);
}

/// Writes to one child are one at a time: the second does not send its PATCH until the first has ended.
#[tokio::test]
async fn writes_to_one_subagent_land_in_the_order_they_read_the_mode() {
    let mock = Mock::start(|method, path, nth| {
        if (method, path, nth) == ("PATCH", "/session/ses_kid", 0) {
            Reply::After(Duration::from_millis(300), 200, json!({}))
        } else {
            Reply::Json(200, json!({"permission": []}))
        }
    })
    .await;
    let (session, _rx) = v1_session(&mock.base, PermissionMode::FullAccess);
    let first = tokio::spawn({
        let session = session.clone();
        async move { session.refresh_child_rules("ses_kid", None).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(mock.requests("PATCH", "/session/ses_kid").len(), 1);
    session.state.lock().await.mode = PermissionMode::Supervised;
    let second = tokio::spawn({
        let session = session.clone();
        async move { session.refresh_child_rules("ses_kid", None).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(mock.requests("PATCH", "/session/ses_kid").len(), 1, "the second write waits for the first");
    first.await.unwrap().unwrap();
    second.await.unwrap().unwrap();
    let writes = mock.requests("PATCH", "/session/ses_kid");
    let last: Vec<Value> = writes.last().unwrap().body["permission"].as_array().unwrap().clone();
    assert_eq!(action(&last, "bash"), "ask", "the last write to land is the current mode's");
}

// --- 1.x: a subagent's own rules never loosen the mode -----------------------------------------------------

/// A child damaged by an earlier write, or given an `allow` by its agent's defaults, holds
/// rules after the thread's that would win. Only its own denies are kept.
#[test]
fn a_subagents_own_allow_and_ask_rules_never_loosen_the_thread_mode() {
    let parent = rule_list(&ruleset(PermissionMode::Supervised));
    let wide_open = [
        json!({"permission": "*", "pattern": "*", "action": "allow"}),
        json!({"permission": "external_directory", "pattern": "*", "action": "allow"}),
        json!({"permission": "bash", "pattern": "*", "action": "ask"}),
    ];
    // After a whole ruleset Kybern wrote, after the part OpenCode copies, and with no known layout at all.
    let copied: Vec<Value> = parent.iter().filter(|rule| v1_inherits(rule)).cloned().collect();
    for held in [
        parent.iter().cloned().chain(wide_open.clone()).collect::<Vec<_>>(),
        copied.iter().cloned().chain(wide_open.clone()).collect::<Vec<_>>(),
        wide_open.to_vec(),
    ] {
        let merged = merge_child_rules(&parent, &held);
        for permission in ["bash", "edit", "webfetch", "websearch", "external_directory"] {
            assert_eq!(action(&merged, permission), action(&parent, permission), "{permission}: {held:?}");
        }
        assert_eq!(action(&merged, "bash"), "ask");
        assert_eq!(action(&merged, "edit"), "ask");
    }
}

#[test]
fn a_subagents_own_deny_survives_beside_an_allow_that_is_dropped() {
    let parent = rule_list(&ruleset(PermissionMode::Supervised));
    let bash_deny = json!({"permission": "bash", "pattern": "*", "action": "deny"});
    let held: Vec<Value> = parent
        .iter()
        .cloned()
        .chain([
            json!({"permission": "*", "pattern": "*", "action": "allow"}),
            bash_deny.clone(),
            json!({"permission": "edit", "pattern": "*", "action": "allow"}),
        ])
        .collect();
    let merged = merge_child_rules(&parent, &held);
    assert_eq!(action(&merged, "bash"), "deny", "its own restriction holds");
    assert_eq!(action(&merged, "edit"), "ask", "the thread's mode decides the rest");
    assert_eq!(merged.last(), Some(&bash_deny));
}

// --- 1.x: resuming ------------------------------------------------------------------------------------------

/// A session saved under Full access must not keep it while the thread shows Supervised.
#[cfg(unix)]
#[tokio::test]
async fn a_resumed_thread_whose_rules_cannot_be_written_does_not_start() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().to_path_buf();
    let mock = Mock::start(|method, path, _| match (method, path) {
        ("GET", "/event") => Reply::Stream(vec![frame(json!({"type": "server.connected", "properties": {}}))]),
        ("PATCH", "/session/ses_old") => Reply::Json(500, json!({"error": "no"})),
        _ => Reply::Json(200, json!({"id": "ses_old"})),
    })
    .await;
    let script = fake_opencode(&dir, "1.20.0", &mock.base, 0, "");
    let mut config = session_config(script, &dir);
    config.resume_session_id = Some("ses_old".into());
    let result = crate::opencode::OpencodeDriver.spawn(config).await;
    assert!(result.is_err(), "the session would have kept its stored rules");
    assert_eq!(mock.requests("PATCH", "/session/ses_old").len(), 1);
}

/// The server forgets nothing about a resumed thread's subagents, and the driver knows none of
/// them: each is brought up to date before the thread can run.
#[cfg(unix)]
#[tokio::test]
async fn a_resumed_threads_subagents_are_rewritten_before_it_runs() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().to_path_buf();
    let full = rule_list(&ruleset(PermissionMode::FullAccess));
    let mock = Mock::start(move |method, path, _| match (method, path) {
        ("GET", "/event") => Reply::Stream(vec![frame(json!({"type": "server.connected", "properties": {}}))]),
        ("GET", "/session/ses_old/children") => Reply::Json(200, json!([{"id": "ses_kid"}])),
        ("GET", "/session/ses_kid") => Reply::Json(200, json!({"id": "ses_kid", "permission": full})),
        _ => Reply::Json(200, json!({"id": "ses_old"})),
    })
    .await;
    let script = fake_opencode(&dir, "1.20.0", &mock.base, 0, "");
    let mut config = session_config(script, &dir);
    config.resume_session_id = Some("ses_old".into());
    let spawned = crate::opencode::OpencodeDriver.spawn(config).await.unwrap();
    let writes = mock.requests("PATCH", "/session/ses_kid");
    assert_eq!(writes.len(), 1);
    let written: Vec<Value> = writes[0].body["permission"].as_array().unwrap().clone();
    assert_eq!((action(&written, "bash"), action(&written, "edit")), ("ask".to_string(), "ask".to_string()));
    spawned.session.close().await.unwrap();
}

// --- 1.x: resumed subagents --------------------------------------------------------------------------------

fn own_task_deny() -> Value {
    json!({"permission": "task", "pattern": "*", "action": "deny"})
}

fn task_part(call: &str, status: &str) -> Value {
    event(
        "message.part.updated",
        json!({"sessionID": "ses_root", "part": {"id": format!("part-{call}"), "type": "tool", "tool": "task", "callID": call, "messageID": "m",
            "state": {"status": status, "input": {"description": "Look around"}, "metadata": {"sessionId": "ses_kid"}}}}),
    )
}

/// A subagent that Kybern wrote the rules of an older mode into must not keep
/// them once it is resumed in a stricter one: the last matching rule wins, so
/// kept as its own they would out-vote the new mode's.
#[tokio::test]
async fn a_subagent_resumed_in_a_stricter_mode_does_not_keep_the_old_modes_rules() {
    for older in [PermissionMode::FullAccess, PermissionMode::AcceptEdits, PermissionMode::Auto] {
        // What the server holds after Kybern wrote `older` into the subagent.
        let stored: Vec<Value> = rule_list(&ruleset(older)).into_iter().chain([own_task_deny()]).collect();
        let held = stored.clone();
        let mock = Mock::start(move |method, path, _| match (method, path) {
            ("GET", "/session/ses_kid") => Reply::Json(200, json!({"id": "ses_kid", "permission": held})),
            _ => Reply::Json(200, json!({})),
        })
        .await;
        // The daemon restarted: this driver has never seen the subagent, and is Supervised.
        let (session, _rx) = v1_session(&mock.base, PermissionMode::Supervised);
        session.handle_event(&task_part("call-1", "running")).await;
        let patches = mock.requests("PATCH", "/session/ses_kid");
        assert_eq!(patches.len(), 1, "{older:?}");
        let written: Vec<Value> = patches[0].body["permission"].as_array().unwrap().clone();
        assert_eq!(action(&written, "bash"), "ask", "{older:?}");
        assert_eq!(action(&written, "edit"), "ask", "{older:?}");
        assert_eq!(action(&written, "read"), "allow", "{older:?}");
        assert_eq!(action(&written, "task"), "deny", "the agent's own restriction stays ({older:?})");
        let supervised: Vec<Value> = rule_list(&ruleset(PermissionMode::Supervised)).into_iter().chain([own_task_deny()]).collect();
        assert_eq!(written, supervised, "{older:?}");
    }
}

/// Full access, finished, then Supervised, then resumed: the same leak by the
/// route that does not involve a restart.
#[tokio::test]
async fn a_finished_subagent_is_rewritten_for_a_new_mode_and_resumes_under_it() {
    let stored: Arc<StdMutex<Value>> = Arc::new(StdMutex::new(json!([])));
    let served = stored.clone();
    let mock = Mock::start(move |method, path, _| match (method, path) {
        ("GET", "/session/ses_kid") => Reply::Json(200, json!({"id": "ses_kid", "permission": served.lock().unwrap().clone()})),
        _ => Reply::Json(200, json!({})),
    })
    .await;
    let (session, _rx) = v1_session(&mock.base, PermissionMode::FullAccess);
    let handle = Handle(session.clone(), std::sync::Mutex::new(None), None);
    let store_last_write = || {
        let writes = mock.requests("PATCH", "/session/ses_kid");
        *stored.lock().unwrap() = writes.last().unwrap().body["permission"].clone();
    };
    // OpenCode gave the new subagent the one rule a Full access parent passes on, and its own.
    let copied = json!({"permission": "external_directory", "pattern": "*", "action": "allow"});
    session.handle_event(&child_created("ses_kid", json!([copied, own_task_deny()]))).await;
    store_last_write();
    session.handle_event(&event("session.idle", json!({"sessionID": "ses_kid"}))).await;

    handle.set_permission_mode(PermissionMode::Supervised).await.unwrap();
    let writes = mock.requests("PATCH", "/session/ses_kid");
    assert_eq!(writes.len(), 2, "the finished subagent is rewritten when the mode changes");
    store_last_write();

    session.handle_event(&task_part("call-1", "running")).await;
    session.handle_event(&event("session.idle", json!({"sessionID": "ses_kid"}))).await;
    session.handle_event(&task_part("call-2", "running")).await;
    let writes = mock.requests("PATCH", "/session/ses_kid");
    let last: Vec<Value> = writes.last().unwrap().body["permission"].as_array().unwrap().clone();
    assert_eq!((action(&last, "bash"), action(&last, "edit")), ("ask".to_string(), "ask".to_string()));
    assert_eq!(action(&last, "task"), "deny");
}

#[test]
fn what_kybern_wrote_under_any_mode_is_never_taken_for_a_subagents_own_rules() {
    let own = [own_task_deny(), json!({"permission": "todowrite", "pattern": "*", "action": "deny"})];
    for mode in [PermissionMode::Supervised, PermissionMode::AcceptEdits, PermissionMode::Auto, PermissionMode::FullAccess] {
        let written: Vec<Value> = rule_list(&ruleset(mode)).into_iter().chain(own.clone()).collect();
        assert_eq!(child_own_rules(&written), own, "written under {mode:?}");
        let copied: Vec<Value> = rule_list(&ruleset(mode)).into_iter().filter(v1_inherits).chain(own.clone()).collect();
        assert_eq!(child_own_rules(&copied), own, "copied under {mode:?}");
        // The agent's own rules first, then the copy.
        let reversed: Vec<Value> = own.iter().cloned().chain(rule_list(&ruleset(mode)).into_iter().filter(v1_inherits)).collect();
        assert_eq!(child_own_rules(&reversed), own, "copied after its own, under {mode:?}");
    }
}

/// A rule of the agent's own that equals one Kybern writes (a `bash` deny from
/// the agent's restrictions) is the agent's, and stays.
#[test]
fn a_subagents_own_deny_that_equals_a_seeded_deny_is_kept() {
    let bash_deny = json!({"permission": "bash", "pattern": "*", "action": "deny"});
    for mode in [PermissionMode::Supervised, PermissionMode::AcceptEdits, PermissionMode::Auto] {
        let parent = rule_list(&ruleset(mode));
        let copied: Vec<Value> = parent.iter().filter(|rule| v1_inherits(rule)).cloned().collect();
        for given in [
            copied.iter().cloned().chain([bash_deny.clone()]).collect::<Vec<_>>(),
            [bash_deny.clone()].into_iter().chain(copied.iter().cloned()).collect::<Vec<_>>(),
        ] {
            let merged = merge_child_rules(&parent, &given);
            assert_eq!(action(&merged, "bash"), "deny", "{mode:?}: the agent's restriction holds");
            assert_eq!(merged.len(), parent.len() + 1, "{mode:?}: only that one rule is added");
            // Writing again changes nothing.
            assert_eq!(merge_child_rules(&parent, &merged), merged, "{mode:?}");
        }
    }
}

#[tokio::test]
async fn a_resumed_subagent_reports_its_new_run_and_gets_the_current_rules() {
    let mock = Mock::start(|method, path, _| match (method, path) {
        ("GET", "/session/ses_kid") => {
            Reply::Json(200, json!({"id": "ses_kid", "permission": [{"permission": "*", "pattern": "*", "action": "deny"}]}))
        }
        _ => Reply::Json(200, json!({})),
    })
    .await;
    let (session, mut rx) = v1_session(&mock.base, PermissionMode::Supervised);
    let part = |call: &str, status: &str| {
        event(
            "message.part.updated",
            json!({"sessionID": "ses_root", "part": {"id": format!("part-{call}"), "type": "tool", "tool": "task", "callID": call, "messageID": "m",
                "state": {"status": status, "input": {"description": "Look around"}, "metadata": {"sessionId": "ses_kid"}}}}),
        )
    };
    let idle = event("session.idle", json!({"sessionID": "ses_kid"}));
    let statuses = |events: Vec<DriverEvent>| -> Vec<String> {
        events
            .into_iter()
            .filter_map(|event| match event {
                DriverEvent::RuntimeTaskStarted(task) => Some(format!("started {:?}", task.status)),
                DriverEvent::RuntimeTaskCompleted(update) => Some(format!("completed {:?}", update.status)),
                _ => None,
            })
            .collect()
    };
    session.handle_event(&part("call-1", "running")).await;
    session.handle_event(&idle).await;
    // The parent's tool part finishes after the child: that is not a new run.
    session.handle_event(&part("call-1", "completed")).await;
    session.handle_event(&idle).await;
    assert_eq!(statuses(drain(&mut rx)), ["started Running", "completed Some(Completed)", "started Completed"]);

    // A new call for the same child resumes it: its end is reported again.
    session.handle_event(&part("call-2", "running")).await;
    session.handle_event(&idle).await;
    assert_eq!(statuses(drain(&mut rx)), ["started Running", "completed Some(Completed)"]);
    // Its stored rules may be old: they are read and replaced.
    assert_eq!(mock.requests("GET", "/session/ses_kid").len(), 2);
    assert_eq!(mock.requests("PATCH", "/session/ses_kid").len(), 2);
}

// --- 1.x: context overflow ---------------------------------------------------------------------------------

#[tokio::test]
async fn a_context_overflow_that_opencode_compacts_does_not_fail_the_turn() {
    let (session, mut rx) = v1_session("http://127.0.0.1:9", PermissionMode::Supervised);
    let overflow = event(
        "session.error",
        json!({"sessionID": "ses_root", "error": {"name": "ContextOverflowError", "data": {"message": "too long"}}}),
    );
    let idle = event("session.idle", json!({"sessionID": "ses_root"}));
    let busy = event("session.status", json!({"sessionID": "ses_root", "status": {"type": "busy"}}));

    // Overflow, then OpenCode compacts and finishes: the turn completes.
    session.handle_event(&busy).await;
    session.handle_event(&overflow).await;
    session.handle_event(&event("session.compacted", json!({"sessionID": "ses_root"}))).await;
    session.handle_event(&idle).await;
    let events = drain(&mut rx);
    assert!(
        events.iter().any(|event| matches!(event, DriverEvent::TurnCompleted { stop_reason: StopReason::Completed, .. })),
        "{events:?}"
    );
    assert!(!events.iter().any(|event| matches!(event, DriverEvent::TurnFailed { .. })), "{events:?}");

    // Overflow that is never compacted still fails, when the session goes idle.
    session.handle_event(&busy).await;
    session.handle_event(&overflow).await;
    assert!(drain(&mut rx).is_empty(), "nothing is decided while OpenCode may still compact");
    session.handle_event(&idle).await;
    let events = drain(&mut rx);
    assert!(
        matches!(events.as_slice(), [DriverEvent::TurnFailed { error, .. }] if error == "ContextOverflowError: too long"),
        "{events:?}"
    );

    // Other errors fail at once, as before.
    session.handle_event(&busy).await;
    session.handle_event(&event("session.error", json!({"error": {"name": "APIError", "data": {"message": "502"}}}))).await;
    assert!(matches!(drain(&mut rx).as_slice(), [DriverEvent::TurnFailed { error, .. }] if error == "APIError: 502"));
}

// --- 1.x: commands -----------------------------------------------------------------------------------------

#[tokio::test]
async fn a_command_request_waits_for_the_generation_however_long_it_takes() {
    let (session, _rx) = v1_session("http://127.0.0.1:9", PermissionMode::Supervised);
    let bounded = session.request(reqwest::Method::POST, "/session/ses_root/prompt_async", &json!({}), Some(Duration::from_secs(600)));
    assert_eq!(bounded.build().unwrap().timeout(), Some(&Duration::from_secs(600)));
    let unbounded = session.request(reqwest::Method::POST, "/session/ses_root/command", &json!({}), None);
    assert_eq!(unbounded.build().unwrap().timeout(), None);
}

#[tokio::test]
async fn a_command_that_errors_after_its_turn_ended_does_not_fail_it_twice() {
    let mock = Mock::start(|method, path, _| {
        if (method, path) == ("POST", "/session/ses_root/command") {
            Reply::After(Duration::from_millis(250), 500, json!({"error": "connection lost"}))
        } else {
            Reply::Json(200, json!({}))
        }
    })
    .await;
    let (session, mut rx) = v1_session(&mock.base, PermissionMode::Supervised);
    let handle = Handle(session.clone(), std::sync::Mutex::new(None), None);
    handle.send_message("m1", &UserMessage::text("/review now")).await.unwrap();
    // The event stream reports the end while the command request is still open.
    session.handle_event(&event("session.idle", json!({"sessionID": "ses_root"}))).await;
    tokio::time::sleep(Duration::from_millis(600)).await;
    let events = drain(&mut rx);
    assert!(matches!(events.as_slice(), [DriverEvent::TurnCompleted { .. }]), "{events:?}");

    // A command that fails while its turn is running does fail it.
    handle.send_message("m2", &UserMessage::text("/review again")).await.unwrap();
    tokio::time::sleep(Duration::from_millis(600)).await;
    let events = drain(&mut rx);
    assert!(matches!(events.as_slice(), [DriverEvent::TurnFailed { .. }]), "{events:?}");
}

// --- 1.x: windows ------------------------------------------------------------------------------------------

#[tokio::test]
async fn the_window_reported_for_a_model_is_its_input_limit_when_it_has_one() {
    let mock = Mock::start(|_, path, _| match path {
        "/provider" => Reply::Json(
            200,
            json!({"all": [{"id": "p", "models": {
                "wide": {"limit": {"context": 1_000_000, "input": 900_000, "output": 64_000}},
                "plain": {"limit": {"context": 200_000, "output": 8_000}}}}]}),
        ),
        _ => Reply::Json(200, json!([])),
    })
    .await;
    let (session, _rx) = v1_session(&mock.base, PermissionMode::Supervised);
    session.discover_metadata().await;
    let windows = session.state.lock().await.context_windows.clone();
    assert_eq!((windows["p/wide"], windows["p/plain"]), (900_000, 200_000));
}

// --- 1.x: a turn whose end was missed -----------------------------------------------------------------------

#[tokio::test]
async fn a_silent_stream_is_resubscribed_and_a_missed_end_of_turn_is_settled_from_the_stored_messages() {
    let mock = Mock::start(|method, path, _| match (method, path) {
        // Each subscription answers with a heartbeat and then nothing.
        ("GET", "/event") => Reply::Stream(vec![frame(json!({"type": "server.heartbeat", "properties": {}}))]),
        ("GET", "/session/status") => Reply::Json(200, json!({})),
        ("GET", "/session/ses_root/message") => Reply::Json(
            200,
            json!([
                {"info": {"id": "msg_user", "role": "user"}, "parts": [{"id": "u", "type": "text", "messageID": "msg_user", "text": "hi"}]},
                {"info": {"id": "msg_reply", "role": "assistant"}, "parts": [
                    {"id": "t", "type": "text", "messageID": "msg_reply", "text": "The final answer.", "time": {"start": 1, "end": 2}},
                    {"id": "s", "type": "step-finish", "messageID": "msg_reply", "tokens": {"input": 5, "output": 7}, "cost": 0.25}]}
            ]),
        ),
        _ => Reply::Json(200, json!({})),
    })
    .await;
    let (session, mut rx) = v1_session(&mock.base, PermissionMode::Supervised);
    {
        let mut state = session.state.lock().await;
        state.active = true;
        state.turn_started = Some(std::time::Instant::now());
        state.current_message_id = Some("msg_user".into());
    }
    let looping = tokio::spawn(session.clone().event_loop_with(None, Duration::from_millis(200)));
    let mut events = Vec::new();
    let waited = tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(event) = rx.recv().await {
            let done = matches!(event, DriverEvent::TurnCompleted { .. });
            events.push(event);
            if done {
                break;
            }
        }
    })
    .await;
    looping.abort();
    assert!(waited.is_ok(), "the turn never settled: {events:?}");
    let [DriverEvent::MessageCompleted { text, .. }, DriverEvent::TurnCompleted { stop_reason, anchors, .. }] = events.as_slice() else {
        panic!("{events:?}")
    };
    assert_eq!((text.as_str(), *stop_reason, anchors.turn_id.as_deref()), ("The final answer.", StopReason::Completed, Some("msg_user")));
    assert!(mock.requests("GET", "/event").len() >= 2, "the silent stream was dropped and subscribed again");
    // The steps' tokens and cost come with the text: a settled turn is not a free one.
    let Some(DriverEvent::TurnCompleted { usage, cost_usd, .. }) = events.last() else { unreachable!() };
    assert_eq!((usage.input_tokens, usage.output_tokens, *cost_usd), (5, 7, Some(0.25)));
}

#[tokio::test]
async fn a_turn_that_is_still_running_is_left_to_its_stream_after_a_reconnect() {
    let mock = Mock::start(|method, path, _| match (method, path) {
        ("GET", "/event") => Reply::Stream(vec![frame(json!({"type": "server.heartbeat", "properties": {}}))]),
        ("GET", "/session/status") => Reply::Json(200, json!({"ses_root": {"type": "busy"}})),
        _ => Reply::Json(200, json!({})),
    })
    .await;
    let (session, mut rx) = v1_session(&mock.base, PermissionMode::Supervised);
    {
        let mut state = session.state.lock().await;
        state.active = true;
        state.current_message_id = Some("msg_user".into());
    }
    let looping = tokio::spawn(session.clone().event_loop_with(None, Duration::from_millis(150)));
    tokio::time::sleep(Duration::from_millis(900)).await;
    looping.abort();
    assert!(mock.requests("GET", "/event").len() >= 2);
    assert!(mock.requests("GET", "/session/ses_root/message").is_empty(), "a busy session is not read back");
    assert!(drain(&mut rx).is_empty());
    assert!(session.state.lock().await.active);
}

#[tokio::test]
async fn text_the_stream_already_delivered_is_not_repeated_when_a_turn_is_settled() {
    let mock = Mock::start(|method, path, _| match (method, path) {
        ("GET", "/session/status") => Reply::Json(200, json!({})),
        ("GET", "/session/ses_root/message") => Reply::Json(
            200,
            json!([
                {"info": {"id": "msg_user", "role": "user"}, "parts": []},
                {"info": {"id": "msg_reply", "role": "assistant"}, "parts": [
                    {"id": "t", "type": "text", "messageID": "msg_reply", "text": "Done.", "time": {"start": 1, "end": 2}}]}
            ]),
        ),
        _ => Reply::Json(200, json!({})),
    })
    .await;
    let (session, mut rx) = v1_session(&mock.base, PermissionMode::Supervised);
    {
        let mut state = session.state.lock().await;
        state.active = true;
        state.current_message_id = Some("msg_user".into());
    }
    session
        .handle_event(&event(
            "message.part.updated",
            json!({"sessionID": "ses_root", "part": {"id": "t", "type": "text", "messageID": "msg_reply", "text": "Done.", "time": {"start": 1, "end": 2}}}),
        ))
        .await;
    session.settle_after_reconnect().await;
    let events = drain(&mut rx);
    let messages = events.iter().filter(|event| matches!(event, DriverEvent::MessageCompleted { .. })).count();
    assert_eq!(messages, 1, "{events:?}");
    assert!(events.iter().any(|event| matches!(event, DriverEvent::TurnCompleted { .. })));
}

#[tokio::test]
async fn a_prompt_that_is_not_stored_yet_is_not_mistaken_for_a_finished_turn() {
    let mock = Mock::start(|method, path, _| match (method, path) {
        ("GET", "/session/status") => Reply::Json(200, json!({})),
        // The previous turn's messages only.
        ("GET", "/session/ses_root/message") => Reply::Json(
            200,
            json!([{"info": {"id": "msg_old", "role": "user"}, "parts": []}, {"info": {"id": "msg_old_reply", "role": "assistant"}, "parts": []}]),
        ),
        _ => Reply::Json(200, json!({})),
    })
    .await;
    let (session, mut rx) = v1_session(&mock.base, PermissionMode::Supervised);
    {
        let mut state = session.state.lock().await;
        state.active = true;
        state.current_message_id = Some("msg_new".into());
    }
    session.settle_after_reconnect().await;
    assert!(drain(&mut rx).is_empty());
    assert!(session.state.lock().await.active);
}

// --- 1.x: settling a long turn, a compaction, late text, gap approvals ---------------------------------------

/// Put a turn waiting on `msg_user` into `session`.
async fn waiting_turn(session: &OpencodeSession) {
    let mut state = session.state.lock().await;
    state.active = true;
    state.turn_started = Some(std::time::Instant::now());
    state.current_message_id = Some("msg_user".into());
}

fn stored_reply(id: &str, parts: Value) -> Value {
    json!({"info": {"id": id, "role": "assistant"}, "parts": parts})
}

#[tokio::test]
async fn a_turn_longer_than_one_page_of_messages_still_settles() {
    let filler = |n: usize| -> Vec<Value> { (0..n).map(|i| stored_reply(&format!("msg_tool_{i}"), json!([]))).collect() };
    let mock = Mock::start(move |method, path, nth| match (method, path) {
        ("GET", "/session/status") => Reply::Json(200, json!({})),
        // The first page holds only the newest messages of a long turn: its prompt is further back.
        ("GET", "/session/ses_root/message") if nth == 0 => Reply::Json(200, json!(filler(SETTLE_PAGE))),
        ("GET", "/session/ses_root/message") => {
            let mut all = vec![json!({"info": {"id": "msg_user", "role": "user"}, "parts": []})];
            all.extend(filler(SETTLE_PAGE - 1));
            all.push(stored_reply(
                "msg_last",
                json!([{"id": "t", "type": "text", "messageID": "msg_last", "text": "All done.", "time": {"start": 1, "end": 2}}]),
            ));
            Reply::Json(200, json!(all))
        }
        _ => Reply::Json(200, json!({})),
    })
    .await;
    let (session, mut rx) = v1_session(&mock.base, PermissionMode::Supervised);
    waiting_turn(&session).await;
    session.settle_after_reconnect().await;
    let events = drain(&mut rx);
    assert!(
        matches!(events.as_slice(), [DriverEvent::MessageCompleted { text, .. }, DriverEvent::TurnCompleted { .. }] if text == "All done."),
        "{events:?}"
    );
    let reads = mock.requests("GET", "/session/ses_root/message");
    let limits: Vec<&str> = reads.iter().map(|read| read.query.split('&').next().unwrap()).collect();
    assert_eq!(limits, [format!("limit={SETTLE_PAGE}"), format!("limit={}", SETTLE_PAGE * 2)]);
}

#[tokio::test]
async fn a_turn_whose_prompt_is_beyond_every_page_read_is_still_ended_once_the_session_is_idle() {
    let mock = Mock::start(|method, path, _| match (method, path) {
        ("GET", "/session/status") => Reply::Json(200, json!({})),
        ("GET", "/session/ses_root/message") => {
            Reply::Json(200, json!((0..SETTLE_PAGE_CAP).map(|i| stored_reply(&format!("msg_{i}"), json!([]))).collect::<Vec<_>>()))
        }
        _ => Reply::Json(200, json!({})),
    })
    .await;
    let (session, mut rx) = v1_session(&mock.base, PermissionMode::Supervised);
    waiting_turn(&session).await;
    session.settle_after_reconnect().await;
    let events = drain(&mut rx);
    assert!(matches!(events.as_slice(), [DriverEvent::TurnCompleted { .. }]), "{events:?}");
}

#[tokio::test]
async fn a_reconnect_during_a_compaction_does_not_fail_the_turn_that_succeeded() {
    let mock = Mock::start(|method, path, _| match (method, path) {
        ("GET", "/session/status") => Reply::Json(200, json!({})),
        ("GET", "/session/ses_root/message") => Reply::Json(
            200,
            json!([
                {"info": {"id": "msg_user", "role": "user"}, "parts": []},
                stored_reply("msg_reply", json!([{"id": "t", "type": "text", "messageID": "msg_reply", "text": "Fine.", "time": {"start": 1, "end": 2}}]))
            ]),
        ),
        _ => Reply::Json(200, json!({})),
    })
    .await;
    let (session, mut rx) = v1_session(&mock.base, PermissionMode::Supervised);
    waiting_turn(&session).await;
    // `session.compacted` went by while the stream was down.
    session
        .handle_event(&event(
            "session.error",
            json!({"sessionID": "ses_root", "error": {"name": "ContextOverflowError", "data": {"message": "too long"}}}),
        ))
        .await;
    session.settle_after_reconnect().await;
    let events = drain(&mut rx);
    assert!(
        events.iter().any(|event| matches!(event, DriverEvent::TurnCompleted { stop_reason: StopReason::Completed, .. })),
        "{events:?}"
    );
    assert!(!events.iter().any(|event| matches!(event, DriverEvent::TurnFailed { .. })), "{events:?}");
}

#[tokio::test]
async fn text_that_was_buffered_behind_a_settled_turn_is_dropped() {
    let mock = Mock::start(|method, path, _| match (method, path) {
        ("GET", "/session/status") => Reply::Json(200, json!({})),
        ("GET", "/session/ses_root/message") => Reply::Json(
            200,
            json!([
                {"info": {"id": "msg_user", "role": "user"}, "parts": []},
                stored_reply("msg_reply", json!([{"id": "t", "type": "text", "messageID": "msg_reply", "text": "Done.", "time": {"start": 1, "end": 2}}]))
            ]),
        ),
        _ => Reply::Json(200, json!({})),
    })
    .await;
    let (session, mut rx) = v1_session(&mock.base, PermissionMode::Supervised);
    waiting_turn(&session).await;
    session.settle_after_reconnect().await;
    drain(&mut rx);
    // The stream was resubscribed before the status was read: what it buffered arrives now.
    session
        .handle_event(&event("message.part.delta", json!({"sessionID": "ses_root", "partID": "t", "field": "text", "delta": "Done."})))
        .await;
    assert!(drain(&mut rx).is_empty(), "the reply was delivered whole already");
}

#[tokio::test]
async fn a_step_the_stream_counted_is_not_counted_again_when_the_turn_is_settled() {
    let step = |id: &str, input: u64| json!({"id": id, "type": "step-finish", "messageID": "msg_reply", "tokens": {"input": input, "output": 1}, "cost": 0.5});
    let steps = [step("s1", 10), step("s2", 20)];
    let stored = steps.clone();
    let mock = Mock::start(move |method, path, _| match (method, path) {
        ("GET", "/session/status") => Reply::Json(200, json!({})),
        ("GET", "/session/ses_root/message") => {
            Reply::Json(200, json!([{"info": {"id": "msg_user", "role": "user"}, "parts": []}, stored_reply("msg_reply", json!(stored))]))
        }
        _ => Reply::Json(200, json!({})),
    })
    .await;
    let (session, mut rx) = v1_session(&mock.base, PermissionMode::Supervised);
    waiting_turn(&session).await;
    session.handle_event(&event("message.part.updated", json!({"sessionID": "ses_root", "part": steps[0]}))).await;
    session.settle_after_reconnect().await;
    let events = drain(&mut rx);
    let Some(DriverEvent::TurnCompleted { usage, cost_usd, .. }) = events.last() else { panic!("{events:?}") };
    assert_eq!((usage.input_tokens, usage.output_tokens, *cost_usd), (30, 2, Some(1.0)));
}

#[tokio::test]
async fn approvals_asked_while_the_stream_was_down_are_surfaced_and_answered_ones_withdrawn() {
    let mock = Mock::start(|method, path, _| match (method, path) {
        ("GET", "/permission") => Reply::Json(
            200,
            json!([
                {"id": "per_old", "sessionID": "ses_root", "permission": "bash", "patterns": ["ls"], "metadata": {"command": "ls"}, "always": []},
                {"id": "per_new", "sessionID": "ses_root", "permission": "bash", "patterns": ["rm x"], "metadata": {"command": "rm x"}, "always": []},
                {"id": "per_other", "sessionID": "ses_elsewhere", "permission": "bash", "patterns": ["id"], "metadata": {}, "always": []}
            ]),
        ),
        ("GET", "/question") => Reply::Json(200, json!([{"id": "que_new", "sessionID": "ses_root", "questions": [{"question": "Which?"}]}])),
        _ => Reply::Json(200, json!({})),
    })
    .await;
    let (session, mut rx) = v1_session(&mock.base, PermissionMode::Supervised);
    {
        let mut state = session.state.lock().await;
        state.pending.insert("per_old".into(), "ses_root".into());
        state.pending.insert("per_answered".into(), "ses_root".into());
        state.pending.insert("que_answered".into(), "__question".into());
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
    assert_eq!(asked, ["per_new", "que_new"], "{events:?}");
    let mut withdrawn: Vec<&str> = events
        .iter()
        .filter_map(|event| match event {
            DriverEvent::PermissionWithdrawn { request_id } => Some(request_id.as_str()),
            _ => None,
        })
        .collect();
    withdrawn.sort();
    assert_eq!(withdrawn, ["per_answered", "que_answered"], "{events:?}");
    // The same request announced again by the stream is not shown twice.
    session
        .handle_event(&event(
            "permission.asked",
            json!({"id": "per_new", "sessionID": "ses_root", "permission": "bash", "patterns": ["rm x"]}),
        ))
        .await;
    assert!(drain(&mut rx).is_empty());
    // It can still be answered.
    assert!(session.state.lock().await.pending.contains_key("per_new"));
}

#[tokio::test]
async fn a_failed_command_does_not_fail_a_newer_turn() {
    let mock = Mock::start(|method, path, _| {
        if (method, path) == ("POST", "/session/ses_root/command") {
            Reply::After(Duration::from_millis(250), 500, json!({"error": "connection lost"}))
        } else {
            Reply::Json(200, json!({}))
        }
    })
    .await;
    let (session, mut rx) = v1_session(&mock.base, PermissionMode::Supervised);
    let handle = Handle(session.clone(), std::sync::Mutex::new(None), None);
    handle.send_message("m1", &UserMessage::text("/review now")).await.unwrap();
    // The command's turn ended and the user already sent something else.
    {
        let mut state = session.state.lock().await;
        state.current_message_id = Some("msg_newer".into());
        state.active = true;
    }
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert!(drain(&mut rx).is_empty(), "the newer turn is not the command's");
    let state = session.state.lock().await;
    assert!(state.active && state.current_message_id.as_deref() == Some("msg_newer"));
}

#[tokio::test]
async fn a_turn_replaced_while_it_is_settled_is_left_alone() {
    let mock = Mock::start(|method, path, _| match (method, path) {
        ("GET", "/session/status") => Reply::Json(200, json!({})),
        ("GET", "/session/ses_root/message") => Reply::After(
            Duration::from_millis(300),
            200,
            json!([
                {"info": {"id": "msg_user", "role": "user"}, "parts": []},
                stored_reply("msg_reply", json!([{"id": "t", "type": "text", "messageID": "msg_reply", "text": "Done.", "time": {"start": 1, "end": 2}}]))
            ]),
        ),
        _ => Reply::Json(200, json!({})),
    })
    .await;
    let (session, mut rx) = v1_session(&mock.base, PermissionMode::Supervised);
    waiting_turn(&session).await;
    let settling = tokio::spawn({
        let session = session.clone();
        async move { session.settle_after_reconnect().await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    // While the messages are read the turn ends by itself and another begins.
    session.handle_event(&event("session.idle", json!({"sessionID": "ses_root"}))).await;
    session.state.lock().await.current_message_id = Some("msg_next".into());
    session.state.lock().await.active = true;
    drain(&mut rx);
    settling.await.unwrap();
    assert!(drain(&mut rx).is_empty(), "the settled turn was not this one");
    let state = session.state.lock().await;
    assert!(state.active && state.current_message_id.as_deref() == Some("msg_next"));
}
