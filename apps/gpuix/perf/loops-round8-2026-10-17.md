# Native continuous loops — round 8

**Partial; smooth loops remain opt-in.** The final queued running-thread trial
misses the approved GPU gate. The user deferred further optimization until the
port is complete; no additional performance experiment follows this trial.
Round-one item 10 remains open. Gradient shimmer is specified below, not built.

## Findings and outcome

The original passive path still loads/stores a full-window retained texture and
copies that texture into every drawable. Scissors reduce shading but do not
remove those full-target operations. In one trace, 893 commands were passive
and only 17 reconstructed the ordinary scene; paths/backdrops were zero.
Repeated full reconstruction/filter fallback does not explain that control.
Serial diagnostic commands measured scene wall-GPU p50/p95 **1.342/2.566 ms**
and fullscreen copy **2.482/4.294 ms** (906 of each).

Disjoint scissors plus DontCare on the overwritten destination did not meet
the gate. Cropped-copy presentation still touched the full retained target.
Direct per-region CAMetalLayers removed that work but incurred high submission
cost; a single union layer still stored a large mostly empty texture.

The final opt-in prototype packs disjoint damage into a small shared IOSurface,
rasterizes all tiles in one encoder, and assigns tile rectangles to plain CA
layers. The base drawable changes only with the ordinary scene or damage
geometry. It punches matching holes in the same base render pass and commits
base/layer edits in one disabled-actions CA transaction. Surface reuse waits
for GPU completion and IOSurfaceIsInUse; the pool is bounded to eight surfaces.
Errors/backpressure invalidate a resource result. No full-window retained
color texture is allocated for this path. Older cropped modes remain explicit
controls, not defaults.

The first packed-source Y calculation selected the wrong rows. It failed exact
pixels (missing glyph/text); correcting the CALayer source-coordinate origin
made **all four modes pixel-identical**. Failed images remain in `atlas-region/`;
accepted images/logs are in `atlas-y-region/`.

This reduces the measured GPU cost but does not meet the gate. Remaining GPU
cost/variability is unresolved; do not claim it is caused by glyph uploads or
Core Animation without another profile. Command GPUStartTime/GPUEndTime is
wall-GPU elapsed time and differs from AGX accumulated GPU time; neither is an
energy measurement. Native frame timestamps record submission cadence, not
physical display fences.

## Final queued trial

Apple M1 / 16 GiB, macOS 27.0.1 (26A434), Bun 1.4.0, Rust 1.97.1,
GPUIX 0.10.0. Each control warms 10 s then samples 15 s, capture-free and
without manual clocks. No rustc/cargo runs before/after samples; the UI lease
also excludes the other lanes' builds. Every accepted sample continuously
records one stable visible window. The fixture is reordered front without
activation immediately before measuring. Rejected visibility attempts are
retained, never averaged. CPU differences below about three points are noise.

Flags: native paint/text/region/layers/atlas **1**; full-rate inactive motion
and display wake **1**; GPU tracing **off**. Trial addon SHA-256:
`58f98b06457ea095c11929a9d4be6464cd3b75c7f905825c2228ca9b1ca6b9e0`.
The running fixture has one persisted pending tool and live labels, with no
agent process or token stream. Tasks has four running cards and a column glyph.

| Scene / repeat | CPU % | AGX GPU ms / 15 s | Footprint MiB | Frames | p50 / p95 ms | Island renders / commits |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| thread / 1 | 4.92 | 385.54 | 214 | 906 | 16.669 / 17.623 | 3 / 19 |
| tasks / 1 | 10.56 | 769.68 | 205 | 906 | 16.669 / 17.650 | 359 / 25 |
| thread / 2 | 5.78 | 480.08 | 215 | 905 | 16.667 / 17.667 | 16 / 25 |
| tasks / 2 | 3.19 | 457.36 | 203 | 905 | 16.667 / 17.665 | 0 / 0 |

Both running-thread CPU samples are below the smooth-60 reference (~10.2%),
but GPU **385.54 / 480.08 ms** exceeds its ~367 ms and is not near the old
5 Hz running-thread baseline (round 7: 132.7 ms; this round's exploratory pair:
179.69 / 136.23 ms). The zero-commit Tasks repeat still costs **457.36 ms**.
The other Tasks repeat had 359 island renders; it is reported separately.
The global WindowServer counters during these trials were 42–45% CPU and
5.55–7.38 s AGX GPU time/15 s. The user was active; these totals cannot be
attributed to this window. No total-system GPU or energy improvement is claimed.

No default is flipped. The original three smooth flags remain opt-in; the
compact prototype additionally requires layers=1 and atlas=1.

Raw evidence: `resources.jsonl`, derived `accepted-resources.json`, per-run
resource/tree/GPU logs, and `atlas-y-candidate.log`. Earlier before/after pairs
for all five scenes predate continuous occlusion logging and are exploratory,
not final acceptance. The requested new five-scene comparison, full app motion
inventory and project-drag rerun are unfinished under the user's stop decision.

## Rejected controls

| Path | Repeated CPU % | Repeated AGX GPU ms / 15 s | Decision |
| --- | --- | --- | --- |
| Disjoint retained target | 7.77 / 4.45 | 792.7 / 1494.3 | Gate fails; exploratory visibility |
| Cropped copy v1 | 5.59 / 9.38 | 2202.00 / 1846.68 | Gate fails |
| Direct multiple layers v2 | 20.46 / 16.27 | 1671.61 / 1424.64 | Gate fails |
| Single layer with culling v4, thread | 8.58 / 11.29 | 823.01 / 769.88 | Gate fails |
| Single layer with culling v4, Tasks | 10.95 / 10.42 | 1334.97 / 1224.13 | Gate fails; zero ordinary commits |

Single-sample diagnostic controls, not default decisions: union+Load 377.1 ms,
union+DontCare 342.2 ms, disjoint+DontCare 691.8 ms, native full redraw 1063.5 ms.
All raw results remain available; no contaminated/parked record is averaged.

## Correctness, motion and reference

`atlas-y-region/`: dark/light × normal/reduced, seven states each: initial,
recolor, geometry, filtered fallback, occlusion/resume, resize, size restore.
Exact full client comparison includes an actual translucent RGBA image under
the loops, matrix dots, task glyph and native text. Only existing WindowServer
edge/corner pixels are excluded; raw diffs/counts are retained. Every unmount
must produce a fresh release event and no recurring native frames. Reduced
motion is static. Resize tests backing-size reconstruction; physical migration
between displays with different backing scales remains unverified.

`atlas-y-text/`: all four modes preserve native text pixels, UTF-16 selection,
focus/editing and idle after unmount.

| Continuous component / check | Dark p50 / p95 ms | Light p50 / p95 ms | Reduced motion |
| --- | --- | --- | --- |
| Matrix orbit/pulse/scan/twinkle + task glyph (`atlas-y-frame/`) | 16.662 / 17.642 | 16.666 / 17.660 | 0 recurring frames; static pixels |
| Running thread/live native label (final resource trial) | 16.667–16.669 / 17.623–17.667 | Not sampled in full app | Static native label in text check |
| Connection spinner, isolated (`spinner/`, prior addon) | 16.669 / 18.582 | 16.670 / 18.630 | 0 frames; static pixels |

Normal frame tests have 180 frames/3 s and zero island renders. Pixel strips
verify changing dots/glyphs rather than only callback delivery. The connection
spinner's smooth period is corrected from 1 s to the desktop's **1.3 s**; it
uses the shared JS frame source, not native sprite rotation. These are opt-in
path checks: shipping defaults still visibly step at 5 Hz.

Reference evidence is the **desktop frontend in Playwright WebKit**, not the
installed Tauri host. `desktop-loops/desktop-{dark,light}-{0,1}-*.png` and
`spinner/loops-{dark,light}-reduced{0,1}-*.png` show the same real desktop/native
matrix, glyph, spinner and text components. Reference rAF p50/p95 is ~17/18 ms.
Native atlas images: `atlas-y-region/{dark,light}-{0,1}-1-initial.png`; paired
full redraws replace `-1-` with `-0-`. Text gradient parity remains a gap.

## Paint-check regression

The v1 end-to-end run failed the scheduled paint-only assertion: two ancestor
renders where zero were expected, with cropped mode OFF. The failure is kept as
a regression, not dismissed because later reruns passed.

Controlled same-source A/B with region/layers/GPU/frame tracing OFF:

| Addon | Quiet timer | Hover enters button during timer |
| --- | ---: | ---: |
| Original integrated (`before.node`) | 0 ancestor renders | 2 ancestor renders |
| Current candidate | 0 ancestor renders | 2 ancestor renders |

The pointer-enter diagnostic produces the same render-10/render-5 pair as the
failed log. A hover style legitimately invalidates both ancestor caches; the
timer-only assertion previously allowed unrelated physical pointer input.
`paint-lab.tsx` now sets `setIgnoresMouseEvents:true` on its own fixture window;
automation still dispatches directly, so hover, click, focus and editing checks
remain exercised. The zero-render assertion is unchanged. GPU diagnostics and
the resource visibility observer are absent from this lab. The parent-lease
helper only manages suite ownership; the diagnosis uses the same lease for both
addons. Evidence: `paint-regression.json`, first four rows of
`final-validation.log`. The historical failure did not log pointer events,
so its exact trigger cannot be proved retrospectively; the reproduced
contamination mechanism and input isolation are explicit.

## Files and reproduction

- `paint_region_gpui.py`: generation/damage metadata and additive render hooks.
- `paint_region_renderer.rs` / `.metal`: disjoint replay, DontCare copy, bounded
  coalescing, diagnostics and lifecycle release; surface/path/filter fallback.
- `paint_region_present.rs`: explicitly gated cropped-presentation controls.
- `paint_region_atlas.rs`: compact IOSurface tiles, bounded reuse, CA lifecycle.
- `paint_region_cull.rs`: allocation-free conservative primitive-range culling.
- `paint_region_crop_gpui.py`: preserve global shader coordinates for cropped
  viewports. **Shared hook:** one additive line in `backdrop_gpui.py`, after
  rounded clips. Fragment buffer 8 carries the per-pass coordinate origin.
- `frame_gpui.py`: atomic diagnostic lines to avoid interleaved visibility logs.
- `paint-lab.tsx`: isolate the timer assertion from physical mouse input.
- `frame-lab.tsx` / `paint-region-check.ts`: image/disjoint-path assertions and
  fresh unmount release; remove the native shimmer when H unmounts loops.
- **Shared helper:** `scripts/preview-ui-lock.ts` verifies explicitly inherited
  leases. No implicit lock bypass.
- `src/shell/Connection.tsx`: desktop-matching spinner period.
- `perf/loops8-*`: isolated port-4283 scratch fixtures, fair lease, build-free/
  visibility checks, raw metrics, diagnostic controls and four-mode reference.

From `apps/gpuix`, use `bun perf/loops8-final.ts` for diagnosis + full update +
source/helper checks (own cached build required), or `bun perf/loops8-native-check.ts
region` with `KYBERN_REGION_LAYERS=1 KYBERN_REGION_ATLAS=1` for compact-path pixels.
The final defaults remain unchanged: enable `KYBERN_NATIVE_PAINT_ANIMATIONS=1`,
`KYBERN_NATIVE_TEXT_PAINT=1` and `KYBERN_REGION_PAINT=1` explicitly;
`=0` disables each experiment. `KYBERN_REGION_LAYERS=1` selects cropped controls,
`KYBERN_REGION_ATLAS=1` selects compact tiles; atlas=0 retains the legacy cropped
control. `KYBERN_REGION_RECTS=0`, `KYBERN_REGION_CULL=0`,
`KYBERN_REGION_DIRECT=0`, `KYBERN_REGION_SINGLE_LAYER=0` and
`KYBERN_REGION_COPY_LOAD=1` are diagnostic controls. GPU trace/split require
explicit `KYBERN_GPU_TRACE=1` / `KYBERN_GPU_TRACE_SPLIT=1`.

Native integrations must advance `scene.paint_generation` whenever an ordinary
scene/geometry/cache reconstruction changes the displayed base. Translation
and scroll-cache lanes must preserve this invalidation contract when merged.

IOSurface API references: [reuse status](https://developer.apple.com/documentation/iosurface/iosurfaceisinuse(_:)?language=objc),
[CALayer contentsRect](https://developer.apple.com/documentation/quartzcore/calayer/contentsrect?language=objc).

## Final validation and cleanup

Final `native/update.sh` passes end to end on the final source, including the
previously failing dark/light paint-check. `pnpm typecheck` passes inside that
run; `bun test ./src` passes **107 tests / 0 failures / 4,650 assertions** across
26 files. `pnpm exec tsc -p perf/loops8-tsconfig.json` and `git diff --check`
pass. The diagnosis, rebuild/checks and source/helper checks hold one fair UI
lease for **195.38 s**. Full evidence: `final-validation.log`; final native
check images were preserved in `final-native-checks/` before cleanup.

Final addon (rebuilt from the same renderer source via native/update.sh):
`native/build/gpuix-native.darwin-arm64.node`, SHA-256
`58467c359177019d396051a06f3be023248efaea872cd9e65a1f4e12d8d34ef4`.
The performance table identifies its earlier trial binary separately; no
accepted default decision is made for either binary.

No scratch daemon/window or loops8 UI lease remains. Removed this lane's
1.8 GiB Rust target, 185 MiB upstream clone, disposable dependency installs
(220/633 MiB), scratch data and intermediate binaries after checking processes
and open files. Retained only the final addon (~23.4 MiB), existing webview
dylib (~101 KiB), source and evidence. Reproduction requires reinstalling
pinned dependencies and preparing a cached native build; original-addon A/B
also requires recreating `native/build/before.node` from the base commit.
The fair rebuild wrapper is for cached builds, not a cold multi-minute build.

Free space was ~113 GiB before the lane's heavy work, and is ~119 GiB at
handoff. The cleanup's own measured free-space change is **118.44 → 118.67 GiB**;
removed directory sizes are not claimed as reclaimed blocks. `cleanup.json`
records exact bytes and removed paths. No snapshots were thinned or other
checkouts/data modified. Branch: `gpuix/loops8`, base `3a0247f7`.

## Gradient shimmer specification (not implemented)

Desktop source: `apps/desktop/src/styles/kybern.css:162–205`.
The current native prototype uniformly changes alpha over 1.6 s. Desktop paints
the base string in `--muted-foreground`, then overlays the same glyph mask with
`--foreground` through a moving transparent/highlight/transparent gradient.
Its linear cycle is **2 s**, gradient background width **400%**, and stops are
40% transparent, 50% highlight, 60% transparent. Background position moves
100% → 0%. Reduced motion disables the animation and leaves the base label.

For a label of width W, let phase run 0 → 1 over two seconds. The highlight
center in label coordinates is `-W + 3W * phase`; its half-width is `0.4W`.
The shader's highlight coverage is
`max(0, 1 - abs(x - center) / (0.4W))`, sampled per fragment, including within
a single glyph. Composite this foreground overlay over the base tint, then
apply the existing glyph-atlas coverage and rounded content mask. Per-glyph
uniform tinting cannot produce the same clipped gradient.

A native implementation should retain per-leaf label bounds, base/highlight
colors and one phase value; glyphs reference that leaf's metadata. Update phase
at native display ticks without text shaping, atlas writes, React commits or
layout. Text, bounds, inherited tint, selection and clipping changes keep their
ordinary invalidation. Selection washes must not be tagged. Reduced motion,
unmount and occlusion must park the source and release any retained target.

Acceptance needs matched desktop/GPUIX phase strips in all four modes, a
within-glyph gradient assertion, native selection/focus/Unicode checks, exact
region/full redraw pixels, and repeated running-thread resource controls.
