# GPU submission cost

Run from `apps/gpuix` with a scratch daemon and the shared UI queue. The
helpers use port 4335 and `perf-gpu*` scratch paths. They never connect to the
user's normal data directory. Native compilation/checks own one build marker
for the entire updater, honor existing quiet/build reservations, and run at
low priority with four Cargo jobs. `build.py` routes legacy check captures into
this lane's external evidence folder and restores those source paths afterward.

```
python3 perf/gpu/build.py
KYBERN_DATA_DIR=/Users/mymac/projects/ade-gpuix-scratch/perf-gpu-bench \
KYBERN_CLIENT_CONFIG_DIR=/Users/mymac/projects/ade-gpuix-scratch/perf-gpu-bench/client \
KYBERN_BENCH_PORT=4335 KYBERN_FULL_RATE=1 KYBERN_BENCH_RPC_ONLY=1 \
KYBERN_MEMORY_COUNTERS=1 KYBERN_BENCH_COUNTERS=1 \
KYBERN_BENCH_EVIDENCE=/Users/mymac/projects/ade/previews/gpuix/perf/gpu \
bun perf/gpu/quiet.ts bun perf/gpu/measure.ts acceptance
bun native/ui-lease.ts perf-gpu-visual bun perf/gpu/visual.ts
bun perf/gpu/quiet.ts bun perf/gpu/measure.ts diagnosis
bun perf/gpu/quiet.ts bun perf/gpu/measure.ts followups
bun perf/gpu/quiet.ts bun perf/gpu/followups.ts
pnpm exec tsc -p perf/gpu/tsconfig.json
```

The shared suite is forced to its existing 120 Hz wheel RPC input so both sides
use exactly the same fractional-delta path. The separate `precise.ts` harness
uses `perf/explorer/wheel.m`: a background producer submits real process-local
AppKit NSEvents with fractional CGFloat deltas and independent momentum phases.
This avoids the historical shared AppKit injector's integer quantization.
Its Markdown diagnostic also loads the Markdown lane's pinned pre-document
Explorer/MotionFileTree source at `d4269d55`, on the current addon. All three
Markdown cases enable the same trace logging; sidebar cases disable tracing.
`followups.ts` then repeats streaming in reverse order, three runs per side,
with trace logging off, to investigate interval tails separately from AGX work.
`markdown-cost.ts` separately compares the older pre-document addon, legacy
Markdown on the new addon, canonical documents on the new addon, and pruned
canonical documents, using the same 93,853-byte source in a 728×800 native lab.
The older addon cannot run the new document API in the full product. These
trace-enabled single-window controls are diagnostic context, excluded from
three-repeat product acceptance results.
Warmup is ten seconds, followed by a fifteen-second resource window. No screen
captures or synthetic-clock manipulation occur in timed runs. Native build and
foreign-app inventories invalidate measurements. `KYBERN_FULL_RATE=1` applies
to every active/idle sample. Frame intervals are scene submission intervals;
physical input-to-present latency and energy are not measured.

The quiet wrapper waits for the shared `screen-state.swift` preflight to report
`locked: 0` and an awake display, then holds scoped `caffeinate` assertions.
Synthetic in-process events do not reset the session-lock timer. Caffeinate
does not unlock a locked session. Locked/zero-submission active runs are
discarded; no lock or persistent power setting is changed. Optional shared-bench
gates use `KYBERN_BENCH_SCREEN_STATE_SCRIPT`; they check before/after each timed
window and native-app lifecycle. The lane helpers set this to the shared script.

`KYBERN_GPU_TRACE=1` is a separate diagnostic, excluded from acceptance resource
comparisons. Existing `[paint-gpu]` records command-buffer GPU start/end duration,
region/full-target dimensions and primitive counts. `[gpu-scene]` adds actual
ordinary renderer draw calls (backdrop's two calls are listed separately),
scene batches, glyph/quad/color-sprite/shadow/path counts, path vertices,
source atlas uploads/bytes/evictions since the preceding frame, fixed-record
instance bytes, and conservative glyph/quad/color-sprite bounding area.
The area is a workload proxy; it is not a hardware fragment/overdraw counter.
It excludes blur halos, shadows, path rasterization and transformed extents.
Metal device/atlas/pool/backdrop gauges come from `KYBERN_MEMORY_COUNTERS=1`.
Scene/command summaries use the last measured-frame-count records from the raw
log; asynchronous completion makes this an approximate diagnostic window.
Atlas/draw counters are process-wide and these probes use one native window.
Per-PID AGX GPU milliseconds divided by submissions is a process-work average,
which differs from command-buffer GPU elapsed duration. Neither certifies 120 Hz.

`KYBERN_GPU_CLIP_PRUNE=0` selects the same-binary control. The candidate only
simplifies transient Metal-upload masks after proving full-pixel containment
inside every ancestor's rounded shape. Retained scene operations, cache keys,
clip generations, input masks, atlas entries and transform bases remain intact.
Animated/transformed monochrome sprites, shadows, paths and backdrops keep the
original mask chain. There is no timer, frame-source or animation-default change.
`gpu_clip_bounds.rs` has a standalone `rustc --edition=2021 --test` geometry check.

External evidence: `/Users/mymac/projects/ade/previews/gpuix/perf/gpu/`.
See `RESULTS.md` for accepted/rejected changes and their measured limits.
