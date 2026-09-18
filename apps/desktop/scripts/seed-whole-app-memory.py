#!/usr/bin/env python3
"""Prepare deterministic scratch data for the full Tauri memory workflow.

The target must be an initialized Kybern data directory below a `.scratch`
folder. Production data and credentials are never read or modified.
"""

from __future__ import annotations

import json
from pathlib import Path
import sqlite3
import subprocess
import sys


root = Path(sys.argv[1]).resolve()
if ".scratch" not in root.parts:
    raise ValueError("Use an isolated .scratch directory")
if subprocess.run(["git", "-C", str(root), "rev-parse", "--show-toplevel"], capture_output=True).returncode == 0:
    raise ValueError("Keep scratch data outside a Git worktree; checkpoints would include the benchmark database")

scripts = Path(__file__).resolve().parent
subprocess.run([sys.executable, scripts / "seed-memory-workload.py", root], check=True)

primary = "20000000-0000-4000-8000-000000000001"
secondary = "20000000-0000-4000-8000-000000000002"
with sqlite3.connect(root / "state.sqlite") as db:
    project = db.execute("SELECT project_id FROM threads WHERE id = ?", (primary,)).fetchone()[0]
    db.execute("UPDATE threads SET provider_kind = 'claude-code' WHERE id = ?", (primary,))
    db.execute(
        """INSERT INTO threads(
               id, project_id, title, provider_kind, provider_instance,
               permission_mode, status, cwd, created_at, updated_at
             ) VALUES (?, ?, ?, 'claude-code', 'default', 'supervised',
                       'idle', ?, ?, ?)""",
        (
            secondary,
            project,
            "Secondary memory view",
            str(root),
            "2026-09-18T00:00:00Z",
            "2026-09-18T00:00:00Z",
        ),
    )

settings_path = root / "settings.json"
settings = json.loads(settings_path.read_text()) if settings_path.exists() else {}
settings.setdefault("providers", {})["claude-code"] = {
    "binary": str((scripts / "profile-live-tools-driver.py").resolve())
}
settings_path.write_text(json.dumps(settings, indent=2) + "\n")

fixture_path = root / "fixture.json"
fixture = json.loads(fixture_path.read_text())
fixture.update({"primary_thread_id": primary, "secondary_thread_id": secondary})
fixture_path.write_text(json.dumps(fixture, indent=2) + "\n")
print(json.dumps(fixture))
