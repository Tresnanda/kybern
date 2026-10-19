# Resume backdrop validation

Parked by explicit orchestrator request. No automatic waiter, app, scratch daemon,
build reservation, marker or queue line remains for this lane. The display briefly
returned at about 05:03Z, but no new build, capture or sample started before parking.

The candidate is **unproven**. Current addon SHA256 is
`07e2124ed4163c775372495763fb377ef575e7141dd0d60f659cda3253870f53`.
It passed the full updater and strict kernel images before the later shared native
display patch and point-bounds correction were added to source. The next run must
be a full rebuild, not `--finish-checks`.

From `/Users/mymac/projects/ade-gpuix-perf-backdrop/apps/gpuix`, after an explicit
resume and verification that the 2× built-in display is available:

```sh
swift /Users/mymac/projects/ade-gpuix-scratch/screen-state.swift
swift perf/backdrop/display-ready.swift
python3 perf/backdrop/build.py
bun perf/backdrop/quiet.ts bun perf/backdrop/final.ts details
bun perf/backdrop/quiet.ts bun perf/backdrop/final.ts
python3 perf/backdrop/summarize.py
```

Both probes must succeed: unlocked/awake and active built-in backing scale 2.
The wrappers handle the build marker/reservation, quiet order, UI leases,
scratch environments, per-window guards and scoped caffeinate. The first command
after the probes rebuilds and runs every native check, the strict kernel corpus,
production streaming captures, desktop-reference product pairs, accessibility
checks and headless WebKit materials reference. Product pairs always use
`--gpuix-only`; never launch Tauri.

`details` runs separate GPU traces for all four workloads, reverse-order
streaming, a moving broad-filter surface, actual settled-idle windows and an
original/candidate reverse-order check. The acceptance command runs the shared
streaming/thread-scroll/sidebar-scroll/explorer-scroll fixture, three 15-second
windows each after a 10-second warmup, for original/control/candidate addons.
Require matched 2× viewports and exactly zero idle submissions. Keep only a
measurable improvement; V1 numbers are rejected, archived under evidence `v1/`.

Already passed: pnpm typecheck, native tsc, backdrop harness tsc, 337 source tests
(0 failures, 6912 assertions), two scalar-kernel tests across 804 sigmas, and
16 GPU-image pairs (18,510,336 interior pixels; max channel delta 2/255;
zero pixels above 2). Fresh product comparisons and final acceptance are pending.

After acceptance, update `RESULTS.md` and the external report/manifest, record the
final addon SHA256 and all metrics, stop owned processes, remove owned scratch
data and disposable dependencies, and delete `native/build/target` and disposable
native upstream/test artifacts after checking open files. Those generated outputs
are retained for this parked resume (target 1.9 GiB; upstream 185 MiB; GPUIX modules
188 MiB; desktop modules 701 MiB). Keep the validated addon/webview bridge and the
unique original `backdrop-before.node` reference.

Full research, surface decisions, limitations and rejected experiments are in
`RESEARCH.md` and `RESULTS.md`. Evidence root:
`/Users/mymac/projects/ade/previews/gpuix/perf/backdrop/`.
