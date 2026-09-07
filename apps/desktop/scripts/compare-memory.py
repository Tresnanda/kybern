#!/usr/bin/env python3
"""Run unchanged isolated fixtures against two checkouts; never launch the installed app.
Copy perf/memory.{html,ts}, scripts/check-rendering.{mjs,swift} and the ignored
memory_broadcast_fixture test into the baseline first. Install its frontend deps.
Usage: python3 scripts/compare-memory.py /absolute/before /absolute/after
"""
import json
from pathlib import Path
import re
import statistics
import subprocess
import sys

before, after = [Path(value).resolve() for value in sys.argv[1:3]]
out = after / "apps/desktop/perf/memory-results"
out.mkdir(exist_ok=True)
for kind in ["renderer", "daemon"]:
    for run in range(1, 4):
        for label, root in [("before", before), ("after", after)]:
            filename = out / f"{label}-{kind}-{run}.log"
            print(f"Running {filename.name}", flush=True)
            command = ["node", "scripts/check-rendering.mjs", "memory"] if kind == "renderer" else ["cargo", "test", "-p", "kybern-daemon", "--lib", "memory_broadcast_fixture", "--", "--ignored", "--nocapture"]
            with filename.open("w") as log:
                subprocess.run(command, cwd=root / "apps/desktop" if kind == "renderer" else root, stdout=log, stderr=subprocess.STDOUT, check=True)
values = {}
raw = {}
for filename in out.glob("*.log"):
    label, kind, _ = filename.stem.split("-")
    raw[filename.stem] = []
    for line in filename.read_text().splitlines():
        if not line.startswith("{"):
            continue
        record = json.loads(line)
        raw[filename.stem].append(record)
        if "footprint" not in record:
            continue
        amount, unit = re.search(r"([0-9.]+)([KMG])", record["footprint"]).groups()
        mib = float(amount) * {"K": 1 / 1024, "M": 1, "G": 1024}[unit]
        values.setdefault(f"{kind}:{record['sample']}", {}).setdefault(label, []).append(mib)
summary = {key: {label: {"samplesMiB": samples, "medianMiB": statistics.median(samples)} for label, samples in data.items()} for key, data in values.items()}
(out / "samples.json").write_text(json.dumps(raw, indent=2) + "\n")
(out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps(summary, indent=2))
