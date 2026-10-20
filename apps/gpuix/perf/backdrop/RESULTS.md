# Backdrop kernel validation — 2026-10-19

Validation is complete, with **limited performance acceptance**. The kernel reduces streaming process GPU work against its byte-preserved, same-addon legacy control: **9.9% forward and 16.0% reverse**. Against the original addon the measured reduction is **2.4% forward and 12.6% reverse**, showing substantial session/order variation. There is no demonstrated general CPU, memory, broad-filter or scrolling improvement. Do not mark the overall smoothness/no-regression gate closed: streaming p95 remains above 16.7ms, and the filter-free Explorer acceptance run regressed and contained a 537ms gap.

Addon: `1f4180ed30dfa47124b10b621a3fa1753aa84d43164fc86458ce5f8cb4ddd88b`.
Original reference: `1145f7914ae87f5cedd5993fdced48f07ea09a3824aad781dcbd8d78d236a5f8`.

## Findings and references

Zed uses behind-window `NSVisualEffectView` vibrancy for blurred window chrome, below its Metal content; plain transparency alone does not provide blur. [Zed window.rs](https://github.com/zed-industries/zed/blob/56934ec0560bce8929025497411de7f5322fb6ca/crates/gpui_macos/src/window.rs#L1866), [effect-view setup](https://github.com/zed-industries/zed/blob/56934ec0560bce8929025497411de7f5322fb6ca/crates/gpui_macos/src/window.rs#L3808).

Zeron shares native desktop vibrancy for its shell, but also uses **16px in-scene frost** for floating UI. ZUI snapshots current content with a three-sigma halo, applies cached MPS kernels and reuses bounded scratch textures. It caches resources, not unchanged backdrop pixels. [Zeron frost.rs](https://github.com/zeronsh/zeron/blob/c526d6f7cfc7a53e5588e3e6c5df7484a14d649f/crates/ui/src/frost.rs#L1), [ZUI renderer](https://github.com/zeronsh/zui/blob/361ff20b919fdfb80199ee6d9aed725300cb7d54/crates/gpui_macos/src/metal_renderer.rs#L1000), [bounded scratch reuse](https://github.com/zeronsh/zui/blob/361ff20b919fdfb80199ee6d9aed725300cb7d54/crates/gpui_macos/src/metal_renderer.rs#L1357).

GPUIX already uses native compositor material for window chrome. Replacing an in-app popup filter with a behind-window view would sample the desktop rather than app text. In the matched 2560×1640 traces, streaming has median **nine word filters / 18 filter draws**. Ordinary thread/sidebar/Explorer scrolling has **zero**. The old 49-sample fragment recomputed Gaussian exponentials per fragment; the candidate precomputes weights and folds narrow linear samples. Streaming median taps fall **49→5**, with draw/pass counts unchanged. All three addons have the same 16,793,600-byte path intermediate allocation; the earlier fourfold viewport mismatch is resolved. Full immutable citations and renderer details are in [RESEARCH.md](RESEARCH.md).

## Per-surface decisions

| Surface / current callsite | Desktop source / look | Decision |
|---|---|---|
| Window frame, rail, sidebar, title bar | `kit.css:120,174,465`; `lib/kit/theme/theme.logic.ts:812–821` explicitly sets sidebar CSS filter to none over Tauri vibrancy | (a) Existing native under-window material plus theme fills; no scene blur to remove. Preserve. |
| Workspace/dock/settings planes | `kybern.css:582–618` translucent theme fills | (a)/(d) Existing shared compositor material and plane fills. No extra pass. Opaque/accessibility retains flat fills. |
| Composer body (`src/composer.tsx:565`) | `kit.css:2838–2892`, `kybern.css:611–615,647–658` | Current GPUIX has fill/shadow and no scene backdrop. Preserve existing behavior; full-translucency composer parity is a pre-existing gap, not a performance win. |
| PopupLayer menus, dialogs, pickers (`src/composer/Menu.tsx:141`) | `kit.css:2946–2956`, `kybern.css:621–623` | (c) Keep one scene blur with existing sigma/tint/order; compositor cannot sample underlying Metal scene. Large sigma retains all 49 positions with precomputed Gaussian weights. (d) Existing accessibility/full-translucency gate removes pass. |
| Command palette (`src/nav/overlay.tsx:884`) | Desktop palette has no backdrop filter | (d) Explicit `material="none"`; preserve fill and separate content entrance blur. |
| Split drop target + label (`src/split/Workspace.tsx:267–276`) | `kybern.css:133,158` | (c) Preserve intentional separate visible surfaces; each samples live content. (d) Existing accessibility disables blur. |
| Computer live hover controls (`src/live/ComputerLiveView.tsx:74`) | `kybern.css:445` | (c) Keep one live scene filter; hover and accessibility gates remain. |
| Preview mini header (`src/preview/MiniChrome.tsx:15`) | `kit.css:3785,3811` | (c) Keep scene filter over moving preview; accessibility fallback remains. |
| Toast anchors (`src/shell/toasts.tsx:319`) | Desktop Sonner popover fill + `.t-toast` entrance blur | (d) `{blur:0}` only suppresses legacy anchored backing. No material blur pass; paintTransform entrance/exit blur is content animation and remains. |
| Floating live anchor (`src/live/Floating.tsx:66`) | Floating preview | (d) `{blur:0}` is transparent backing opt-in, not active filtering. |
| Per-word stream fades (`native/patches/stream_fade_window.rs:34`) | `.t-stream-w`: filter blur(1px) → 0 | (c) Exact dense-kernel reconstruction for device sigma <=8; 49 taps become <=25 (typically <=7 for Retina word blur). Preserve two-pass order, sigma, opacity, clip, timing. |
| Subtree animation blur (`subtree_transform*`) | `.t-toast`, pop/entrance filters | (c) Same exact narrow kernel where eligible. Broad radii retain all original sample positions. |
| `BACKDROP.popup`/`liveScrim` definitions | Reserved presets | No active direct callsites found; do not count definitions as rendered surfaces. |

The prior perf-gpu “nine backdrops” are streaming **word filters**, not nine
persistent sidebar/composer materials. Ordinary thread/sidebar/Explorer scenes
have zero backdrop draws. Surface caching needs source-content/damage provenance
including filter halos, ordering barriers, transforms, atlas updates and nested
filters; no safe cache can use a widget's own unchanged React props as proof.


## Changes, file by file

Native patches:

| File | Change |
|---|---|
| `native/patches/backdrop_kernel.rs` | Once-per-submission normalized Gaussian weights. Exact texel reconstruction for device sigma≤8; ≤25 reads, ≤7 for sigma≤2. Wider filters retain all 49 original positions. Invalid kernels fall back to legacy. |
| `native/patches/backdrop_kernel_gpui.py` | Reconstruct separate legacy/weighted Metal fragment functions and selected pipeline pair. The legacy fragment stays byte-for-byte unchanged; only optimized draws upload the 800-byte uniform. `KYBERN_BACKDROP_KERNEL=0` selects legacy. Trace taps only outside acceptance samples. |
| `native/patches/backdrop_gpui.py` | One additive reconstruction hook after existing patches. |
| `native/patches/automation_display.rs`, `automation_display_hooks.py`, `apply_hooks.py` | Shared `29268adf` + `c1ab6aaf` placement: automation selects the hidden test display, with CG point bounds. Every pre-existing hook is preserved. |

Other files:

| File | Change |
|---|---|
| `native/README.md` | Kernel contract and comparison control. |
| `src/shell/window.ts` | Shared MVP hidden-open and origin-based test-display placement, avoiding AppKit frame-string snapping. |
| `perf/pacing-app.ts` | Wait for frame restoration before any ordering; background runs never activate the app. |
| Native capability/decoration/clip labs | 820-point content height, keeping title bars inside the 900-point display. |
| `perf/bench/seed.ts` | Optional persisted actual-idle state and prebuilt wheel helper; default callers unchanged. |
| `perf/backdrop/` | Research, scalar/GPU corpus, production/accessibility/headless-reference checks, safe build/quiet wrappers, readiness/window/capture guards, matched measurements and summaries. |
| `perf/test-display/` | Shared helper source/documentation from MVP. This lane never starts, stops or configures the helper. |

Build and quiet wrappers set `GPUIX_BACKGROUND=1`. Preload rejects a missing flag before native launch. Readiness requires the active test-display id, 2× scale and CG x<0/y≥900; each capture/resource window requires full containment and on-screen membership. Both endpoint screen checks must be unlocked/awake. Build markers cover the entire updater and all ancillary checks; measurements use bounded quiet windows/UI leases and scoped caffeinate. No production sigma, tint, opacity, saturation, clip, scene order, motion or cadence changes.

## Tried and dropped

A behind-window NSView cannot sample underlying Metal app text. A cache keyed only by a popup's own React props misses damage beneath it. Both were rejected. MPS/downsampling changes the existing narrow discrete filter and intermediate rounding, so it was not adopted. Pixel caching would need source-damage/halo/order/transform provenance; none is implemented. Existing resource reuse is preserved. Encoder continuation and scratch-size buckets remain separate, unmeasured candidates.

V1 combined loops in one fragment and uploaded the kernel even for the legacy control. It preserved pixels but did not beat the original; it was rejected. V2 isolates fragments and uploads. Metal rejected `kernel` as a reserved parameter name; the compiled version uses `weights`. Old occluded/mismatched-viewport samples remain rejected under `v1/` and `rejected-*`.

The first resumed updater omitted `GPUIX_BACKGROUND=1` and its first lab appeared on the built-in display. It was stopped when the guard rejected placement; no capture was accepted. Both wrappers and the pre-launch check now enforce the flag. The subsequent full updater passed on the hidden display. Evidence: `rejected-resume-missing-background.log` and `native-updater-passed.log`.

## Workload and measurement limits

Apple M1, macOS 27, Bun1.4.0, GPUIX0.10.0; hidden 1440×900 logical test display at2×/60Hz. App windows are1280×820, render targets2560×1640. **`KYBERN_FULL_RATE=1` for every reported sample.** Synthetic300 threads/20 projects,3000-turn history,12405-file Explorer tree; scratch daemon4337. Ten-second warmup then three15-second resource windows per active scenario. Input is scheduled native GPUI wheel RPC at120Hz with phase markers and synthetic exponential momentum, not physical trackpad input.

Intervals are native submissions, not display-present fences. Latency is RPC→submission receipt, not input-to-photon. CPU/GPU costs per submission divide process totals by submissions; AGX process GPU work excludes WindowServer/daemon and is distinct from command elapsed wall time. No energy,120Hz hardware or universal60fps guarantee is established. Short GPU-trace runs are diagnostic only and varied substantially.

## Main acceptance medians

Original addon, same-addon legacy, then candidate; each has12 accepted samples. All36 passed screen, display/window, build-overlap and orphan-process guards; active samples have positive GPU work and substantial submissions. Values are medians of three windows, not worst-case tail guarantees.

## backdrop-before

| Scenario | p50/p95/p99 ms | >16.7/>33 | Proxy p95 | CPU % | GPU ms/15s | GPU ms/submission | CPU ms/submission | MiB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| streaming | 16.67/22.81/28.73 | 441.00/2.00 | — | 42.28 | 4118.50 | 4.48 | 6.95 | 244.00 |
| thread-scroll | 16.67/17.12/19.51 | 368.00/0.00 | 13.96 | 49.37 | 2645.20 | 2.82 | 7.90 | 249.00 |
| sidebar-scroll | 16.70/17.48/18.21 | 469.00/0.00 | 16.21 | 46.90 | 3221.40 | 3.49 | 7.49 | 244.00 |
| explorer-scroll | 16.67/16.83/19.23 | 320.00/0.00 | 15.49 | 49.61 | 2737.90 | 2.92 | 7.94 | 301.00 |

## backdrop-control

| Scenario | p50/p95/p99 ms | >16.7/>33 | Proxy p95 | CPU % | GPU ms/15s | GPU ms/submission | CPU ms/submission | MiB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| streaming | 16.65/24.91/30.12 | 414.00/4.00 | — | 41.40 | 4463.60 | 4.86 | 6.78 | 248.00 |
| thread-scroll | 16.67/17.52/18.12 | 433.00/0.00 | 12.89 | 46.98 | 3511.40 | 3.74 | 7.64 | 254.00 |
| sidebar-scroll | 16.67/16.98/18.29 | 367.00/0.00 | 12.76 | 48.96 | 2585.50 | 2.77 | 7.84 | 243.00 |
| explorer-scroll | 16.67/16.84/18.42 | 316.00/0.00 | 12.71 | 49.54 | 2728.10 | 2.91 | 8.05 | 306.00 |

## backdrop-after

| Scenario | p50/p95/p99 ms | >16.7/>33 | Proxy p95 | CPU % | GPU ms/15s | GPU ms/submission | CPU ms/submission | MiB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| streaming | 16.66/24.97/30.39 | 423.00/2.00 | — | 41.85 | 4020.10 | 4.38 | 6.83 | 248.00 |
| thread-scroll | 16.66/17.04/19.99 | 376.00/0.00 | 16.16 | 49.37 | 2922.00 | 3.11 | 7.94 | 256.00 |
| sidebar-scroll | 16.70/17.50/18.18 | 469.00/0.00 | 14.77 | 47.43 | 3260.40 | 3.47 | 7.67 | 243.00 |
| explorer-scroll | 16.67/18.20/20.58 | 394.00/1.00 | 15.90 | 56.72 | 1218.00 | 1.34 | 9.37 | 313.00 |



The candidate saves **443.5ms/15s (9.9%)** versus same-addon legacy in streaming, with GPU/submission4.86→4.38ms. Reverse order gives2215.5→1862.1ms (**16.0%**) and2.40→2.02ms/submission. CPU differences are below three percentage points; no CPU/memory reduction is claimed. The original-addon forward comparison4118.5→4020.1ms is only2.4%; reverse4320.4→3775.0ms is12.6%. Report both rather than selecting the larger result. Streaming pacing does not improve consistently against the original (forward p95 22.81→24.97ms; reverse24.38→23.52ms).

Filter-free GPU totals vary too; their reductions/increases cannot be credited to a kernel that is never called. The main Explorer candidate's CPU49.61→56.72%, p9516.83→18.20ms and footprint301→313MiB regress. One sample has a536.862ms maximum gap; the median per-window maximum is118.653ms. The counter snapshots are identical across addons:13,594 dock hosts and12,408 native file-tree slots, with only130 mounted React dock row components. Diagnostic Explorer CPU was also high (56.73/59.09/64.58%). The cause of the additional drift/hitch is unresolved; no smooth-Explorer or whole-app no-regression claim is made.

## Broad surface, reverse controls and idle

The moving device-sigma32 surface, legacy/candidate: CPU58.28/56.92%, GPU3153.6/3235.4ms per15s, GPU/submission3.33/3.44ms, p9518.34/17.56ms, footprint148/145MiB. No broad-filter resource win is demonstrated. Both settled broad surfaces have exactly0 submissions/0 GPU work.

Home idle (20s settling, three15s windows per addon): original/control/candidate all exactly**0 submissions/0 GPU work**. CPU5.31/4.91/5.91%, footprint193/190/190MiB. No new idle frame or timer is introduced by the kernel. Full reverse/diagnostic medians, CPU/submission and scene counts are in `results.json`; raw external tables are `tables.md`.

## Visual validation and regression checks

- Full `native/update.sh` passed end to end: native unit/arena checks, geometry, scoped paint/islands, clipping, rounded input/text, selection/editing/close guard, transform, font/stroke, Markdown/documents/code/diff/syntax, native pointer routing, scroll caches and phased wheel input.
- `pnpm typecheck`, `pnpm exec tsc -p native/tsconfig.json`, `pnpm exec tsc -p perf/backdrop/tsconfig.json`, frozen-lockfile install and `bun test ./src` pass:337 tests,6912 assertions,0 failures.
- Two scalar-kernel tests cover804 sigmas and interior/clamped positions. Fresh GPU corpus:16 control/candidate pairs,18,510,336 interior pixels, max channel difference2/255, zero pixels above2; both themes, all four material/accessibility modes and still/moved source. Raw labs deliberately exercise filters even under accessibility flags; product gates are checked separately.
- Fresh production streaming, palette and popup captures cover both themes and both kernel controls. Live product material checks cover opaque/translucent/reduced-transparency/increased-contrast/restored states. Headless WebKit CSS-material and contrast-media checks pass. No Tauri app is launched.

Evidence root: `/Users/mymac/projects/ade/previews/gpuix/perf/backdrop/`.

| Evidence | Contents |
|---|---|
| `native-updater-passed.log`, `native-checks/` | Full fresh updater and native regression corpus. |
| `kernel-visual/results.json`, paired PNGs | Strict shader pixel comparisons. |
| `stream-visual/` | Fresh production streamed-text images in both themes/controls. |
| `product-visual/kernel-{0,1}/` | Fresh production palette/popover images; historical desktop references are retained. |
| `product-visual/accessibility/` | Fresh native accessibility/material captures. |
| `compositor-reference/headless/` | Desktop frontend WebKit materials, still/hover/scroll, both themes. |
| `details-resumed.log`, `acceptance-resumed.log`, `backdrop-*.json` | All matched samples, reverse controls, idle checks and diagnostics; raw scenario directories remain. |
| `window-guards.jsonl`, `display-readiness.jsonl` | Accepted/rejected bounds, display scale/presence and on-screen guards. |
| `summary.json`, `tables.md`, `surface/results.json`, `addon-manifest.json`, `cleanup.json` | Summaries, broad probe, hashes, validation and cleanup evidence. |

Headless WebKit's screenshot backend omits compositor blur, so it cannot establish compositor-pixel equality. Product state-delta rescore lacks baseline states and reports `MISSING`; it is not a passing pixel-parity metric. Existing desktop/native pair images differ in layout/provider/material state. Strict native kernel comparisons establish shader preservation; full packaged Tauri material parity remains unverified.

## Remaining gaps and handoff

The broad smoothness/no-regression gate is partial: Explorer drift/hitch is unresolved; streaming p95 remains21–25ms; physical input/presentation latency, energy and ProMotion are unmeasured. Dense native Explorer slots, startup/older-history loading and existing composer full-translucency parity are outside this kernel change. No stale backdrop-pixel cache, source-damage cache or render-pass-count reduction is claimed. Merge/review this as a limited kernel optimization, not completion of the overall performance goal.

Branch: `gpuix/perf-backdrop`. Final report commit is recorded in the external manifest after commit. The validated addon/webview bridge and unique original addon are retained in `native/build/`; no target/upstream/dependency tree remains. Owned scratch processes/data, test binaries and redundant outputs are removed after process/open-file checks; no normal daemon/data or virtual-display configuration is touched. Raw bench summaries were copied to external evidence before removing disposable checkout copies. Source and worktree registration remain.

Free disk:91GiB before resumed work;84GiB at final verification after cleanup (`df -h`). The volume is shared with concurrent lanes and APFS can retain deleted blocks; no claim is made that directory size equals reclaimed free space. Evidence retained externally is about295MiB, needed for review. No large generated build directory remains in this lane.
