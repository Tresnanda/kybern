# Stationary hover and selection audit

These checks drive the real native client against synthetic scratch data. They
never activate the window or post global mouse events. The controller's native
mouse API supplies scroll and pointer input; `input.m` supplies AppKit double
click counts and a real window resize using that same parked pointer.

Run from `apps/gpuix` with the orchestrator's hidden test display available.
The shared screen/window assertions, UI lease, build markers and quiet-window
rules in `BRIEF-HR5.md` remain required. Port 4342 belongs to this lane.

```sh
# Full native updater under exclusive build markers and bounded UI batches.
python3 perf/hover/build.py

# Cached virtual rows, layout reflow, retained transforms, opt-in text bodies,
# and zero idle frames. An older addon can be supplied with --baseline.
GPUIX_BACKGROUND=1 \
KYBERN_DATA_DIR=/Users/mymac/projects/ade-gpuix-scratch/hr5-hover-lab \
KYBERN_CLIENT_CONFIG_DIR=/Users/mymac/projects/ade-gpuix-scratch/hr5-hover-lab-client \
bun native/ui-lease.ts hr5-hover-lab bun native/hover-check.ts

# Nineteen real-app surfaces, both themes and motion modes, followed by the
# actual desktop frontend in headless WebKit. No Tauri window is launched.
GPUIX_BACKGROUND=1 \
VISUAL_SCRATCH=/Users/mymac/projects/ade-gpuix-scratch/hr5-hover-audit \
VISUAL_DAEMON_PORT=4342 bun perf/hover/suite.ts

# Existing task board/list and project drag checks on the old/current addon.
GPUIX_BACKGROUND=1 \
VISUAL_SCRATCH=/Users/mymac/projects/ade-gpuix-scratch/hr5-hover-drag \
VISUAL_DAEMON_PORT=4342 bun perf/hover/drag.ts

# Run the same invocation with the baseline addon before rebuilding, then the
# candidate after all audit helpers have stopped. Keep the dataset identical.
GPUIX_BACKGROUND=1 \
KYBERN_DATA_DIR=/Users/mymac/projects/ade-gpuix-scratch/hr5-hover-bench \
KYBERN_CLIENT_CONFIG_DIR=/Users/mymac/projects/ade-gpuix-scratch/hr5-hover-bench/client \
KYBERN_BENCH_PORT=4342 KYBERN_INPUT_FRAME_DRAW=1 \
KYBERN_BENCH_EVIDENCE=/Users/mymac/projects/ade/previews/gpuix/handson-r5/hover/bench \
bun perf/hover/quiet.ts bun perf/bench/run.ts sidebar-scroll thread-fling idle-home \
  --runs 2 --label hr5-hover-after --keep-data
```

`HR5_SCREENS`, `HR5_THEMES`, `HR5_MOTION`, `HR5_SKIP_NATIVE=1` and
`HR5_SKIP_DESKTOP=1` restrict an audit rerun. `HR5_BASELINE_ADDON` adds the three sidebar reproduction screens
using the base commit's sidebar/root/label sources before running the candidate.

Evidence is outside the worktree at
`/Users/mymac/projects/ade/previews/gpuix/handson-r5/hover/`. `report.py` requires
all 76 native and 76 desktop cases, checks the final native receipt and source
hashes, and emits a sanitized summary. Raw benchmark inventories stay outside
commits. `RESULTS.md` records scope, accepted checks, timings and limitations. When a
long-gap comparison varies materially, `bun perf/hover/quiet.ts bun
perf/hover/paired-bench.ts` runs the same two addons consecutively under one
quiet window; it requires the approved baseline at `native/build/prior-hover.node`
before cleanup. Initial valid timings remain in the evidence alongside the repeat.
