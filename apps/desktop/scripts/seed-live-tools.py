"""Only seed a runner-created scratch daemon, never production data."""
import json
from pathlib import Path
import sqlite3
import sys
import uuid
root = Path(sys.argv[1]).resolve()
seed_history = "--history" in sys.argv[2:]
if root.name != "daemon" or not root.parent.name.startswith("kybern-rendering-"):
    raise ValueError("Expected the rendering runner's scratch daemon")
with sqlite3.connect(root / "state.sqlite") as db:
    at = "2026-09-18T00:00:00Z"
    project = "10000000-0000-4000-8000-000000000001"
    thread = "20000000-0000-4000-8000-000000000001"
    db.execute("INSERT INTO projects(id,name,path,is_git,created_at,updated_at) VALUES (?,?,?,0,?,?)", (project, "Live tool memory", str(root), at, at))
    db.execute("INSERT INTO threads(id,project_id,title,provider_kind,provider_instance,permission_mode,status,cwd,created_at,updated_at) VALUES (?,?,?,'claude-code','default','supervised','idle',?,?,?)", (thread, project, "Live tool memory", str(root), at, at))
    if seed_history:
        seq = [0]
        def event(turn, kind, **payload):
            seq[0] += 1
            db.execute(
                "INSERT INTO events(seq,thread_id,turn_id,at,kind,payload) VALUES (?,?,?,?,?,?)",
                (seq[0], thread, turn, at, kind, json.dumps({"kind": kind, **payload}, ensure_ascii=False)),
            )
        for n in range(400):
            turn = str(uuid.UUID(int=10000 + n))
            message = str(uuid.UUID(int=20000 + n))
            event(turn, "turn_started", message_id=str(uuid.UUID(int=30000 + n)), message={"parts": [{"type": "text", "text": f"Review sanitized example {n}"}]})
            event(turn, "assistant_text_delta", message_id=message, delta="Inspecting files. ", origin={"kind": "root"})
            for k in range(2):
                call = f"tool-{n}-{k}"
                event(turn, "tool_call_started", call={"id": call, "name": "Read", "input": {"file_path": f"/example/file-{n}-{k}.ts"}}, origin={"kind": "root"})
                for _ in range(4):
                    event(turn, "tool_call_output_delta", tool_call_id=call, delta="progress é😀\n" * 256)
                event(turn, "tool_call_completed", tool_call_id=call, output={"stdout": f"file {n}-{k}\n" + 'const value = "é😀";\n' * 3000}, is_error=False)
            event(turn, "assistant_message_completed", message_id=message, origin={"kind": "root"}, text="Inspecting files. Finished.\n\n| Key | Value |\n| --- | --- |\n| Unicode | é😀 |", thinking=None)
            event(turn, "turn_completed", stop_reason="completed", usage={"input_tokens": 50, "output_tokens": 50}, cost_usd=None, duration_ms=100, terminal_message_id=message)
        db.execute("UPDATE threads SET last_seq=? WHERE id=?", (seq[0], thread))
    print(db.execute("SELECT value FROM meta WHERE key = 'environment_id'").fetchone()[0])
settings_path = root / "settings.json"
settings = json.loads(settings_path.read_text()) if settings_path.exists() else {}
settings.setdefault("providers", {})["claude-code"] = {"binary": str(Path(__file__).with_name("profile-live-tools-driver.py").resolve())}
settings_path.write_text(json.dumps(settings))
