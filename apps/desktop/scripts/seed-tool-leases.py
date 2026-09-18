"""Synthetic native regression data; only accepts a runner-created scratch path."""
import json
from pathlib import Path
import sqlite3
import sys

root = Path(sys.argv[1]).resolve()
if not root.name == "daemon" or not root.parent.name.startswith("kybern-rendering-"):
    raise ValueError("Expected the rendering runner's scratch daemon directory")
thread = "20000000-0000-4000-8000-000000000001"
project = "10000000-0000-4000-8000-000000000001"
turn = "30000000-0000-4000-8000-000000000001"
at = "2026-09-17T00:00:00Z"
with sqlite3.connect(root / "state.sqlite") as db:
    db.execute("INSERT INTO projects(id,name,path,is_git,created_at,updated_at) VALUES (?,?,?,0,?,?)", (project, "Native tool leases", str(root), at, at))
    db.execute("INSERT INTO threads(id,project_id,title,provider_kind,provider_instance,permission_mode,status,cwd,created_at,updated_at) VALUES (?,?,?,'codex','default','supervised','idle',?,?,?)", (thread, project, "Tool leases", str(root), at, at))
    seq = 0
    def event(kind, **fields):
        global seq
        seq += 1
        db.execute("INSERT INTO events(seq,thread_id,turn_id,at,kind,payload) VALUES (?,?,?,?,?,?)", (seq, thread, turn, at, kind, json.dumps(dict(kind=kind, **fields), ensure_ascii=False)))
    event("turn_started", message_id=turn, message={"parts": [{"type": "text", "text": "Inspect exact saved results"}]})
    event("tool_call_started", call={"id": "stream-lease", "name": "Read", "input": {"file_path": "/fixture/stream-lease.txt"}}, origin={"kind": "root"})
    event("tool_call_output_delta", tool_call_id="stream-lease", delta="Exact stream: é😀\n" + "stream content " * 350_000)
    event("tool_call_completed", tool_call_id="stream-lease", output=None, is_error=False)
    for index in range(16):
        call = f"lease-{index}"
        event("tool_call_started", call={"id": call, "name": "Read", "input": {"file_path": f"/fixture/lease-{index}.txt"}}, origin={"kind": "root"})
        event("tool_call_completed", tool_call_id=call, output=f"Exact result {index}: é😀\n" + "readable content " * 150, is_error=True)
    event("turn_completed", stop_reason="completed", usage={"input_tokens": 0, "output_tokens": 0}, cost_usd=None, duration_ms=100)
    db.execute("UPDATE threads SET last_seq=? WHERE id=?", (seq, thread))
    print(db.execute("SELECT value FROM meta WHERE key = 'environment_id'").fetchone()[0])
