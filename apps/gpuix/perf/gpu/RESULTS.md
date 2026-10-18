# GPU submission cost — perf-gpu

Branch `gpuix/perf-gpu`, base `b14b10f1`; Apple M1, macOS 27.0.1, 60Hz Retina
display. **Every timing/resource number uses `KYBERN_FULL_RATE=1`.** No passive
loop, cadence or animation default changes.

## Findings

Ancestor rounded-clip evaluation is redundant on most interior glyphs/quads.
Five-second trace windows found 98–99.9% of rounded glyph sprites provably inside
all ancestor shapes. The upload fast path removes that per-fragment work;
retained primitives, draws, atlas entries, materials and painted area remain.

Same-binary three-repeat acceptance reduces median per-PID AGX work in all six
active scenes: 2.5–6.8% for static scrolling, 28.7% for streaming. Frame intervals
do **not** uniformly improve: streaming p95 rises 17.11→23.62ms in the first pair.
The queued reverse-order repeat investigates that tradeoff. GPU work alone does
not establish smoothness or 120Hz readiness.

| Scenario | Ordinary draws/frame | Blur/composite draws | Quads | Glyphs | Rounded glyphs → simplified | Atlas uploads / evictions in 5s |
|---|---:|---:|---:|---:|---:|---:|
| Explorer | 18 | 0 | 126 | 1605 | 1566 → 1552 | 4 tiny / 0 |
| Markdown | 18 | 0 | 110 | 2801 | 2754 → 2714 | 0 / 0 |
| Sidebar | 19 | 0 | 96 | 747 | 727 → 715 | 0 / 0 |
| Thread | 19 | 0 | 124 | 1702 | 1655 → 1637 | 0 / 0 |
| PR Changes | 13 | 0 | 170 | 2093 | 2084 → 2083 | 0 / 0 |
| Streaming | 21 | 18 | 57 | 1633 | 1597 → 1588 | 3 tiny / 0 |

Counts are per-window medians; visible contents can differ slightly between
sides (sidebar control rounded median: 730). No active path geometry, only 0–2
shadow primitives in static scenes. No per-row Metal passes explain these
workloads. Streaming's nine actual backdrops remain a separate substantial cost.

All diagnostics repaint one full 2560×1640 target. Clipped quad/sprite bounding
area is 11.7–13.5 million pixels (2.8–3.2× viewport). That is a workload proxy,
**not hardware overdraw**; it excludes shadow/blur/path halos and transformed
extents. Full-target damage remains a lead for another correctness-sensitive fix.

Atlas eviction thrash is absent in these measured windows. Markdown/sidebar/
thread/PR upload no bitmaps; Explorer uploads 4,218 bytes, streaming 3,919 bytes.
Fixed instance records still upload 107–356KiB/frame; they contain geometry and
atlas references, not rerasterized document glyph slices. The 16MiB allocated
path intermediate is capacity despite zero active paths. Metal allocation gauges
and physical footprint are separate measurements.

After-window Metal gauges show 68.4–70.4MiB current device allocation for static
scenes and 74.5MiB for streaming, a 2MiB instance-pool target (0–2MiB currently
idle buffers), a 1MiB atlas for static scenes / 5MiB for streaming, and a 16.016MiB
path texture in all scenes. Streaming's reusable backdrop scratch is 0.043MiB.
Pool idle-buffer counts vary with asynchronous completion/safe reclamation; they
are snapshots, not bytes uploaded or whole-process residency savings.

Zed batches instances with rectangular monochrome clipping; the ancestor rounded
chain is GPUIX-specific. Zeron bounds semantic viewport work before this stage.
See the appended source comparison in
[zeron-zed-techniques.md](../zeron-zed-techniques.md).

## Shared bench

Synthetic 300-thread/20-project fixture, 3,000-turn history, large Explorer tree,
long Markdown/code, PR changes and streaming. Both sides use the existing 120Hz
fractional wheel RPC offers (1,800 packets/15s), avoiding the old AppKit injector's
integer quantization. One app launch and ten-second warmup per scenario, followed
by three consecutive independent fifteen-second endpoint samples. No screenshots/manual clock stepping in
timing. Quiet/build/process inventories and bounded UI leases guard each run.
Trace logging is off in acceptance. All runs pass overlap/process gates.

Tables are medians of per-run statistics, not pooled percentiles. Input proxy is
offer→next scene-submission log receipt, **not physical presentation**. CPU
ms/submission is process CPU time divided by scene submissions. >16.7 counts
include small 60Hz scheduling fluctuations. Full repeats remain in `results.json`.

### Original combined addon (`gpu-before`)

| Scenario | Frames p50/p95/p99 ms | >16.7/>33 | Input proxy p95 ms | CPU % | AGX ms/15s | AGX ms/submission | CPU ms/submission | MiB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| explorer-scroll | 16.68/18.51/29.04 | 427/0 | 16.74 | 62.20 | 2043.60 | 2.26 | 10.35 | 301 |
| markdown-scroll | 16.62/18.57/18.84 | 398/0 | 15.87 | 45.74 | 2999.60 | 3.32 | 7.60 | 265 |
| sidebar-scroll | 16.66/16.83/16.95 | 260/0 | 16.72 | 46.13 | 2433.90 | 2.69 | 7.67 | 248 |
| thread-scroll | 16.64/18.64/18.98 | 410/0 | 15.81 | 45.08 | 2640.90 | 2.92 | 7.51 | 255 |
| pr-changes | 16.67/18.55/18.94 | 420/0 | 16.40 | 38.43 | 2454.50 | 2.72 | 6.39 | 241 |
| streaming | 16.68/17.20/20.17 | 400/0 | — | 36.14 | 2920.00 | 3.23 | 6.01 | 262 |
| idle-home | — | 0/0 | — | 3.39 | 0.00 | — | — | 212 |

### Rebuilt same-binary control, prune off (`gpu-control`)

| Scenario | Frames p50/p95/p99 ms | >16.7/>33 | Input proxy p95 ms | CPU % | AGX ms/15s | AGX ms/submission | CPU ms/submission | MiB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| explorer-scroll | 16.70/17.81/18.49 | 452/0 | 10.26 | 59.50 | 2064.40 | 2.29 | 9.89 | 293 |
| markdown-scroll | 16.63/18.38/18.76 | 391/0 | 12.62 | 45.94 | 3039.40 | 3.36 | 7.63 | 269 |
| sidebar-scroll | 16.69/18.41/19.84 | 436/0 | 12.96 | 45.41 | 2380.60 | 2.63 | 7.54 | 244 |
| thread-scroll | 16.64/18.66/19.00 | 405/0 | 14.94 | 45.54 | 2670.50 | 2.96 | 7.58 | 261 |
| pr-changes | 16.67/18.69/18.96 | 407/0 | 14.10 | 38.64 | 2490.90 | 2.76 | 6.43 | 246 |
| streaming | 16.68/17.11/19.52 | 378/0 | — | 36.55 | 2958.30 | 3.28 | 6.09 | 255 |
| idle-home | — | 0/0 | — | 3.45 | 0.00 | — | — | 209 |

### Rebuilt candidate, prune on (`gpu-after`)

| Scenario | Frames p50/p95/p99 ms | >16.7/>33 | Input proxy p95 ms | CPU % | AGX ms/15s | AGX ms/submission | CPU ms/submission | MiB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| explorer-scroll | 16.68/18.11/18.60 | 420/0 | 14.35 | 59.90 | 2011.80 | 2.23 | 9.95 | 293 |
| markdown-scroll | 16.61/18.62/18.91 | 382/0 | 11.86 | 46.08 | 2833.20 | 3.13 | 7.66 | 265 |
| sidebar-scroll | 16.68/18.70/20.07 | 433/0 | 15.33 | 45.27 | 2285.70 | 2.53 | 7.52 | 248 |
| thread-scroll | 16.67/16.81/16.89 | 261/0 | 16.45 | 45.08 | 2593.20 | 2.87 | 7.49 | 262 |
| pr-changes | 16.68/18.65/18.96 | 436/0 | 15.65 | 38.83 | 2348.00 | 2.60 | 6.47 | 245 |
| streaming | 16.68/23.62/26.25 | 427/0 | — | 37.08 | 2109.50 | 2.33 | 6.16 | 251 |
| idle-home | — | 0/0 | — | 3.25 | 0.00 | — | — | 213 |

All nine idle windows present **zero frames and zero AGX work**. Idle CPU is
3.25–3.45%, so zero frames does not mean zero process CPU. Original Explorer
repeat 1 has 25 intervals >33ms, hidden by its median table; every same-binary
control/after acceptance repeat has zero >33ms intervals.

### Metal elapsed versus AGX work

Metal GPUStartTime→GPUEndTime is command-buffer elapsed duration, which differs
from per-PID AGX busy accounting and can include stalls/scheduling. Five-second
trace-enabled diagnostics are separate from acceptance:

| Scenario | Metal elapsed median ms control→after | AGX ms/5s control→after |
|---|---:|---:|
| Explorer | 2.796→2.179 | 730.5→724.3 |
| Markdown | 2.788→2.669 | 1024.7→945.3 |
| Sidebar | 2.239→2.089 | 791.5→751.9 |
| Thread | 2.485→2.237 | 902.8→840.3 |
| PR Changes | 2.190→2.112 | 821.6→784.7 |
| Streaming | 2.647→3.524 | 972.1→691.5 |

Streaming's elapsed/interval tails worsen while busy work falls; neither metric
substitutes for the other. Acceptance root render p95 improves 14.327→12.709ms
for streaming, stays ~9.1ms for Explorer, ~5.0–6.8ms for other scrolling. An 8.33ms
120Hz budget is not consistently met. No energy or ProMotion measurement.

## Pre-document control

Identical 93,853-byte source, 728×800 native lab, warm10s/sample15s, trace on,
`KYBERN_FULL_RATE=1`. Old addon uses legacy Markdown; current supports both.

| Mode | CPU % | AGX ms/15s | Frames | AGX ms/submission | p50/p95/p99 ms | Input packets |
|---|---:|---:|---:|---:|---:|---:|
| old addon, legacy | 101.91 | 601.5 | 659 | 0.913 | 22.80/24.74/26.14 | 659 |
| current, legacy | 101.93 | 605.3 | 644 | 0.940 | 23.38/24.78/25.55 | 644 |
| current document, prune off | 39.00 | 518.2 | 912 | 0.568 | 16.67/18.69/19.99 | 1800 |
| current document, prune on | 36.92 | 410.5 | 912 | 0.450 | 16.66/17.74/18.16 | 1800 |

Legacy RPC backpressure allows only 644–659 packets; **old→document input is
unmatched** and is diagnostic context, not a causal performance comparison.
This isolated lab does not reproduce the historical whole-app 3.6× regression.
The document off/on pair is matched: 1,800 packets, 912 submissions, 20.8% lower
AGX work. No measured atlas churn explains the document path.

## Precise AppKit and reverse streaming follow-ups

Pending an unlocked session and queued window; completed before handoff. The
first follow-up at 16:30Z produced only an initial empty scene, then zero active
submissions/AGX. Those results were discarded, not interpreted as an improvement.
The parent confirmed `locked: 1` with the display awake: caffeinate cannot unlock
a session. A second attempt stopped at the warmup no-submission gate. New Swift
pre/post gates pause app/timing/visual work while locked; scoped caffeinate holds
the display awake during valid runs. No unlock or lock-setting change is attempted.

## Files and alternatives

Native patches listed separately:

- `gpu_clip_bounds.rs`: finite/positive containment proof, one device pixel
  margin, conservative maximum-radius horizontal/vertical core and unit check.
- `gpu_clip.rs`: prove containment through every ancestor; transient mask only;
  `KYBERN_GPU_CLIP_PRUNE=0` control.
- `gpu_clip_gpui.py`: copies quad/underline/color-sprite instances and identity
  monochrome sprites; transforms/shadows/paths/backdrops retain original chains.
- `gpu_telemetry_gpui.py`: opt-in atlas/draw/primitive/instance/area diagnostics;
  exact draw-anchor count assertion; no timer/frame requests.
- `backdrop_gpui.py`: two appended one-line hooks after existing patches.
- `native/README.md`: controls, behavior and measurement limits.

`perf/gpu/` reuses shared fixture/telemetry/process gates/UI leases and the
Explorer CGFloat injector. `build.py` marks the entire low-priority, four-job
updater/check run and restores temporary legacy screenshot-path routing.
`quiet.ts` owns fair quiet windows and interrupted children; `measure.ts` and
`run-pair.ts` run acceptance/diagnostics; `app.ts`/`precise.ts` drive fractional
AppKit events; `markdown-cost.ts` runs native/legacy controls; `followups.ts`
reverses streaming order; `visual.ts` captures pairs; `summarize.py` preserves data.

One product optimization was implemented. Atlas/cache/eviction policy changes
were rejected as unsupported by measured churn. Full-window damage/blur changes
were deferred for separate accounting/correctness work. No materials, glyphs,
motion or per-row layers were removed. The first visual capture hit asynchronous
Explorer tree reveal/scroll anchoring; those captures were rejected and archived,
the harness settles/repositions the tree, and all 14 comparisons then pass.

## Validation and artifacts

- Full `native/update.sh`: passed end-to-end with whole-run build marker;
  canonical Markdown source/width/themes/block cases, rounded/input, transforms,
  strokes, cached/full scroll, pointer phases and ordering all pass.
- `pnpm typecheck`, native tsc, GPU tooling tsc: pass.
- `bun test ./src`: 332 passed, 0 failed, 6,872 assertions, 55 files.
- Standalone containment test: 1 passed. Initial wrapper used rustc's default
  2015 edition and failed **after** updater success; fixed `--edition=2021`, then
  native tsc and containment retry pass. Complete log preserves both attempts.
- Patch reconstruction after the telemetry-anchor assertion matches all four
  generated source hashes.
- Exact pixels: 14 dark/light functional-canvas pairs, 58,245,586 sampled pixels,
  zero changed, including sidebar/transcript/Markdown top+scrolled and Explorer.
  The comparison excludes the outer 4px and native bottom-window corner framing;
  the updater's rounded-clip checks separately exercise corner/edge coverage.

Evidence: `/Users/mymac/projects/ade/previews/gpuix/perf/gpu/`: `summary.json`,
`gpu-*.json`, per-label scene logs/inventories, `native-update.log`,
`native-updater-passed.log`, `native-checks/`, `checks.json`,
`patch-reconstruction.json`, `visual/pixel-diff.json` and 28 PNGs,
`markdown-cost/`, `precise/`. A stale foreign UI-lease blocked attempt was
discarded and archived; its wait is excluded from acceptance runtime/resources.

Original addon SHA256:
`f7c8af1c2f2558f6c1a5a3ce93b274cfaf5676ebb87ac438d0ad29d45960dc10`.
Pre-document addon SHA256:
`17ecd86ebd97c1fae86839ef31e41ceaf0b73027a31162a18638f155163adabe`.
Validated addon SHA256:
`81ad81995fcfbebd6a872ab701e05be17127d1782b66adbb82c40946d4ac1ee3`.

Final commit/status, free space and cleanup recorded at handoff.
