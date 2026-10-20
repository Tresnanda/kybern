#!/usr/bin/env python3
"""Offline Claude-shaped scene driver for the motion audit's scratch daemon only.

The prompt picks a scene by keyword: SCENE_WORK (thinking, prose, tools, edit,
final markdown), SCENE_APPROVAL (waits on a Bash permission), SCENE_QUESTION
(AskUserQuestion), SCENE_LIVE (a long slow stream that stays running), SCENE_FAIL,
SCENE_SUBAGENT (a native Claude subagent that works for a while, then completes),
SCENE_DELEGATE (two kybern_agent_delegate calls, the delegation rows),
SCENE_LONG (a settled turn with a long answer: tables, code, a mermaid fence).
"""
import json, os, sys, threading, time, uuid

def emit(v):
    sys.stdout.write(json.dumps(v, ensure_ascii=False) + "\n"); sys.stdout.flush()

if "--version" in sys.argv: print("2.1.300 (motion audit fixture)"); sys.exit(0)
if "--help" in sys.argv: print("motion audit fixture"); sys.exit(0)
if "auth" in sys.argv: emit({"loggedIn": True, "authMethod": "fixture"}); sys.exit(0)

answers = {}
cond = threading.Condition()
SID = "motion-" + uuid.uuid4().hex[:8]

def wait_answer(rid, timeout=3600):
    with cond:
        cond.wait_for(lambda: rid in answers, timeout)
        return answers.get(rid)

def stream_text(mid, text, delay=0.04, index=0, kind="text"):
    emit({"type": "stream_event", "event": {"type": "content_block_start", "index": index, "content_block": {"type": kind, kind: ""}}})
    for w in text.split(" "):
        d = {"type": "thinking_delta", "thinking": w + " "} if kind == "thinking" else {"type": "text_delta", "text": w + " "}
        emit({"type": "stream_event", "event": {"type": "content_block_delta", "index": index, "delta": d}})
        time.sleep(delay)
    emit({"type": "stream_event", "event": {"type": "content_block_stop", "index": index}})

def assistant(mid, blocks):
    emit({"type": "assistant", "message": {"id": mid, "role": "assistant", "model": "claude-fixture", "content": blocks, "usage": {"input_tokens": 1200, "output_tokens": 300}}})

def tool(name, inp, out, delay=0.6, is_error=False):
    call = "toolu_" + uuid.uuid4().hex[:12]
    assistant("m_" + uuid.uuid4().hex[:8], [{"type": "tool_use", "id": call, "name": name, "input": inp}])
    time.sleep(delay)
    emit({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": call, "content": out, "is_error": is_error}]}})
    return call

def result(text, ms=8000):
    emit({"type": "result", "subtype": "success", "session_id": SID, "is_error": False, "result": text, "usage": {"input_tokens": 4200, "output_tokens": 900, "cache_read_input_tokens": 30000}, "duration_ms": ms, "total_cost_usd": 0.02})

FINAL = """Done. I tightened the retry loop and added a test.

## What changed

- `src/retry.ts` now backs off with jitter instead of a fixed 200 ms.
- `src/retry.test.ts` covers the cap and the jitter range.

| File | Change |
| --- | --- |
| `src/retry.ts` | backoff with jitter |
| `src/retry.test.ts` | new test |

```ts
export function backoff(attempt: number): number {
  const base = Math.min(2 ** attempt * 100, 5000)
  return base / 2 + Math.random() * (base / 2)
}
```

Run `pnpm test` to confirm."""

def scene_work(cwd):
    mid = "m_" + uuid.uuid4().hex[:8]
    emit({"type": "stream_event", "event": {"type": "message_start", "message": {"id": mid}}})
    stream_text(mid, "The user wants the retry loop fixed. I should read retry.ts first, then check the callers and add a jittered backoff with a test.", 0.03, 0, "thinking")
    stream_text(mid, "Let me look at the retry helper and its callers first.", 0.05, 1)
    assistant(mid, [{"type": "thinking", "thinking": "Plan the fix."}, {"type": "text", "text": "Let me look at the retry helper and its callers first."}])
    tool("Read", {"file_path": os.path.join(cwd, "src/retry.ts")}, "export function backoff(attempt: number) {\n  return 200\n}\n")
    tool("Grep", {"pattern": "backoff\\(", "path": cwd}, "src/client.ts:14: await sleep(backoff(i))\nsrc/queue.ts:31: delay = backoff(n)\n")
    tool("Bash", {"command": "pnpm test --filter retry", "description": "Run the retry tests"}, "> vitest run retry\n\n ✓ src/retry.test.ts (2)\n\nTest Files  1 passed (1)\n", 1.2)
    path = os.path.join(cwd, "src/retry.ts")
    try:
        with open(path, "w") as f:
            f.write("export function backoff(attempt: number): number {\n  const base = Math.min(2 ** attempt * 100, 5000)\n  return base / 2 + Math.random() * (base / 2)\n}\n")
        with open(os.path.join(cwd, "src/retry.test.ts"), "w") as f:
            f.write("import { backoff } from './retry'\n\ntest('caps at 5s', () => {\n  expect(backoff(20)).toBeLessThanOrEqual(5000)\n})\n")
    except OSError:
        pass
    tool("Edit", {"file_path": path, "old_string": "  return 200", "new_string": "  const base = Math.min(2 ** attempt * 100, 5000)\n  return base / 2 + Math.random() * (base / 2)"}, "The file has been updated.")
    tool("Write", {"file_path": os.path.join(cwd, "src/retry.test.ts"), "content": "test('caps at 5s')"}, "File created.")
    tool("TodoWrite", {"todos": [{"content": "Read retry helper", "status": "completed", "activeForm": "Reading"}, {"content": "Add jitter", "status": "completed", "activeForm": "Adding jitter"}, {"content": "Write test", "status": "completed", "activeForm": "Writing test"}]}, "Todos updated")
    m2 = "m_" + uuid.uuid4().hex[:8]
    emit({"type": "stream_event", "event": {"type": "message_start", "message": {"id": m2}}})
    stream_text(m2, FINAL, 0.02, 0)
    assistant(m2, [{"type": "text", "text": FINAL}])
    result(FINAL, 14000)

def scene_approval(cwd):
    mid = "m_" + uuid.uuid4().hex[:8]
    emit({"type": "stream_event", "event": {"type": "message_start", "message": {"id": mid}}})
    stream_text(mid, "I need to remove the generated build folder before rebuilding.", 0.05)
    assistant(mid, [{"type": "text", "text": "I need to remove the generated build folder before rebuilding."}])
    call = "toolu_" + uuid.uuid4().hex[:12]
    inp = {"command": "rm -rf dist && pnpm build", "description": "Clean and rebuild"}
    assistant("m_" + uuid.uuid4().hex[:8], [{"type": "tool_use", "id": call, "name": "Bash", "input": inp}])
    rid = "perm-" + uuid.uuid4().hex[:8]
    emit({"type": "control_request", "request_id": rid, "request": {"subtype": "can_use_tool", "tool_name": "Bash", "input": inp, "tool_use_id": call, "permission_suggestions": []}})
    ans = wait_answer(rid) or {}
    allowed = json.dumps(ans).find('"allow"') >= 0
    emit({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": call, "content": "built in 2.1s" if allowed else "Permission denied", "is_error": not allowed}]}})
    text = "Rebuilt cleanly." if allowed else "Skipped the rebuild because the command was denied."
    m2 = "m_" + uuid.uuid4().hex[:8]
    emit({"type": "stream_event", "event": {"type": "message_start", "message": {"id": m2}}})
    stream_text(m2, text, 0.05)
    assistant(m2, [{"type": "text", "text": text}])
    result(text)

def scene_question(cwd):
    rid = "q-" + uuid.uuid4().hex[:8]
    call = "toolu_" + uuid.uuid4().hex[:12]
    qs = [{"question": "Which storage should the cache use?", "header": "Storage", "multiSelect": False, "options": [{"label": "SQLite", "description": "One file, durable"}, {"label": "Memory", "description": "Fast, lost on restart"}]}]
    assistant("m_" + uuid.uuid4().hex[:8], [{"type": "tool_use", "id": call, "name": "AskUserQuestion", "input": {"questions": qs}}])
    emit({"type": "control_request", "request_id": rid, "request": {"subtype": "can_use_tool", "tool_name": "AskUserQuestion", "input": {"questions": qs}, "tool_use_id": call}})
    wait_answer(rid)
    emit({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": call, "content": "SQLite"}]}})
    result("Going with SQLite.")

def scene_live(cwd):
    mid = "m_" + uuid.uuid4().hex[:8]
    emit({"type": "stream_event", "event": {"type": "message_start", "message": {"id": mid}}})
    stream_text(mid, "Scanning the repository for slow queries and unindexed columns across every service before proposing changes.", 0.08, 0, "thinking")
    tool("Bash", {"command": "rg -n 'SELECT' services/", "description": "Find queries"}, "services/a.ts:12 SELECT * FROM jobs\n", 2.0)
    para = "The jobs table is scanned on every poll. " * 400
    stream_text(mid, para, 0.6, 1)
    result("done")

def scene_fail(cwd):
    tool("Bash", {"command": "pnpm lint", "description": "Lint"}, "error: 3 problems", 0.8, True)
    emit({"type": "result", "subtype": "error_during_execution", "session_id": SID, "is_error": True, "result": "API Error: 529 overloaded", "usage": {"input_tokens": 0, "output_tokens": 0}, "duration_ms": 1200, "total_cost_usd": 0})

def scene_subagent(cwd):
    mid = "m_" + uuid.uuid4().hex[:8]
    emit({"type": "stream_event", "event": {"type": "message_start", "message": {"id": mid}}})
    stream_text(mid, "I will hand the query audit to an explorer subagent.", 0.04)
    launch = "toolu_" + uuid.uuid4().hex[:12]
    task = "task-" + uuid.uuid4().hex[:8]
    assistant(mid, [{"type": "text", "text": "I will hand the query audit to an explorer subagent."},
                    {"type": "tool_use", "id": launch, "name": "Agent", "input": {"subagent_type": "Explore", "description": "Audit queries", "prompt": "Find slow queries in services/ and report them."}}])
    emit({"type": "system", "subtype": "task_started", "task_id": task, "tool_use_id": launch, "description": "Audit queries", "task_type": "local_agent", "prompt": "Find slow queries in services/ and report them."})
    time.sleep(1.5)
    child = "m_" + uuid.uuid4().hex[:8]
    emit({"type": "assistant", "parent_tool_use_id": launch, "message": {"id": child, "role": "assistant", "model": "claude-fixture", "content": [{"type": "text", "text": "Scanning services/ for unindexed lookups."}], "usage": {"input_tokens": 200, "output_tokens": 40}}})
    time.sleep(float(os.environ.get("SUBAGENT_SECONDS", "6")))
    emit({"type": "system", "subtype": "task_notification", "task_id": task, "tool_use_id": launch, "status": "completed", "summary": "Found 3 slow queries."})
    emit({"type": "user", "parent_tool_use_id": None, "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": launch, "content": "Found 3 slow queries."}]}})
    m2 = "m_" + uuid.uuid4().hex[:8]
    emit({"type": "stream_event", "event": {"type": "message_start", "message": {"id": m2}}})
    stream_text(m2, "The explorer found three slow queries.", 0.04)
    assistant(m2, [{"type": "text", "text": "The explorer found three slow queries."}])
    result("The explorer found three slow queries.")

def scene_delegate(cwd):
    mid = "m_" + uuid.uuid4().hex[:8]
    emit({"type": "stream_event", "event": {"type": "message_start", "message": {"id": mid}}})
    stream_text(mid, "I will split this into two delegated threads.", 0.04)
    assistant(mid, [{"type": "text", "text": "I will split this into two delegated threads."}])
    for n, (title, role) in enumerate((("Audit the retry loop", "research"), ("Write retry tests", "test"))):
        out = json.dumps({"task_id": "dt-%d" % n, "thread_id": str(uuid.uuid4()), "title": title, "provider": "claude-code", "workspace": "shared", "status": "running"})
        tool("mcp__kybern__kybern_agent_delegate", {"task": title + " in services/.", "title": title, "role": role, "provider": "claude-code"}, out, 0.4)
    m2 = "m_" + uuid.uuid4().hex[:8]
    emit({"type": "stream_event", "event": {"type": "message_start", "message": {"id": m2}}})
    stream_text(m2, "Both threads are running.", 0.04)
    assistant(m2, [{"type": "text", "text": "Both threads are running."}])
    result("Both threads are running.")

LONG = FINAL + """

## Notes

1. First item with `inline code` and a [link](https://example.com).
2. Second item.

> A quoted remark that wraps onto a second line so the block quote is exercised properly.

```mermaid
graph TD
  A[Send] --> B{Retry?}
  B -- yes --> C[Backoff]
  B -- no --> D[Done]
```

| Attempt | Delay |
| --- | --- |
| 1 | 100 ms |
| 2 | 200 ms |
"""

def scene_long(cwd):
    m2 = "m_" + uuid.uuid4().hex[:8]
    emit({"type": "stream_event", "event": {"type": "message_start", "message": {"id": m2}}})
    stream_text(m2, LONG, 0.01)
    assistant(m2, [{"type": "text", "text": LONG}])
    result(LONG)

def run(frame):
    cwd = os.getcwd()
    content = json.dumps(frame.get("message", {}), ensure_ascii=False)
    emit({"type": "system", "subtype": "init", "session_id": SID, "model": "claude-fixture", "tools": ["Read", "Bash", "Edit"]})
    for key, fn in (("SCENE_APPROVAL", scene_approval), ("SCENE_QUESTION", scene_question), ("SCENE_LIVE", scene_live), ("SCENE_FAIL", scene_fail), ("SCENE_SUBAGENT", scene_subagent), ("SCENE_DELEGATE", scene_delegate), ("SCENE_LONG", scene_long), ("SCENE_WORK", scene_work)):
        if key in content:
            return fn(cwd)
    mid = "m_" + uuid.uuid4().hex[:8]
    emit({"type": "stream_event", "event": {"type": "message_start", "message": {"id": mid}}})
    stream_text(mid, "Sure. Here is a short answer to that.", 0.05)
    assistant(mid, [{"type": "text", "text": "Sure. Here is a short answer to that."}])
    result("Sure. Here is a short answer to that.")

for line in sys.stdin:
    try:
        frame = json.loads(line)
    except ValueError:
        continue
    t = frame.get("type")
    if t == "control_request":
        emit({"type": "control_response", "response": {"subtype": "success", "request_id": frame.get("request_id"), "response": {}}})
    elif t == "control_response":
        r = frame.get("response", {})
        with cond:
            answers[r.get("request_id")] = r
            cond.notify_all()
    elif t == "user":
        threading.Thread(target=run, args=(frame,), daemon=True).start()
