"""Adds a long settled thread (N turns of tools, a table and code) to the scratch daemon.

  python3 seed-long.py <scratch data dir> [turns=150]

Creates the thread through the CLI, then appends events straight into the scratch SQLite
(WAL, safe while the scratch daemon runs). Reopen the thread in the app to load it. Refuses
any data dir that is not a scratch one.
"""
import json, sqlite3, subprocess, sys, uuid, os
data = os.path.realpath(sys.argv[1])
turns = int(sys.argv[2]) if len(sys.argv) > 2 else 150
if "scratch" not in data and "motion" not in data and "kybern-motion" not in data:
    raise SystemExit("refusing: not a scratch data dir")
cli = os.environ.get("KYBERN_CLI", "/Applications/kybern.app/Contents/MacOS/kybern")
project = os.path.join(data, "project")
out = subprocess.run([cli, "--data-dir", data, "new", "-p", project, "--mode", "full-access", "--detach", "Long thread for streaming and scroll measurements"], capture_output=True, text=True, check=True); out = out.stdout + out.stderr
thread = out.split()[-1]
import time; time.sleep(4)  # let the fixture's one-line answer finish
db = sqlite3.connect(os.path.join(data, "state.sqlite"), timeout=10)
db.execute("PRAGMA busy_timeout = 10000")
ins = db.cursor()
def ev(turn, at, kind, **payload):
    ins.execute("INSERT INTO events(thread_id, turn_id, at, kind, payload) VALUES (?,?,?,?,?)", (thread, turn, at, kind, json.dumps({"kind": kind, **payload}, ensure_ascii=False)))
ANSWER = "Inspected the module.\n\n| Key | Value |\n| --- | --- |\n| retries | 3 |\n| backoff | jitter |\n\n```ts\nexport function backoff(n: number) {\n  return Math.min(2 ** n * 100, 5000)\n}\n```\n\nDone."
for n in range(turns):
    turn = str(uuid.uuid4()); at = f"2026-10-19T10:{n // 60 % 60:02d}:{n % 60:02d}Z"
    ev(turn, at, "turn_started", message_id=str(uuid.uuid4()), message={"parts": [{"type": "text", "text": f"Review example {n}"}]})
    for k in range(2):
        call = f"tool-{n}-{k}"
        ev(turn, at, "tool_call_started", call={"id": call, "name": "Read", "input": {"file_path": f"/example/file-{n}-{k}.ts"}}, origin={"kind": "root"})
        ev(turn, at, "tool_call_completed", tool_call_id=call, output={"stdout": f"file {n}-{k}\n" + "const value = 1;\n" * 40}, is_error=False)
    mid = str(uuid.uuid4())
    ev(turn, at, "assistant_message_completed", message_id=mid, origin={"kind": "root"}, text=ANSWER, thinking=None)
    ev(turn, at, "turn_completed", stop_reason="completed", usage={"input_tokens": 50, "output_tokens": 50}, cost_usd=None, duration_ms=1000, terminal_message_id=mid)
ins.execute("UPDATE threads SET last_seq=(SELECT MAX(seq) FROM events WHERE thread_id=?) WHERE id=?", (thread, thread))
db.commit()
print(thread)
