use super::*;
use agent_client_protocol::schema::v1::SessionConfigOption;

fn options() -> Vec<SessionConfigOption> {
    serde_json::from_value(json!([
        {"id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": "gemini-4-neon",
         "options": [{"value": "gemini-4-neon", "name": "Gemini 4 Neon"}, {"value": "gemini-3.8-flash", "name": "Gemini 3.8 Flash"},
                     {"value": "gpt-oss-120b-medium", "name": "GPT-OSS 120B (Medium)"}]},
        {"id": "thought_level", "name": "Thinking Level", "category": "thought_level", "type": "select", "currentValue": "high",
         "options": [{"value": "low", "name": "Low"}, {"value": "medium", "name": "Medium"}, {"value": "high", "name": "High"}]}
    ]))
    .unwrap()
}

fn writes(selection: &ConfigSelection) -> Vec<(&str, &str)> {
    selection.writes.iter().map(|(id, value)| (id.as_str(), value.as_str())).collect()
}

#[test]
fn a_tier_slug_runs_as_its_family_at_the_tier_the_effort_picks() {
    let options = options();
    // The effort picks the tier, as `-p`'s `turn_model` does.
    let selection = config_selection(Some("gemini-3.8-flash-high"), Some("low"), &options);
    assert_eq!(writes(&selection), [("model", "gemini-3.8-flash"), ("thought_level", "low")]);
    assert_eq!(selection.model.as_deref(), Some("gemini-3.8-flash-low"));
    // No effort, or one the family has no tier for, keeps the slug's own tier.
    for effort in [None, Some("max")] {
        let selection = config_selection(Some("gemini-3.8-flash-medium"), effort, &options);
        assert_eq!(writes(&selection), [("model", "gemini-3.8-flash"), ("thought_level", "medium")], "{effort:?}");
        assert_eq!(selection.model.as_deref(), Some("gemini-3.8-flash-medium"));
    }
    // A family value is set as it is; `gpt-oss-120b-medium` is a model, not a tier.
    let selection = config_selection(Some("gpt-oss-120b-medium"), None, &options);
    assert_eq!(writes(&selection), [("model", "gpt-oss-120b-medium")]);
    // A model agy doesn't list is passed through (agy still takes older slugs).
    let selection = config_selection(Some("claude-opus-4-6-thinking"), Some("high"), &options);
    assert_eq!(writes(&selection), [("model", "claude-opus-4-6-thinking")]);
    // An effort alone sets the thinking level and leaves the model.
    let selection = config_selection(None, Some("medium"), &options);
    assert_eq!(writes(&selection), [("thought_level", "medium")]);
    assert_eq!(selection.model, None);
    assert!(config_selection(None, None, &options).writes.is_empty());
}

#[test]
fn every_mode_runs_in_default_but_auto_runs_agys_own_review_when_offered() {
    let offered: SessionModeState = serde_json::from_value(json!({
        "currentModeId": "default",
        "availableModes": [{"id": "default", "name": "Default"}, {"id": "auto", "name": "Auto"}]
    }))
    .unwrap();
    let without: SessionModeState =
        serde_json::from_value(json!({"currentModeId": "default", "availableModes": [{"id": "default", "name": "Default"}]})).unwrap();
    for mode in PermissionMode::ALL {
        let expected = if mode == PermissionMode::Auto { "auto" } else { "default" };
        assert_eq!(session_mode(mode, Some(&offered)), expected, "{mode:?}");
        assert_eq!(session_mode(mode, Some(&without)), "default", "{mode:?}");
        assert_eq!(session_mode(mode, None), "default", "{mode:?}");
    }
}

#[test]
fn agys_tool_names_and_prompt_usage_survive_acps_types() {
    let hidden = std::sync::Mutex::new(HashSet::new());
    let refused = AtomicBool::new(false);
    let mut call = json!({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s", "update": {
        "sessionUpdate": "tool_call", "toolCallId": "c1", "name": "run_command", "args": {"CommandLine": "ls"},
        "status": "in_progress", "kind": "execute", "title": "ls", "rawInput": {"CommandLine": "ls"}}}});
    rewrite(&mut call, &hidden, &refused);
    assert_eq!(call.pointer("/params/update/_meta/kybern~1agyTool"), Some(&json!("run_command")));
    // agy reading its own MCP schema cache disappears, start and end.
    for kind in ["tool_call", "tool_call_update"] {
        let mut read = json!({"method": "session/update", "params": {"sessionId": "s", "update": {
            "sessionUpdate": kind, "toolCallId": "c2", "name": "view_file", "kind": "read", "title": "Read",
            "rawInput": {"AbsolutePath": "/home/me/.gemini/antigravity-cli/mcp/kybern/kybern_thread_read.json"}}}});
        rewrite(&mut read, &hidden, &refused);
        assert_eq!(read.pointer("/params/update"), Some(&json!({"sessionUpdate": "session_info_update"})), "{kind}");
    }
    let mut ask = json!({"id": "1", "method": "session/request_permission", "params": {"sessionId": "s",
        "toolCall": {"toolCallId": "c3", "name": "write_file", "rawInput": {"Path": "/w/a"}}, "options": []}});
    rewrite(&mut ask, &hidden, &refused);
    assert_eq!(ask.pointer("/params/toolCall/_meta/kybern~1agyTool"), Some(&json!("write_file")));
    let mut answer = json!({"jsonrpc": "2.0", "id": 5, "result": {"stopReason": "end_turn",
        "usage": {"inputTokens": 2397, "outputTokens": 56, "cachedReadTokens": 6735, "cachedWriteTokens": 0, "thoughtTokens": 52, "totalTokens": 9188}}});
    rewrite(&mut answer, &hidden, &refused);
    let usage = prompt_usage(answer.pointer("/result/_meta/kybern~1agyUsage"));
    // Recorded from agy 1.5.14: input leaves out cache reads, output already counts thinking (as on `-p`).
    assert_eq!(usage, Usage { input_tokens: 2397, output_tokens: 56, cache_read_tokens: 6735, cache_write_tokens: 0 });
    assert!(!refused.load(Ordering::SeqCst));
    let mut quota = json!({"id": 6, "result": {"stopReason": "refusal"}});
    rewrite(&mut quota, &hidden, &refused);
    assert_eq!(quota.pointer("/result/stopReason"), Some(&json!("end_turn")));
    assert!(refused.load(Ordering::SeqCst));
}

#[test]
fn tool_results_read_as_print_reads_them() {
    let fields = |value: Value| -> ToolCallUpdateFields { serde_json::from_value(value).unwrap() };
    let (output, failed) = tool_output(
        Some("completed"),
        &fields(json!({"rawOutput": {"output": "Command exited with code 0.\n\nCommand output:\nhello\r\n", "exit_code": 0}})),
    );
    assert!(output.as_str().unwrap().contains("hello") && !failed);
    let (_, failed) =
        tool_output(Some("completed"), &fields(json!({"rawOutput": {"output": "Command exited with code 2.\n", "exit_code": 2}})));
    assert!(failed, "a nonzero exit is an error");
    let (output, failed) = tool_output(
        Some("completed"),
        &fields(json!({"content": [{"type": "content", "content": {"type": "text", "text": "from content"}}]})),
    );
    assert_eq!((output, failed), (json!("from content"), false));
    let (_, failed) = tool_output(Some("failed"), &fields(json!({})));
    assert!(failed);
}

#[test]
fn an_error_steps_text_is_read_from_its_payload() {
    let payload = b"\x0a\x3a\x12NOT_FOUND (code 404): Requested entity was not found.\x1a\xff\xfe\x08trace";
    let text = payload_text(payload);
    assert!(text.contains("NOT_FOUND (code 404): Requested entity was not found."), "{text}");
    assert!(!text.chars().any(|c| c.is_control()), "{text:?}");
}

#[test]
fn steps_after_the_mark_tell_an_error_and_whether_the_model_answered() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("s.db");
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute_batch("CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, step_payload blob)").unwrap();
    conn.execute("INSERT INTO steps VALUES (0, 14, x'00'), (1, 15, x'00')", []).unwrap();
    assert_eq!(last_step_index(&db), Some(1));
    assert_eq!(steps_after(&db, 1), None, "nothing new");
    conn.execute("INSERT INTO steps VALUES (2, 17, ?1)", [b"Error 404, Message: not found, Status: NOT_FOUND".to_vec()]).unwrap();
    let early = steps_after(&db, 1).unwrap();
    assert!(early.error.unwrap().contains("Error 404") && !early.reached_model);
    conn.execute("INSERT INTO steps VALUES (3, 15, x'00'), (4, 17, ?1)", [b"NOT_FOUND (code 404): gone".to_vec()]).unwrap();
    let late = steps_after(&db, 2).unwrap();
    assert!(late.reached_model && late.error.is_some());
    conn.execute("INSERT INTO steps VALUES (5, 15, x'00')", []).unwrap();
    let last = Some("NOT_FOUND (code 404): gone".to_string());
    assert_eq!(steps_after(&db, 4), Some(StepsAfter { error: None, reached_model: true, last_error: None }));
    // An error that isn't the last step still counts for what it says (a quota's reset time).
    assert_eq!(steps_after(&db, 2).map(|steps| (steps.error.is_some(), steps.last_error)), Some((false, last)));
}

/// A stand-in for `agy`: `--version` and `models` answer at once, `acp` serves ACP, and anything else is
/// `-p` (one stream-json turn). Each prompt's text picks what it does. Every message it reads goes to
/// `$FAKE_AGY_LOG/received.jsonl`, every start to `calls.jsonl`.
#[cfg(unix)]
const FAKE_AGY: &str = r##"#!/usr/bin/env python3
import json, os, sys, time, sqlite3
args = sys.argv[1:]
# `--version` runs without the session's environment: the version sits next to the script.
version_file = os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), "version")
VERSION = open(version_file).read().strip() if os.path.exists(version_file) else "1.5.14"
if args[:1] == ["--version"]:
    print(VERSION); sys.exit(0)
log_dir = os.environ["FAKE_AGY_LOG"]
if args[:1] == ["models"]:
    print("Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)"); sys.exit(0)
with open(os.path.join(log_dir, "calls.jsonl"), "a") as f:
    f.write(json.dumps({"argv": args, "mcp_url": os.environ.get("KYBERN_MCP_URL"), "mcp_auth": os.environ.get("KYBERN_MCP_AUTHORIZATION")}) + "\n")
if args[:1] != ["acp"]:
    sys.stdin.readline()
    print(json.dumps({"event": "init", "conversation_id": "print-1", "init": {"model": "gemini-3.8-flash-low"}}))
    print(json.dumps({"event": "step_update", "step_update": {"conversation_id": "print-1", "step_index": 1, "state": "DONE", "step_type": "agent_response", "text_delta": "from print"}}))
    print(json.dumps({"event": "result", "result": {"conversation_id": "print-1", "status": "SUCCESS", "response": "from print"}}))
    sys.exit(0)
starts = os.path.join(log_dir, "acp_starts")
count = int(open(starts).read()) if os.path.exists(starts) else 0
open(starts, "w").write(str(count + 1))
if os.environ.get("FAKE_AGY_ACP_FAILS") or (os.environ.get("FAKE_AGY_SESSION_FAILS") and count >= 1):
    sys.stderr.write("agy: the ACP server could not start\n"); sys.exit(4)
log = open(os.path.join(log_dir, "received.jsonl"), "a")
def send(msg):
    msg["jsonrpc"] = "2.0"
    sys.stdout.write(json.dumps(msg) + "\n"); sys.stdout.flush()
def read():
    line = sys.stdin.readline()
    if not line:
        sys.exit(0)
    log.write(line); log.flush()
    return json.loads(line)
asked = [0]
def ask(method, params):
    asked[0] += 1
    rid = "agy-%d" % asked[0]
    send({"id": rid, "method": method, "params": params})
    while True:
        msg = read()
        if msg.get("id") == rid and "method" not in msg:
            return msg.get("result")
        handle(msg)
def update(sid, u):
    send({"method": "session/update", "params": {"sessionId": sid, "update": u}})
def chunk(sid, text):
    update(sid, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}})
USAGE = {"inputTokens": 100, "outputTokens": 20, "cachedReadTokens": 30, "cachedWriteTokens": 0, "thoughtTokens": 5, "totalTokens": 150}
def answer(mid, stop="end_turn"):
    send({"id": mid, "result": {"stopReason": stop, "usage": USAGE}})
def options(model="gemini-4-neon", level="high"):
    return [
        {"id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": model,
         "options": [{"value": "gemini-4-neon", "name": "Gemini 4 Neon"}, {"value": "gemini-3.8-flash", "name": "Gemini 3.8 Flash"}, {"value": "gpt-oss-120b-medium", "name": "GPT-OSS"}]},
        {"id": "thought_level", "name": "Thinking Level", "category": "thought_level", "type": "select", "currentValue": level,
         "options": [{"value": "low", "name": "Low"}, {"value": "medium", "name": "Medium"}, {"value": "high", "name": "High"}]}]
def modes():
    available = [{"id": "default", "name": "Default"}, {"id": "accept-edits", "name": "Accept edits"}, {"id": "plan", "name": "Plan"}]
    if not os.environ.get("FAKE_AGY_NO_AUTO"):
        available.append({"id": "auto", "name": "Auto"})
    return {"currentModeId": "default", "availableModes": available}
def steps(sid, rows):
    root = os.path.join(os.environ["HOME"], ".gemini", "antigravity-cli", "conversations")
    os.makedirs(root, exist_ok=True)
    db = sqlite3.connect(os.path.join(root, sid + ".db"))
    db.execute("CREATE TABLE IF NOT EXISTS steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, step_payload blob)")
    start = db.execute("SELECT coalesce(max(idx), -1) + 1 FROM steps").fetchone()[0]
    for offset, (kind, payload) in enumerate(rows):
        db.execute("INSERT INTO steps VALUES (?, ?, ?)", (start + offset, kind, payload))
    db.commit(); db.close()
def tool(sid, cid, name, kind, title, raw, status="in_progress", locations=None):
    u = {"sessionUpdate": "tool_call", "toolCallId": cid, "name": name, "args": raw, "status": status, "kind": kind, "title": title, "rawInput": raw}
    if locations:
        u["locations"] = locations
    update(sid, u)
def done(sid, cid, name, raw_output, status="completed"):
    update(sid, {"sessionUpdate": "tool_call_update", "toolCallId": cid, "name": name, "status": status, "rawOutput": raw_output})
def permission(sid, cid, name, kind, title, raw, locations=None):
    call = {"toolCallId": cid, "name": name, "kind": kind, "title": title, "rawInput": raw, "status": "pending"}
    if locations:
        call["locations"] = locations
    result = ask("session/request_permission", {"sessionId": sid, "toolCall": call,
        "options": [{"optionId": "allow", "name": "Allow", "kind": "allow_once"}, {"optionId": "deny", "name": "Deny", "kind": "reject_once"}]})
    return (result or {}).get("outcome", {}).get("optionId")
steering = [None]
def prompt(mid, sid, text):
    if steering[0] is not None:
        # The running prompt answers at once; this one carries the turn on.
        answer(steering[0]); steering[0] = None
    if text == "steer":
        chunk(sid, "working"); steering[0] = mid; return
    if text == "tool":
        tool(sid, "c1", "run_command", "execute", "cat a.txt", {"CommandLine": "cat a.txt"}, status="pending")
        if permission(sid, "c1", "run_command", "execute", "cat a.txt", {"CommandLine": "cat a.txt"}) == "allow":
            done(sid, "c1", "run_command", {"output": "Command exited with code 0.\n\nCommand output:\nhello\n", "exit_code": 0})
        else:
            done(sid, "c1", "run_command", {}, status="failed")
    elif text == "edit_inside":
        path = os.path.join(os.getcwd(), "b.txt")
        raw = {"Path": path, "Content": "ok\n"}
        tool(sid, "c2", "write_file", "edit", "File b.txt", raw, status="pending", locations=[{"path": path}])
        permission(sid, "c2", "write_file", "edit", "File b.txt", raw, locations=[{"path": path}])
        done(sid, "c2", "write_file", {})
    elif text == "mcp":
        cache = os.path.join(os.environ["HOME"], ".gemini/antigravity-cli/mcp/kybern/kybern_thread_read.json")
        tool(sid, "c3", "view_file", "read", "Read schema", {"AbsolutePath": cache})
        done(sid, "c3", "view_file", {"output": "{}"})
        raw = {"ServerName": "kybern", "ToolName": "kybern_thread_read", "Arguments": "{\"thread_id\": \"t1\"}"}
        tool(sid, "c4", "call_mcp_tool", "other", "kybern_thread_read", raw)
        done(sid, "c4", "call_mcp_tool", {"output": "thread text"})
    elif text == "hold":
        tool(sid, "c5", "run_command", "execute", "sleep 1", {"CommandLine": "sleep 1", "WaitMsBeforeAsync": 10})
        update(sid, {"sessionUpdate": "usage_update", "used": 10, "size": 100})
        answer(mid)
        time.sleep(0.4)
        done(sid, "c5", "run_command", {"output": "Command exited with code 0.\n", "exit_code": 0})
        chunk(sid, "background done")
        update(sid, {"sessionUpdate": "usage_update", "used": 20, "size": 100})
        return
    elif text == "background":
        chunk(sid, "answered")
        update(sid, {"sessionUpdate": "usage_update", "used": 10, "size": 100})
        answer(mid)
        # Replies by itself once the test has seen the first turn end.
        wake = os.path.join(log_dir, "wake")
        while not os.path.exists(wake):
            time.sleep(0.02)
        chunk(sid, "woke up")
        update(sid, {"sessionUpdate": "usage_update", "used": 20, "size": 100})
        return
    elif text in ("slow", "slow_missed"):
        tool(sid, "c6", "run_command", "execute", "sleep 30", {"CommandLine": "sleep 30"})
        while True:
            msg = read()
            if msg.get("method") == "session/cancel":
                # `slow_missed` never reports the command's end.
                if text == "slow":
                    done(sid, "c6", "run_command", {}, status="failed")
                answer(mid, "cancelled"); return
            handle(msg)
    elif text == "late_error":
        # The warning first, its error step after it.
        chunk(sid, "\n\u26a0 the model call failed\n")
        steps(sid, [(15, b"\x00"), (17, b"\x0a\x12UNAVAILABLE (code 503): The service is currently unavailable.\x10")])
    elif text == "warn_then_answer":
        steps(sid, [(14, b"\x00"), (15, b"\x00")])
        chunk(sid, "\u26a0 Careful: ")
        chunk(sid, "the file is large.")
    elif text == "warn_only":
        steps(sid, [(14, b"\x00"), (15, b"\x00")])
        chunk(sid, "\u26a0 nothing to change")
    elif text == "refusal_text":
        chunk(sid, "\n\u26a0 Quota exhausted. quotaResetTimeStamp:2099-01-02T03:04:00Z reason:QUOTA_EXHAUSTED\n")
        answer(mid, "refusal"); return
    elif text == "refusal_step":
        steps(sid, [(17, b"\x0a\x12RESOURCE_EXHAUSTED quotaResetTimeStamp:2099-05-06T07:08:00Z\x10"), (14, b"\x00")])
        answer(mid, "refusal"); return
    elif text in ("error404_early", "error404_late", "signature"):
        if text == "error404_early":
            rows = [(17, b"\x0a\x12NOT_FOUND (code 404): Requested entity was not found.\x10")]
        elif text == "error404_late":
            rows = [(15, b"\x00"), (17, b"\x0a\x12NOT_FOUND (code 404): Requested entity was not found.\x10")]
        else:
            rows = [(15, b"\x00"), (17, b"\x0a messages.1.content.0: Invalid `signature` in `thinking` block\x10")]
        steps(sid, rows)
        chunk(sid, "Antigravity hit an error")
    elif text == "refusal":
        answer(mid, "refusal"); return
    elif text == "crash":
        chunk(sid, "about to crash"); sys.exit(3)
    elif text == "question":
        result = ask("session/request_permission", {"sessionId": sid,
            "toolCall": {"toolCallId": "interaction_1", "title": "Which layout?", "status": "pending"},
            "options": [{"optionId": "grid", "name": "Grid", "kind": "allow_once"}, {"optionId": "list", "name": "List", "kind": "allow_once"}]})
        chunk(sid, "picked " + str((result or {}).get("outcome", {}).get("optionId")))
    else:
        steps(sid, [(14, b"\x00"), (15, b"\x00")])
        chunk(sid, "new answer")
    answer(mid)
def handle(msg):
    method, mid, params = msg.get("method"), msg.get("id"), msg.get("params") or {}
    if method == "initialize":
        caps = {"loadSession": True, "promptCapabilities": {"image": True, "audio": False, "embeddedContext": True}}
        if not os.environ.get("FAKE_AGY_NO_APPEND"):
            caps["_meta"] = {"antigravity": {"tier": True, "systemPrompt": {"append": True}}}
        send({"id": mid, "result": {"protocolVersion": 1, "agentCapabilities": caps, "agentInfo": {"name": "Antigravity ACP Server", "version": VERSION}, "authMethods": []}})
    elif method == "session/new":
        send({"id": mid, "result": {"sessionId": "s-new", "modes": modes(), "configOptions": options()}})
    elif method == "session/load":
        sid = params["sessionId"]
        update(sid, {"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": "old question"}})
        chunk(sid, "old answer")
        send({"id": mid, "result": {"modes": modes(), "configOptions": options()}})
    elif method == "session/set_mode":
        send({"id": mid, "result": {}})
    elif method == "session/set_config_option":
        current = {"model": "gemini-4-neon", "thought_level": "high"}
        current[params["configId"]] = params["value"]
        send({"id": mid, "result": {"configOptions": options(current["model"], current["thought_level"])}})
    elif method == "session/prompt":
        text = "".join(block.get("text", "") for block in params["prompt"] if block.get("type") == "text")
        prompt(mid, params["sessionId"], text.split("\n")[-1])
    elif method == "session/cancel":
        pass
    elif mid is not None:
        send({"id": mid, "error": {"code": -32601, "message": "unknown " + str(method)}})
while True:
    handle(read())
"##;

#[cfg(unix)]
mod session {
    use super::*;
    use crate::antigravity::AntigravityDriver;
    use crate::{AgentDriver, ProbeContext};
    use tokio::sync::mpsc;

    struct Fake {
        root: tempfile::TempDir,
        binary: PathBuf,
    }

    impl Fake {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let binary = root.path().join("agy");
            kybern_protocol::process::write_executable(&binary, FAKE_AGY).unwrap();
            std::fs::create_dir_all(root.path().join("home")).unwrap();
            Self { root, binary }
        }

        fn config(&self, mode: PermissionMode, env: &[(&str, &str)]) -> SessionConfig {
            let mut vars: std::collections::HashMap<String, String> = env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
            vars.insert("FAKE_AGY_LOG".into(), self.root.path().display().to_string());
            vars.insert("HOME".into(), self.root.path().join("home").display().to_string());
            SessionConfig {
                cwd: self.root.path().into(),
                model: None,
                effort: None,
                permission_mode: mode,
                native_tool_bridge: None,
                resume_session_id: None,
                resume_lacks_instructions: false,
                fork: false,
                rewind: None,
                binary: Some(self.binary.clone()),
                env: vars,
                compaction: Default::default(),
            }
        }

        fn received(&self) -> Vec<Value> {
            std::fs::read_to_string(self.root.path().join("received.jsonl"))
                .unwrap_or_default()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect()
        }

        fn calls(&self) -> Vec<Value> {
            std::fs::read_to_string(self.root.path().join("calls.jsonl"))
                .unwrap_or_default()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect()
        }

        /// What Kybern answered to agy's own request `id`.
        fn reply(&self, id: &str) -> Value {
            self.received().into_iter().find(|msg| msg["id"] == id && msg.get("method").is_none()).expect("Kybern answered")["result"]
                .clone()
        }

        fn sent(&self, method: &str) -> Vec<Value> {
            self.received().into_iter().filter(|msg| msg["method"] == method).map(|msg| msg["params"].clone()).collect()
        }
    }

    async fn spawn(driver: &AntigravityDriver, config: SessionConfig) -> Result<crate::SpawnedSession> {
        // Another test's forked child can briefly hold the new script open (Linux ETXTBSY).
        let mut attempts = 0;
        loop {
            match tokio::time::timeout(Duration::from_secs(30), driver.spawn(config.clone())).await.expect("the session starts") {
                Err(DriverError::Io(error)) if error.kind() == std::io::ErrorKind::ExecutableFileBusy && attempts < 50 => {
                    attempts += 1;
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                result => return result,
            }
        }
    }

    /// Events up to the end of the next turn; every card is answered with `answer`.
    async fn turn(
        session: &dyn crate::AgentSession,
        events: &mut mpsc::Receiver<DriverEvent>,
        answer: &ApprovalDecision,
    ) -> Vec<DriverEvent> {
        let mut seen = Vec::new();
        loop {
            let event = tokio::time::timeout(Duration::from_secs(30), events.recv()).await.expect("the turn ends").expect("events open");
            if let DriverEvent::PermissionRequest { request_id, .. } = &event {
                session.respond_permission(request_id, answer).await.unwrap();
            }
            let done = matches!(event, DriverEvent::TurnCompleted { .. } | DriverEvent::TurnFailed { .. });
            seen.push(event);
            if done {
                return seen;
            }
        }
    }

    async fn send(session: &dyn crate::AgentSession, events: &mut mpsc::Receiver<DriverEvent>, text: &str) -> Vec<DriverEvent> {
        session.send_message("m", &UserMessage::text(text)).await.unwrap();
        turn(session, events, &ApprovalDecision::AllowOnce).await
    }

    fn end(events: &[DriverEvent]) -> &DriverEvent {
        events.last().unwrap()
    }

    fn texts(events: &[DriverEvent]) -> String {
        events
            .iter()
            .filter_map(|event| if let DriverEvent::TextDelta { delta, .. } = event { Some(delta.as_str()) } else { None })
            .collect()
    }

    fn cards(events: &[DriverEvent]) -> Vec<(String, Value)> {
        events
            .iter()
            .filter_map(|event| match event {
                DriverEvent::PermissionRequest { tool_name, input, .. } => Some((tool_name.clone(), input.clone())),
                _ => None,
            })
            .collect()
    }

    fn started(events: &[DriverEvent]) -> Vec<&ToolCall> {
        events.iter().filter_map(|event| if let DriverEvent::ToolStarted(call) = event { Some(call) } else { None }).collect()
    }

    #[tokio::test]
    async fn agy_1_5_runs_on_acp_and_takes_every_mode() {
        let fake = Fake::new();
        let driver = AntigravityDriver::default();
        let status = driver
            .probe_with_context(&ProbeContext {
                binary: Some(fake.binary.clone()),
                cwd: None,
                env: fake.config(PermissionMode::FullAccess, &[]).env.into_iter().collect(),
            })
            .await;
        assert!(status.available, "{:?}", status.unavailable_reason);
        assert_eq!(status.supported_permission_modes, PermissionMode::ALL.to_vec());
        assert!(PermissionMode::ALL.iter().all(|mode| driver.accepts_permission_mode(*mode)));
        let crate::SpawnedSession { session, mut events } = spawn(&driver, fake.config(PermissionMode::Supervised, &[])).await.unwrap();
        let first = send(&*session, &mut events, "hello").await;
        assert!(matches!(&first[0], DriverEvent::SessionBound { session_id, .. } if session_id == "s-new"), "{first:?}");
        assert_eq!(texts(&first), "new answer");
        // One check that `agy acp` initializes, then the session's own `agy acp`, which stays.
        let second = send(&*session, &mut events, "hello").await;
        assert!(matches!(end(&second), DriverEvent::TurnCompleted { stop_reason: StopReason::Completed, .. }));
        let acp: Vec<Value> = fake.calls().into_iter().filter(|call| call["argv"][0] == "acp").collect();
        assert_eq!(acp.len(), 2, "{acp:?}");
        assert_eq!(fake.sent("session/new").len(), 1, "one long-lived session");
        session.close().await.unwrap();
    }

    #[tokio::test]
    async fn an_older_agy_or_print_mode_keeps_the_print_driver() {
        for (version, env) in [("1.4.12", vec![]), ("1.5.14", vec![(crate::antigravity::PRINT_MODE_ENV, "1")])] {
            let fake = Fake::new();
            std::fs::write(fake.root.path().join("version"), version).unwrap();
            let driver = AntigravityDriver::default();
            let context = ProbeContext {
                binary: Some(fake.binary.clone()),
                cwd: None,
                env: fake.config(PermissionMode::FullAccess, &env).env.into_iter().collect(),
            };
            assert_eq!(driver.probe_with_context(&context).await.supported_permission_modes, vec![PermissionMode::FullAccess], "{version}");
            assert!(!driver.accepts_permission_mode(PermissionMode::Supervised));
            let crate::SpawnedSession { session, mut events } =
                spawn(&driver, fake.config(PermissionMode::FullAccess, &env)).await.unwrap();
            let turn = send(&*session, &mut events, "hello").await;
            assert_eq!(texts(&turn), "from print", "{version}");
            assert!(fake.calls().iter().all(|call| call["argv"][0] != "acp" || version == "1.5.14"), "{:?}", fake.calls());
            assert!(fake.sent("session/new").is_empty());
            let Err(error) = spawn(&driver, fake.config(PermissionMode::Supervised, &env)).await else { panic!("Supervised needs ACP") };
            assert!(error.to_string().contains("Full access"), "{error}");
        }
    }

    #[tokio::test]
    async fn an_acp_that_does_not_start_hands_full_access_to_print() {
        let fake = Fake::new();
        let driver = AntigravityDriver::default();
        let env = [("FAKE_AGY_SESSION_FAILS", "1")];
        let Err(error) = spawn(&driver, fake.config(PermissionMode::Supervised, &env)).await else { panic!("Supervised can't fall back") };
        let problem = crate::failure::classify_error(ProviderKind::Antigravity, &error).expect("a worded problem");
        assert_eq!(problem.title.as_deref(), Some("Antigravity didn't start"), "{error}");
        // Full access takes `-p` instead, and so does the next session.
        let fake = Fake::new();
        let driver = AntigravityDriver::default();
        let crate::SpawnedSession { session, mut events } = spawn(&driver, fake.config(PermissionMode::FullAccess, &env)).await.unwrap();
        assert_eq!(texts(&send(&*session, &mut events, "hello").await), "from print");
    }

    #[tokio::test]
    async fn supervised_asks_and_shows_the_call_as_print_names_it() {
        let fake = Fake::new();
        let driver = AntigravityDriver::default();
        let crate::SpawnedSession { session, events: mut rx } = spawn(&driver, fake.config(PermissionMode::Supervised, &[])).await.unwrap();
        let events = send(&*session, &mut rx, "tool").await;
        let shown = cards(&events);
        assert_eq!(shown.len(), 1, "{events:?}");
        assert_eq!(shown[0].0, "Bash");
        assert_eq!(shown[0].1["command"], "cat a.txt");
        assert_eq!(fake.reply("agy-1"), json!({"outcome": {"outcome": "selected", "optionId": "allow"}}));
        let calls = started(&events);
        assert_eq!((calls[0].name.as_str(), calls[0].input["command"].as_str()), ("Bash", Some("cat a.txt")));
        assert_eq!(calls[0].input["raw"]["CommandLine"], "cat a.txt");
        assert!(
            events.iter().any(
                |event| matches!(event, DriverEvent::ToolCompleted { output, is_error: false, .. } if output.as_str().unwrap().contains("hello"))
            )
        );
        let DriverEvent::TurnCompleted { usage, .. } = end(&events) else { panic!("{events:?}") };
        assert_eq!(*usage, Usage { input_tokens: 100, output_tokens: 20, cache_read_tokens: 30, cache_write_tokens: 0 });
        assert_eq!(fake.sent("session/set_mode")[0]["modeId"], "default");
        // A denial goes back as agy's own reject option.
        session.send_message("m", &UserMessage::text("tool")).await.unwrap();
        let denied = turn(&*session, &mut rx, &ApprovalDecision::Deny { reason: None }).await;
        assert!(denied.iter().any(|event| matches!(event, DriverEvent::ToolCompleted { is_error: true, .. })));
        assert_eq!(fake.reply("agy-2"), json!({"outcome": {"outcome": "selected", "optionId": "deny"}}));
        session.close().await.unwrap();
    }

    #[tokio::test]
    async fn full_access_and_accept_edits_answer_without_a_card_where_they_should() {
        let fake = Fake::new();
        let driver = AntigravityDriver::default();
        let crate::SpawnedSession { session, events: mut rx } = spawn(&driver, fake.config(PermissionMode::FullAccess, &[])).await.unwrap();
        let events = send(&*session, &mut rx, "tool").await;
        assert!(cards(&events).is_empty(), "{events:?}");
        assert_eq!(fake.reply("agy-1"), json!({"outcome": {"outcome": "selected", "optionId": "allow"}}));
        session.close().await.unwrap();

        let fake = Fake::new();
        let crate::SpawnedSession { session, events: mut rx } =
            spawn(&driver, fake.config(PermissionMode::AcceptEdits, &[])).await.unwrap();
        // An edit inside the workspace is allowed by the shared path check; a command still asks.
        let edit = send(&*session, &mut rx, "edit_inside").await;
        assert!(cards(&edit).is_empty(), "{edit:?}");
        assert_eq!(fake.reply("agy-1"), json!({"outcome": {"outcome": "selected", "optionId": "allow"}}));
        let command = send(&*session, &mut rx, "tool").await;
        assert_eq!(cards(&command).len(), 1);
        // A live switch to Full access follows at once.
        session.set_permission_mode(PermissionMode::FullAccess).await.unwrap();
        assert!(cards(&send(&*session, &mut rx, "tool").await).is_empty());
        session.close().await.unwrap();
    }

    #[tokio::test]
    async fn auto_runs_agys_own_review_only_when_the_session_offers_it() {
        for (env, mode) in [(vec![], "auto"), (vec![("FAKE_AGY_NO_AUTO", "1")], "default")] {
            let fake = Fake::new();
            let driver = AntigravityDriver::default();
            let crate::SpawnedSession { session, events: mut rx } = spawn(&driver, fake.config(PermissionMode::Auto, &env)).await.unwrap();
            // What agy's review sends on reaches the user.
            assert_eq!(cards(&send(&*session, &mut rx, "tool").await).len(), 1);
            assert_eq!(fake.sent("session/set_mode")[0]["modeId"], mode);
            session.close().await.unwrap();
        }
    }

    fn bridge(guide: &str) -> NativeToolBridge {
        NativeToolBridge {
            server_name: "kybern".into(),
            endpoint: Some("http://127.0.0.1:4199/native-tools/mcp".into()),
            authorization: Some("secret-capability".into()),
            coordinator_instructions: None,
            guide: Some(guide.into()),
            tools: vec![],
            restrictions: Default::default(),
        }
    }

    #[tokio::test]
    async fn the_guide_goes_in_the_system_prompt_once_and_the_bridge_only_in_the_environment() {
        let fake = Fake::new();
        let driver = AntigravityDriver::default();
        let mut config = fake.config(PermissionMode::FullAccess, &[]);
        config.native_tool_bridge = Some(bridge("GUIDE TEXT"));
        let crate::SpawnedSession { session, events: mut rx } = spawn(&driver, config).await.unwrap();
        send(&*session, &mut rx, "hello").await;
        let new = &fake.sent("session/new")[0];
        assert_eq!(new["_meta"]["antigravity"]["systemPrompt"]["append"], "GUIDE TEXT");
        assert_eq!(new["mcpServers"], json!([]), "Kybern's tools come through the global bridge entry");
        assert_eq!(fake.sent("session/prompt")[0]["prompt"][0]["text"], "hello", "never on a prompt as well");
        let session_call = fake.calls().into_iter().rfind(|call| call["argv"][0] == "acp").unwrap();
        assert_eq!(session_call["mcp_url"], "http://127.0.0.1:4199/native-tools/mcp");
        assert_eq!(session_call["mcp_auth"], "secret-capability");
        assert!(!session_call["argv"].to_string().contains("secret-capability"));
        session.close().await.unwrap();

        // Without the system prompt, it rides on the first ordinary prompt, once.
        let fake = Fake::new();
        let mut config = fake.config(PermissionMode::FullAccess, &[("FAKE_AGY_NO_APPEND", "1")]);
        config.native_tool_bridge = Some(bridge("GUIDE TEXT"));
        let crate::SpawnedSession { session, events: mut rx } = spawn(&driver, config).await.unwrap();
        send(&*session, &mut rx, "hello").await;
        send(&*session, &mut rx, "hello").await;
        let prompts = fake.sent("session/prompt");
        let first = prompts[0]["prompt"][0]["text"].as_str().unwrap();
        assert!(first.starts_with("<kybern_instructions>\nGUIDE TEXT\n</kybern_instructions>"), "{first}");
        assert_eq!(prompts[1]["prompt"][0]["text"], "hello");
        assert!(fake.sent("session/new")[0].get("_meta").is_none_or(Value::is_null));
        session.close().await.unwrap();

        // A resumed conversation that lacks the guide gets it on its next prompt.
        let fake = Fake::new();
        let mut config = fake.config(PermissionMode::FullAccess, &[]);
        config.native_tool_bridge = Some(bridge("GUIDE TEXT"));
        config.resume_session_id = Some("s-old".into());
        config.resume_lacks_instructions = true;
        let crate::SpawnedSession { session, events: mut rx } = spawn(&driver, config).await.unwrap();
        let resumed = send(&*session, &mut rx, "hello").await;
        assert!(!texts(&resumed).contains("old answer"), "the replay is history");
        assert_eq!(fake.sent("session/load")[0]["sessionId"], "s-old");
        assert!(fake.sent("session/prompt")[0]["prompt"][0]["text"].as_str().unwrap().contains("GUIDE TEXT"));
        session.close().await.unwrap();
    }

    #[tokio::test]
    async fn the_model_and_effort_go_through_config_options_and_switches_wait_for_the_next_prompt() {
        let fake = Fake::new();
        let driver = AntigravityDriver::default();
        let mut config = fake.config(PermissionMode::FullAccess, &[]);
        config.model = Some("gemini-3.8-flash-high".into());
        config.effort = Some("low".into());
        let crate::SpawnedSession { session, events: mut rx } = spawn(&driver, config).await.unwrap();
        let first = send(&*session, &mut rx, "hello").await;
        assert!(
            first
                .iter()
                .any(|event| matches!(event, DriverEvent::SessionBound { model: Some(model), .. } if model == "gemini-3.8-flash-low")),
            "{first:?}"
        );
        let writes = |fake: &Fake| -> Vec<(String, String)> {
            fake.sent("session/set_config_option")
                .iter()
                .map(|params| (params["configId"].as_str().unwrap().to_string(), params["value"].as_str().unwrap().to_string()))
                .collect()
        };
        assert_eq!(writes(&fake), [("model".to_string(), "gemini-3.8-flash".to_string()), ("thought_level".into(), "low".into())]);
        session.set_model("gpt-oss-120b-medium").await.unwrap();
        assert_eq!(writes(&fake).len(), 2, "nothing is sent until the next prompt");
        let second = send(&*session, &mut rx, "hello").await;
        assert_eq!(writes(&fake)[2], ("model".to_string(), "gpt-oss-120b-medium".to_string()));
        assert!(
            second
                .iter()
                .any(|event| matches!(event, DriverEvent::SessionBound { model: Some(model), .. } if model == "gpt-oss-120b-medium"))
        );
        session.close().await.unwrap();
    }

    #[tokio::test]
    async fn mcp_calls_read_as_their_tool_and_schema_reads_stay_hidden() {
        let fake = Fake::new();
        let driver = AntigravityDriver::default();
        let crate::SpawnedSession { session, events: mut rx } = spawn(&driver, fake.config(PermissionMode::FullAccess, &[])).await.unwrap();
        let events = send(&*session, &mut rx, "mcp").await;
        let calls = started(&events);
        assert_eq!(calls.len(), 1, "{calls:?}");
        assert_eq!(calls[0].name, "mcp__kybern__kybern_thread_read");
        assert_eq!(calls[0].input["thread_id"], "t1");
        let done: Vec<&str> = events
            .iter()
            .filter_map(
                |event| if let DriverEvent::ToolCompleted { tool_call_id, .. } = event { Some(tool_call_id.as_str()) } else { None },
            )
            .collect();
        assert_eq!(done, ["c4"]);
        session.close().await.unwrap();
    }

    #[tokio::test]
    async fn a_command_that_outlives_its_prompt_holds_the_turn_until_agys_reply_to_it() {
        let fake = Fake::new();
        let driver = AntigravityDriver::default();
        let crate::SpawnedSession { session, events: mut rx } = spawn(&driver, fake.config(PermissionMode::FullAccess, &[])).await.unwrap();
        let events = send(&*session, &mut rx, "hold").await;
        let reply = events.iter().position(|event| matches!(event, DriverEvent::TextDelta { delta, .. } if delta == "background done"));
        let completed = events.iter().position(|event| matches!(event, DriverEvent::ToolCompleted { .. }));
        assert!(reply.is_some() && completed.is_some(), "the turn stayed open for the command and agy's reply: {events:?}");
        let DriverEvent::TurnCompleted { stop_reason: StopReason::Completed, usage, .. } = end(&events) else { panic!("{events:?}") };
        assert_eq!(usage.input_tokens, 100);
        session.close().await.unwrap();
    }

    #[tokio::test]
    async fn a_reply_agy_starts_by_itself_is_a_turn_of_its_own() {
        let fake = Fake::new();
        let driver = AntigravityDriver::default();
        let crate::SpawnedSession { session, events: mut rx } = spawn(&driver, fake.config(PermissionMode::FullAccess, &[])).await.unwrap();
        let first = send(&*session, &mut rx, "background").await;
        assert_eq!(texts(&first), "answered");
        // agy replies by itself once the first turn has ended.
        std::fs::write(fake.root.path().join("wake"), "").unwrap();
        let woke = turn(&*session, &mut rx, &ApprovalDecision::AllowOnce).await;
        assert!(matches!(woke[0], DriverEvent::ResponseStarted), "{woke:?}");
        assert_eq!(texts(&woke), "woke up");
        assert!(matches!(end(&woke), DriverEvent::TurnCompleted { stop_reason: StopReason::Completed, .. }));
        // The next message is an ordinary turn again.
        assert_eq!(texts(&send(&*session, &mut rx, "hello").await), "new answer");
        session.close().await.unwrap();
    }

    #[tokio::test]
    async fn a_steer_carries_the_turn_on_and_both_prompts_count() {
        let fake = Fake::new();
        let driver = AntigravityDriver::default();
        let crate::SpawnedSession { session, events: mut rx } = spawn(&driver, fake.config(PermissionMode::FullAccess, &[])).await.unwrap();
        session.send_message("m1", &UserMessage::text("steer")).await.unwrap();
        // Wait for the first prompt's output, then steer.
        loop {
            let event = tokio::time::timeout(Duration::from_secs(30), rx.recv()).await.unwrap().unwrap();
            if matches!(&event, DriverEvent::TextDelta { delta, .. } if delta == "working") {
                break;
            }
        }
        session.steer("m2", &UserMessage::text("hello")).await.unwrap();
        let events = turn(&*session, &mut rx, &ApprovalDecision::AllowOnce).await;
        assert_eq!(texts(&events), "new answer");
        let DriverEvent::TurnCompleted { usage, .. } = end(&events) else { panic!("{events:?}") };
        assert_eq!(usage.input_tokens, 200, "the steered prompt's usage counts too");
        session.close().await.unwrap();
    }

    #[tokio::test]
    async fn stop_cancels_the_prompt_and_its_command() {
        let fake = Fake::new();
        let driver = AntigravityDriver::default();
        let crate::SpawnedSession { session, events: mut rx } = spawn(&driver, fake.config(PermissionMode::FullAccess, &[])).await.unwrap();
        session.send_message("m1", &UserMessage::text("slow")).await.unwrap();
        loop {
            let event = tokio::time::timeout(Duration::from_secs(30), rx.recv()).await.unwrap().unwrap();
            if matches!(event, DriverEvent::ToolStarted(_)) {
                break;
            }
        }
        session.interrupt().await.unwrap();
        let events = turn(&*session, &mut rx, &ApprovalDecision::AllowOnce).await;
        assert!(matches!(end(&events), DriverEvent::TurnCompleted { stop_reason: StopReason::Interrupted, .. }), "{events:?}");
        assert!(events.iter().any(|event| matches!(event, DriverEvent::ToolCompleted { is_error: true, .. })));
        assert_eq!(fake.sent("session/cancel").len(), 1);
        // The session goes on.
        assert_eq!(texts(&send(&*session, &mut rx, "hello").await), "new answer");
        session.close().await.unwrap();
    }

    fn failure(event: &DriverEvent) -> &kybern_protocol::rpc::Problem {
        let DriverEvent::TurnFailed { problem: Some(problem), .. } = event else { panic!("{event:?}") };
        problem
    }

    #[tokio::test]
    async fn agys_recorded_errors_fail_the_turn_as_print_words_them() {
        let fake = Fake::new();
        let driver = AntigravityDriver::default();
        let crate::SpawnedSession { session, events: mut rx } = spawn(&driver, fake.config(PermissionMode::FullAccess, &[])).await.unwrap();
        // A 404 before the model answered: the model can't be used.
        let early = send(&*session, &mut rx, "error404_early").await;
        assert_eq!(texts(&early), "", "the error's own text shows once, as the failure: {early:?}");
        let problem = failure(end(&early));
        assert_eq!(problem.kind, ProblemKind::NotFound);
        assert_eq!(problem.action.as_ref().map(|action| action.id.as_str()), Some("choose_model"));
        // After it answered: a temporary error, Try again.
        let late = send(&*session, &mut rx, "error404_late").await;
        let problem = failure(end(&late));
        assert_eq!(problem.title.as_deref(), Some("Antigravity hit a temporary error"));
        // A poisoned thinking signature names itself, so the daemon's recovery takes over.
        let poisoned = send(&*session, &mut rx, "signature").await;
        let DriverEvent::TurnFailed { error, problem } = end(&poisoned) else { panic!() };
        assert!(
            crate::antigravity::is_invalid_thinking_signature(error)
                || problem.as_ref().and_then(|p| p.detail.as_deref()).is_some_and(crate::antigravity::is_invalid_thinking_signature),
            "{error} {problem:?}"
        );
        // An exhausted quota.
        let quota = send(&*session, &mut rx, "refusal").await;
        assert_eq!(failure(end(&quota)).kind, ProblemKind::Permission);
        // And a clean turn is clean again.
        assert!(matches!(end(&send(&*session, &mut rx, "hello").await), DriverEvent::TurnCompleted { .. }));
        session.close().await.unwrap();
    }

    #[tokio::test]
    async fn an_error_agy_reports_as_text_shows_once_and_a_warning_that_isnt_one_still_shows() {
        let fake = Fake::new();
        let driver = AntigravityDriver::default();
        let crate::SpawnedSession { session, events: mut rx } = spawn(&driver, fake.config(PermissionMode::FullAccess, &[])).await.unwrap();
        // The error step before its text (as agy 1.5.14 records it), and after it.
        for scenario in ["error404_late", "late_error"] {
            let events = send(&*session, &mut rx, scenario).await;
            assert!(matches!(end(&events), DriverEvent::TurnFailed { .. }), "{scenario}: {events:?}");
            assert_eq!(texts(&events), "", "{scenario}: no assistant text next to the failure");
        }
        // A warning-shaped answer is the answer: shown in its place, or at the turn's end.
        assert_eq!(texts(&send(&*session, &mut rx, "warn_then_answer").await), "\u{26a0} Careful: the file is large.");
        let only = send(&*session, &mut rx, "warn_only").await;
        assert_eq!(texts(&only), "\u{26a0} nothing to change");
        assert!(matches!(end(&only), DriverEvent::TurnCompleted { stop_reason: StopReason::Completed, .. }), "{only:?}");
        assert_eq!(texts(&send(&*session, &mut rx, "hello").await), "new answer");
        session.close().await.unwrap();
    }

    #[tokio::test]
    async fn an_exhausted_quota_says_when_it_resets() {
        let fake = Fake::new();
        let driver = AntigravityDriver::default();
        let crate::SpawnedSession { session, events: mut rx } = spawn(&driver, fake.config(PermissionMode::FullAccess, &[])).await.unwrap();
        // From the words agy sends with its refusal, or from the error step it recorded before others.
        for (scenario, reset) in [("refusal_text", "2099-01-02 03:04 UTC"), ("refusal_step", "2099-05-06 07:08 UTC")] {
            let events = send(&*session, &mut rx, scenario).await;
            let problem = failure(end(&events));
            assert_eq!((problem.kind, problem.subject.as_deref()), (ProblemKind::Permission, Some("rate_limit")), "{scenario}");
            let hint = problem.hint.as_deref().unwrap_or_default();
            assert!(hint.starts_with(&format!("Your limit resets at {reset}.")), "{scenario}: {hint}");
            assert_eq!(texts(&events), "", "{scenario}");
        }
        session.close().await.unwrap();
    }

    #[tokio::test]
    async fn a_command_whose_end_never_came_does_not_hold_the_next_turn() {
        let fake = Fake::new();
        let driver = AntigravityDriver::default();
        let crate::SpawnedSession { session, events: mut rx } = spawn(&driver, fake.config(PermissionMode::FullAccess, &[])).await.unwrap();
        session.send_message("m1", &UserMessage::text("slow_missed")).await.unwrap();
        loop {
            let event = tokio::time::timeout(Duration::from_secs(30), rx.recv()).await.unwrap().unwrap();
            if matches!(event, DriverEvent::ToolStarted(_)) {
                break;
            }
        }
        session.interrupt().await.unwrap();
        let stopped = turn(&*session, &mut rx, &ApprovalDecision::AllowOnce).await;
        assert!(matches!(end(&stopped), DriverEvent::TurnCompleted { stop_reason: StopReason::Interrupted, .. }), "{stopped:?}");
        // agy never said the command ended; the next turn still ends with its answer.
        let next = send(&*session, &mut rx, "hello").await;
        assert_eq!(texts(&next), "new answer");
        assert!(matches!(end(&next), DriverEvent::TurnCompleted { stop_reason: StopReason::Completed, .. }));
        session.close().await.unwrap();
    }

    fn acp_starts(fake: &Fake) -> usize {
        std::fs::read_to_string(fake.root.path().join("acp_starts")).map_or(0, |count| count.trim().parse().unwrap())
    }

    fn refusal(driver: &AntigravityDriver, mode: PermissionMode) -> Option<kybern_protocol::rpc::Problem> {
        driver.permission_mode_refusal(mode).map(|error| crate::failure::classify_error(ProviderKind::Antigravity, &error).unwrap())
    }

    #[tokio::test]
    async fn a_failed_acp_check_is_retried_for_a_mode_only_acp_runs_and_for_a_new_agy_version() {
        let fake = Fake::new();
        let driver = AntigravityDriver::default();
        // Before any check (a daemon that just started), the session's start decides.
        assert!(refusal(&driver, PermissionMode::Supervised).is_none());
        let broken = [("FAKE_AGY_ACP_FAILS", "1")];
        let crate::SpawnedSession { session, mut events } = spawn(&driver, fake.config(PermissionMode::FullAccess, &broken)).await.unwrap();
        assert_eq!(texts(&send(&*session, &mut events, "hello").await), "from print");
        let problem = refusal(&driver, PermissionMode::Supervised).expect("refused for now");
        assert_eq!(problem.title.as_deref(), Some("Antigravity couldn't start in this permission mode"));
        assert_eq!(problem.action.as_ref().map(|action| action.id.as_str()), Some("retry"));
        assert!(refusal(&driver, PermissionMode::FullAccess).is_none());

        // Working again at the same version: Full access stays on `-p` for a while without checking again…
        let checks = acp_starts(&fake);
        let crate::SpawnedSession { session, mut events } = spawn(&driver, fake.config(PermissionMode::FullAccess, &[])).await.unwrap();
        assert_eq!(texts(&send(&*session, &mut events, "hello").await), "from print");
        assert_eq!(acp_starts(&fake), checks, "the failure holds for a while");
        // …but a mode only ACP runs checks again at once.
        let crate::SpawnedSession { session, mut events } = spawn(&driver, fake.config(PermissionMode::Supervised, &[])).await.unwrap();
        assert_eq!(texts(&send(&*session, &mut events, "hello").await), "new answer");
        assert!(refusal(&driver, PermissionMode::Supervised).is_none());
        session.close().await.unwrap();

        // A launcher that doesn't change on disk when agy updates: the new version is checked again.
        let fake = Fake::new();
        let driver = AntigravityDriver::default();
        let crate::SpawnedSession { session, mut events } = spawn(&driver, fake.config(PermissionMode::FullAccess, &broken)).await.unwrap();
        assert_eq!(texts(&send(&*session, &mut events, "hello").await), "from print");
        std::fs::write(fake.root.path().join("version"), "1.5.15").unwrap();
        let crate::SpawnedSession { session, mut events } = spawn(&driver, fake.config(PermissionMode::FullAccess, &[])).await.unwrap();
        assert_eq!(texts(&send(&*session, &mut events, "hello").await), "new answer");
        session.close().await.unwrap();

        // An agy that's too old: update it.
        std::fs::write(fake.root.path().join("version"), "1.4.12").unwrap();
        let context = ProbeContext {
            binary: Some(fake.binary.clone()),
            cwd: None,
            env: fake.config(PermissionMode::FullAccess, &[]).env.into_iter().collect(),
        };
        driver.probe_with_context(&context).await;
        let problem = refusal(&driver, PermissionMode::AcceptEdits).expect("refused");
        assert_eq!(
            (problem.kind, problem.action.as_ref().map(|action| action.id.as_str())),
            (ProblemKind::UpdateNeeded, Some("update_agent"))
        );
        let Err(error) = spawn(&driver, fake.config(PermissionMode::AcceptEdits, &[])).await else { panic!("too old") };
        assert_eq!(
            crate::failure::classify_error(ProviderKind::Antigravity, &error).unwrap().title.as_deref(),
            Some("Update Antigravity to use this permission mode")
        );
    }

    #[tokio::test]
    async fn a_crash_mid_turn_fails_it_plainly_and_ends_the_session_for_a_respawn() {
        let fake = Fake::new();
        let driver = AntigravityDriver::default();
        let crate::SpawnedSession { session, events: mut rx } = spawn(&driver, fake.config(PermissionMode::FullAccess, &[])).await.unwrap();
        let events = send(&*session, &mut rx, "crash").await;
        let problem = failure(end(&events));
        assert_eq!(problem.title.as_deref(), Some("Antigravity stopped unexpectedly"), "{events:?}");
        let exited = tokio::time::timeout(Duration::from_secs(10), rx.recv()).await.expect("the session ends");
        assert!(matches!(exited, Some(DriverEvent::Exited { .. })), "{exited:?}");
        // The daemon's next send respawns it on the same conversation.
        let mut config = fake.config(PermissionMode::FullAccess, &[]);
        config.resume_session_id = Some("s-new".into());
        let crate::SpawnedSession { session, events: mut rx } = spawn(&driver, config).await.unwrap();
        assert_eq!(texts(&send(&*session, &mut rx, "hello").await), "new answer");
        session.close().await.unwrap();
    }

    #[tokio::test]
    async fn agys_own_question_is_a_question_card() {
        let fake = Fake::new();
        let driver = AntigravityDriver::default();
        // Even in Full access, Kybern never answers a question itself.
        let crate::SpawnedSession { session, events: mut rx } = spawn(&driver, fake.config(PermissionMode::FullAccess, &[])).await.unwrap();
        session.send_message("m", &UserMessage::text("question")).await.unwrap();
        let answer = ApprovalDecision::Submit { response: json!({"answers": {"Which layout?": "List"}}) };
        let events = turn(&*session, &mut rx, &answer).await;
        let shown = cards(&events);
        assert_eq!(shown[0].0, "AskUserQuestion");
        assert_eq!(shown[0].1["questions"][0]["options"][1]["label"], "List");
        assert_eq!(texts(&events), "picked list");
        session.close().await.unwrap();
    }
}
