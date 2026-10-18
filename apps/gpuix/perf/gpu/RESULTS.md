# GPU submission cost — perf-gpu

Branch `gpuix/perf-gpu`, base `b14b10f1`; Apple M1, macOS 27.0.1, 60Hz Retina LCD.
**Every timing/resource number uses `KYBERN_FULL_RATE=1`.** No cadence, passive
loop, animation or material default changes. Final addon SHA256:
`1145f7914ae87f5cedd5993fdced48f07ea09a3824aad781dcbd8d78d236a5f8`.

## Outcome and root causes

The retained rounded-clip chain repeats fragment work for glyphs entirely inside
all ancestor shapes. The final candidate proves containment on CPU and clears
only the transient uploaded rounded-mask index for those interiors. It retains
edge/corner coverage, retained scene state, rectangular masks and cache/input
semantics. Final three-repeat AGX window medians fall **5.1% Explorer, 6.2%
Markdown, 10.2% thread**. Sidebar (+0.8%) and PR (−0.2%) are inconclusive in this
last shared pair; the precise sidebar probe falls 5.7%. Earlier shared pairs
also favored these static workloads, but the effect is not uniform across runs.

The unrestricted streaming extension was **dropped**. Its AGX result changed
sign over three pairs, with inconsistent interval tails and unequal original
fixture timer delivery. Final code bypasses pruning for every primitive in any
scene containing backdrops. Final streaming GPU/footprint are effectively flat;
its masks are identical under both flags. No streaming speedup is claimed.

Final five-second trace windows (`gpu-gated-diagnostic-*`) show:

| Scenario | Ordinary draws | Blur/composite draws | Glyphs | Retained glyph clip steps / max depth | Rounded glyphs → simplified |
|---|---:|---:|---:|---:|---:|
| explorer-scroll | 18 | 0 | 1605 | 4309 / 5 | 1566 → 1552 |
| markdown-scroll | 18 | 0 | 2801 | 10251 / 5 | 2754 → 2714 |
| sidebar-scroll | 19 | 0 | 747 | 1304 / 2 | 727 → 715 |
| thread-scroll | 19 | 0 | 1730 | 4413 / 5 | 1683 → 1653 |
| pr-changes | 13 | 0 | 2093 | 5218 / 3 | 2084 → 2081 |
| streaming | 21 | 18 | 1633 | 3046 / 2 | 1597 → 0 |

Static scenes simplify 98–99.9% of rounded glyphs. There are 96–170 quads, no
active paths, and only 0–2 shadows. No per-row Metal passes appear. Streaming
has nine actual backdrop primitives and 18 additional blur/composite draws;
these are substantial remaining work, preserved unchanged.

Atlas eviction thrash and per-frame document bitmap rerasterization are absent
in these warmed windows: Markdown/sidebar/thread/PR upload zero atlas bytes,
Explorer uploads 4,218 control / 3,919 candidate bytes, streaming 3,620 / 3,919;
all have zero evictions. Fixed geometry/atlas-reference instance uploads remain
107–356KiB/frame. Memory counters show roughly 68–75MiB device allocation, a
1MiB static / 5MiB stream atlas, a 2MiB instance-pool target, and 16.016MiB path
intermediate capacity even with zero active paths. These are allocation gauges,
not process residency or evidence of current path rasterization.

Every diagnostic repaints a full 2560×1640 target (`retained=false`, one region),
with conservative clipped quad/sprite bounds totaling 11.7–13.5M pixels
(2.8–3.2× target). This is an area proxy, **not hardware overdraw**; it excludes
blur/shadow/path halos and transformed extents. Full-window damage remains a
correctness-sensitive follow-up. No material or clipping effect was removed.

Zed batches fixed instances with rectangular monochrome clipping; GPUIX adds
its own rounded ancestor chain. Zeron bounds semantic visible work before the
renderer. Local source citations and transferable techniques are in
[zeron-zed-techniques.md](../zeron-zed-techniques.md).

## Final shared bench

Synthetic 300-thread/20-project fixture, 3,000-turn history, large Explorer tree,
long Markdown/code, PR changes and streaming. Each scrolling run offers exactly
1,800 fractional wheel RPC packets at 120Hz; a separate real AppKit probe below
avoids the older shared injector's integer quantization. One app/warmup10s per
scenario, then three consecutive independent 15s endpoint samples. Trace off,
existing memory counters on. No screenshots/manual clock stepping in timing.
The fixture's existing `KYBERN_BENCH_STREAM_CATCHUP=1` replays its nominal 25Hz
wall-time timeline after late timer wakes. Observed endpoint rates are
25.40–25.54 deltas/s; endpoint bookkeeping prevents exact count equality, so
streaming is a neutral regression control, not a causal optimization result.

`gpu-gated-control` and `gpu-gated-after` use the **same final addon**, with
`KYBERN_GPU_CLIP_PRUNE=0/1`. All 42 endpoint samples pass screen, build overlap,
process inventory and bounded UI-lease checks. Quiet window 18:06:38–18:27:29Z.
Numbers are medians of per-run statistics, not pooled percentiles. All six idle
samples have **zero submissions and zero GPU ms**; idle CPU remains ~1.5–1.6%.

### Control

| Scenario | Frames p50/p95/p99 ms | >16.7/>33 | Proxy p95 ms | CPU % | AGX ms/15s | AGX ms/submission* | CPU ms/submission* | MiB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| explorer-scroll | 16.66/17.78/18.32 | 430/0 | 14.71 | 62.83 | 2286.30 | 2.43 | 10.02 | 305 |
| markdown-scroll | 16.68/17.57/17.94 | 436/0 | 14.47 | 44.81 | 2892.90 | 3.10 | 7.22 | 264 |
| sidebar-scroll | 16.67/17.81/20.03 | 426/0 | 11.20 | 44.74 | 1994.10 | 2.13 | 7.21 | 247 |
| thread-scroll | 16.67/16.74/16.79 | 187/0 | 13.46 | 43.75 | 2668.80 | 2.86 | 7.03 | 267 |
| pr-changes | 16.67/17.59/17.88 | 428/0 | 14.40 | 34.44 | 2118.30 | 2.28 | 5.64 | 242 |
| streaming | 16.66/20.24/22.15 | 373/0 | — | 22.07 | 1759.30 | 1.92 | 3.61 | 257 |
| idle-home | —/—/— | 0/0 | — | 1.53 | 0.00 | — | — | 216 |

### Candidate

| Scenario | Frames p50/p95/p99 ms | >16.7/>33 | Proxy p95 ms | CPU % | AGX ms/15s | AGX ms/submission* | CPU ms/submission* | MiB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| explorer-scroll | 16.70/17.73/18.35 | 460/0 | 14.22 | 61.75 | 2169.50 | 2.33 | 10.06 | 292 |
| markdown-scroll | 16.73/17.67/18.04 | 490/0 | 12.54 | 45.87 | 2713.40 | 2.92 | 7.38 | 264 |
| sidebar-scroll | 16.72/17.90/19.97 | 480/0 | 12.68 | 44.22 | 2010.80 | 2.17 | 7.20 | 247 |
| thread-scroll | 16.74/17.76/18.15 | 504/0 | 11.07 | 45.15 | 2396.10 | 2.59 | 7.31 | 264 |
| pr-changes | 16.73/17.61/18.02 | 501/0 | 14.27 | 35.91 | 2113.70 | 2.28 | 5.81 | 243 |
| streaming | 16.67/20.36/22.14 | 393/0 | — | 23.33 | 1751.20 | 1.91 | 3.83 | 257 |
| idle-home | —/—/— | 0/0 | — | 1.60 | 0.00 | — | — | 208 |

*AGX/submission is per-PID accumulated GPU work divided by the endpoint's logged
submission count. GPU sampling lasts ~15.02s; endpoint telemetry/Swift guards add
~0.3–0.6s, so this average is approximate, not a per-command GPU timer. CPU uses
the same denominator. “Proxy” is input offer→next submission-log receipt, not a
physical present fence. >16.7ms includes small 60Hz scheduling fluctuations.
All final acceptance repeats have zero intervals >33ms. Thread p95 rises from
16.74 to 17.76ms while GPU work falls; improvements do not establish uniformly
smoother scheduling. CPU and footprint gains are not uniform either.

### Metal elapsed, separate diagnostic

GPUStartTime→GPUEndTime is command-buffer elapsed duration, distinct from AGX
busy accounting; five-second trace-enabled samples are excluded from acceptance:

| Scenario | Metal elapsed median ms control→candidate |
|---|---:|
| explorer-scroll | 2.350→2.182 |
| markdown-scroll | 2.905→2.522 |
| sidebar-scroll | 2.108→2.010 |
| thread-scroll | 2.395→2.203 |
| pr-changes | 2.170→2.157 |
| streaming | 4.459→4.750 |

Trace summaries use the last measured-frame-count records in asynchronous logs,
so their boundaries are approximate. Neither counter measures energy or proves
120Hz readiness; the display is 60Hz and no physical presentation fence is read.

## Precise AppKit and pre-document controls

Final `precise-gated/`: native background producer, fractional CGFloat AppKit
NSEvents with contact/momentum, warm10s/sample15s. Exactly 1,800 events delivered
in all five cases. Markdown cases share trace logging; sidebar cases disable it.
Pinned legacy Explorer/MotionFileTree source at `d4269d55` runs on the **current
addon**, isolating the old JS rendering path without unsupported document APIs.

| Mode | CPU % | AGX ms/15s | AGX/submission* | MiB | Submissions | p50/p95/p99 ms | >16.7/>33 |
|---|---:|---:|---:|---:|---:|---:|---:|
| markdown-legacy, prune 0 | 102.71 | 1267.8 | 1.960 | 294 | 647 | 23.07/25.21/26.36 | 646/2 |
| markdown, prune 0 | 46.61 | 2936.2 | 3.181 | 275 | 923 | 16.74/17.65/18.03 | 498/0 |
| markdown, prune 1 | 46.14 | 2729.0 | 2.957 | 271 | 923 | 16.77/17.43/17.92 | 523/0 |
| sidebar, prune 0 | 62.90 | 2075.1 | 2.246 | 222 | 924 | 16.67/17.81/19.39 | 442/0 |
| sidebar, prune 1 | 63.23 | 1956.7 | 2.120 | 220 | 923 | 16.69/17.73/18.58 | 451/0 |

Final document off/on saves 7.1% AGX and sidebar saves 5.7%; earlier precise
repeat saved ~9.3% in each. The legacy path is CPU bound (~103%) and submits
fewer frames. Its lower GPU work does **not** mean it renders smoothly.
Legacy/current source-control trace has nearly identical 18 draws, ~2,801 glyphs,
10,256 retained glyph ancestor steps, max depth5, zero atlas churn and the same
full target. Retained rounded-node count falls 152→28 with native documents.
Those counts do **not** explain the remaining old→document per-submission AGX
increase. The historical Markdown 3.6× GPU-window regression is not fully
attributed by this work; both historical windows already had ~915 frames.

Separate `markdown-cost/` uses the actual pre-document addon in a 728×800 native
lab with identical 93,853-byte source: old legacy 601.5ms GPU/659 submissions,
current legacy 605.3/644, document off 518.2/912, document on 410.5/912. Legacy
RPC backpressure delivers only 644–659 of the attempted events versus 1,800 for
documents. Old→document inputs are unmatched diagnostic context; no causal
speedup is inferred. The matched document off/on pair saves 20.8% in this small
lab. It does not reproduce the historical whole-app regression.

Original combined addon control `gpu-before` and all unrestricted pairs remain
in `results.json` and full external JSON. Original SHA:
`f7c8af1c2f2558f6c1a5a3ce93b274cfaf5676ebb87ac438d0ad29d45960dc10`;
pre-document addon SHA:
`17ecd86ebd97c1fae86839ef31e41ceaf0b73027a31162a18638f155163adabe`.

## Alternatives tried and dropped

- Unrestricted streaming masks: initial GPU 2958.3→2109.5ms with p95
  17.11→23.62ms; reverse-order control/candidate 3044.7/2970.6ms and p95
  17.53/17.82ms; later strict pair 2791.3→2908.6ms with p95 22.17→17.19ms.
  Inconsistent signs/tails and unequal original timer offers reject this scope.
  Final backdrop-scene bypass is intentional, not an animation-default change.
- Atlas/eviction policy: no measured churn supports a fix. Full-target damage,
  blur caching and pool retention need separate correctness/work accounting.
- Locked-session runs at ~16:30Z: only an initial empty scene then zero GPU;
  discarded under `display-asleep-rejected/`. Parent verified `locked:1` while
  awake; another attempt stopped at the warmup gate. No unlock/settings changes.
  Swift pre/post app/timed/visual gates and scoped caffeinate protect valid runs.
- First visual tree reveal/scroll-anchor race and stale foreign UI-lease wait
  were rejected/archived. Settling/repositioning the tree fixes the visual probe.

## Files

Native patches, separately:

- `gpu_clip_bounds.rs`: finite/positive conservative rectangle containment with
  one device pixel margin and maximum-radius horizontal/vertical interior core.
- `gpu_clip.rs`: all-ancestor proof, transient mask only, same-binary off switch;
  entire backdrop scenes bypass pruning.
- `gpu_clip_gpui.py`: uploaded quad/underline/color-sprite copies and identity
  monochrome copies; transformed monos, paths, shadows/backdrops keep masks.
- `gpu_telemetry_gpui.py`: opt-in atlas/draw/primitive/instance/area/ancestor
  diagnostics; exact eight draw-hook assertion; no frame requests/timers.
- `backdrop_gpui.py`: two appended one-line hooks after existing patches.
- `native/README.md`: controls, scope and accounting limits.

Harness/docs: `perf/gpu/{build.py,quiet.ts,measure.ts,gated.ts,run-pair.ts}` reuse
shared fixtures and build/quiet/UI gates; `app.ts`/`precise.ts` use the existing
CGFloat injector; `markdown-cost.ts` handles old-addon controls; `followups.ts`
reverses streaming; `visual.ts` captures exact pairs; `summarize.py` preserves
measurements; `results.json`, this report and README document reproducibility.
`perf/bench/{screen-state.ts,process-gate.ts,scenarios.ts}` add optional screen
gates and evidence at app/timed boundaries. Research notes append to
`perf/zeron-zed-techniques.md`.

## Validation, evidence and handoff

- Final `native/update.sh` passed end to end with a whole-run build marker,
  low priority/four jobs: canonical Markdown source/width/block cases in both
  themes, rounded/input masks, transformed/region paths, strokes, cached/full
  scroll, pointer phases, navigation and shell ordering all pass.
- `pnpm typecheck`; `pnpm exec tsc -p native/tsconfig.json`; GPU harness tsc;
  bench tsc; bench model tests8/28 assertions; standalone containment test1: pass.
- `bun test ./src`: **332 passed, 0 failed, 6,872 assertions, 55 files**.
- Final same-binary exact pixels: **14 dark/light functional-canvas pairs,
  58,245,586 sampled pixels, zero changed**. Sidebar/transcript/Markdown each
  top+scrolled, plus Explorer. Outer4px/native bottom framing excluded; updater
  rounded-clip checks separately cover edge/corner behavior. All visual screen
  audits are unlocked/awake. Initial wrapper's rustc2015 failure after its first
  updater success was fixed to `--edition=2021`; final full updater/test passes.

Evidence root: `/Users/mymac/projects/ade/previews/gpuix/perf/gpu/`:
`summary.json`, full `gpu-*.json`, per-label logs/inventories, `native-update.log`,
`native-updater-passed.log`, `native-checks/`, `checks.json`, final source manifest,
`visual/pixel-diff.json` +28PNGs +screen audit, `precise-gated/`, `precise/`,
`markdown-cost/`, historical/rejected artifacts. Raw outputs stay external.

Remaining gaps: no energy/hardware-fragment counters or true input-to-present
measurement; historical document GPU regression remains partly unexplained;
sidebar/PR shared-bench improvement is inconclusive; streaming retains nine
backdrops; full-target repaint remains; CPU/interval tails do not uniformly
improve. This patch reduces GPU work in demonstrated workloads without claiming
all goals or 120Hz readiness are solved.

Cleanup completed after confirming no owned app/daemon/build/open files. Removed
native target (1.9GiB), upstream (185MiB), both disposable dependency installs
(188/633MiB), scratch `perf-gpu*` data, helper binaries and baseline addon copy.
Only the validated 25.3MiB addon and 0.1MiB runtime bridge remain in native/build;
~282MiB requested external evidence is retained. Initial free space ~82GiB;
pre-cleanup 75.2GiB; actual post-cleanup **77.3GiB**. Concurrent lanes share
this APFS volume; removed directory sizes do not imply equal reclaimed blocks.
No user daemon/data, worktree registrations or research clones were removed.
`cleanup.json`/`cleanup-preflight.json` record checks and paths.

Final validation/report commit is the branch tip at handoff; `git status --short`
is empty after that commit. No push or merge.
