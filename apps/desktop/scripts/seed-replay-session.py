"""Only seed a runner-created scratch daemon, never production data."""
import json
from pathlib import Path
import sqlite3
import sys
root = Path(sys.argv[1]).resolve()
if root.name != "daemon" or not root.parent.name.startswith("kybern-rendering-"):
    raise ValueError("Expected the rendering runner's scratch daemon")
work = root.parent / "work"
work.mkdir(exist_ok=True)
with sqlite3.connect(root / "state.sqlite") as db:
    at = "2026-09-24T00:00:00Z"
    project = "10000000-0000-4000-8000-000000000001"
    thread = "20000000-0000-4000-8000-000000000001"
    db.execute("INSERT INTO projects(id,name,path,is_git,created_at,updated_at) VALUES (?,?,?,0,?,?)", (project, "Replay", str(work), at, at))
    db.execute("INSERT INTO threads(id,project_id,title,provider_kind,provider_instance,permission_mode,status,cwd,created_at,updated_at) VALUES (?,?,?,'claude-code','default','full-access','idle',?,?,?)", (thread, project, "Replayed session", str(work), at, at))
settings_path = root / "settings.json"
settings = json.loads(settings_path.read_text()) if settings_path.exists() else {}
settings.setdefault("providers", {})["claude-code"] = {"binary": str(Path(__file__).with_name("profile-replay-driver.py").resolve())}
settings_path.write_text(json.dumps(settings))
