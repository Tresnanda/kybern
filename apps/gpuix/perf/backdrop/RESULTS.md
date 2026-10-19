# Backdrop GPU optimization

Status: blocked before final acceptance. No GPU speedup is accepted, and the candidate must not be merged as a proven optimization. The active built-in display is unavailable; the lane is waiting without launching apps.

## References and surface decisions

See [RESEARCH.md](RESEARCH.md) for immutable Zed, Zeron and ZUI source citations and the complete per-surface table. Zed and Zeron use compositor behind-window vibrancy for the shell. Zeron also keeps one in-scene Gaussian layer for floating frost, with cached MPS kernels and bounded scratch allocations. Neither reference establishes free system-wide blur or a reusable unchanged-pixel cache.

GPUIX already follows the compositor approach for window chrome. The measured streaming backdrop records are per-word animation filters. Prior perf-gpu accounting reports no backdrop filters in ordinary thread, sidebar and Explorer scrolling; fresh viewport-matched traces will reconfirm this. Floating scene filters must continue sampling moving app content; window vibrancy samples the desktop behind the window.

## Implementation

Native patches:

- `native/patches/backdrop_kernel.rs`: precompute Gaussian weights once per submission; fold narrow kernels into equivalent hardware-linear taps. Device sigma <=8 needs <=25 reads, and the word-animation range <=2 needs <=7. Wider filters preserve all 49 original sample positions. Disabled or invalid normalized kernels retain the legacy shader path; the existing minimum-sigma normalization remains.
- `native/patches/backdrop_kernel_gpui.py`: reconstruct the patched renderer and Metal shader, compile separate legacy and weighted fragment functions and select one pipeline pair, upload the 800-byte kernel only to optimized passes, retain legacy A/B control `KYBERN_BACKDROP_KERNEL=0`, and trace tap counts separately from timed runs.
- `native/patches/backdrop_gpui.py`: append one reconstruction hook after existing patches.
- Shared placement patches from orchestrator `29268adf`: `automation_display.rs`, `automation_display_hooks.py`, and one `apply_hooks.py` hook. These target an active built-in display for automated native fixtures. They are now included in source but await the next full rebuild.

Other changes:

- `native/README.md`: kernel contract and control.
- `src/shell/window.ts`, `perf/pacing-app.ts`: shared automation placement, restoration while hidden, actual-frame verification, and no early ordering before restoration.
- Native capability, decoration and clipping lab viewports: 820-point content height so native title bars fit inside the built-in display.
- `perf/bench/seed.ts`: optional actual-idle fixture status and prebuilt wheel helper; defaults for other callers remain.
- Display-presence probes and pre-launch guards: an awake/unlocked external-only session cannot launch this lane’s fixtures.
- `perf/backdrop/`: cited research, reproducer, safe build/quiet wrappers, kernel/product/compositor visual checks, shared benchmark driver, broad live-surface probe, summary extraction. No application themes, blur radius, clipping, opacity, saturation, animation timing, frame pacing or scene order changes.

## Tried and dropped

A behind-window NSVisualEffectView cannot blur app text underneath an in-scene popup. A cache keyed only by surface React props misses damage below it and was rejected. Downsampling/MPS would change the existing narrow discrete filter and intermediate rounding; neither was adopted. Resource reuse already exists independently. The attempted shader parameter name `kernel` was rejected by Metal because it is reserved; `weights` fixes it. Test-launcher path failures were fixed without dependency changes.

## Validation and visual evidence

Kernel V2 addon `07e2124ed4163c775372495763fb377ef575e7141dd0d60f659cda3253870f53` passed full `native/update.sh` with the on-screen/built-in guard before the later shared native placement patch was added. This covered its existing geometry, scoped-paint, clipping, rounded text/input, transform, font, Markdown, code/diff, scroll-cache and backdrop checks. The additive kernel tests cover 804 sigmas and interior/clamped source positions. The native GPU image corpus covers 16 before/after pairs, 18,510,336 interior pixels, both themes and opaque/translucent/reduced-transparency/increased-contrast flags, with stationary and shifted content. Maximum channel difference is 2/255; no pixels differ by more than 2. Raw filter labs deliberately exercise filtering under accessibility flags; historical V1 product checks verified actual accessibility gates live in both themes. Fresh V2 product checks remain pending.

Evidence root: `/Users/mymac/projects/ade/previews/gpuix/perf/backdrop/`.

- `native-updater-passed.log`, `native-checks/`: the successful V2 updater and existing native checks; `native-update.log` also retains later stopped ancillary attempts.
- `kernel-visual/results.json` and paired PNGs: shader control/candidate and moving source.
- `product-visual/kernel-{0,1}/`: historical V1 desktop/native visual-pair tooling, palette and composer popover scenes in both themes.
- `product-visual/accessibility/`: historical V1 live product opaque/translucent/reduced-transparency/increased-contrast captures.
- `v1/stream-visual/`: historical production streamed text captures in both themes, outside timing windows. Fresh production captures remain pending.
- `compositor-reference/`: cached historical headed WebKit surface captures, still/hover/scrolled, both themes, opaque/translucent/increased-contrast. `materials.json` verifies contrast media matching and disabled filter. The browser API does not emulate reduced transparency; that state is verified in the native product check.

Existing desktop/native pair captures differ in layout, selected provider and material snapshots; their differing-pixel percentages are not an optimization regression metric. Native control/candidate comparisons establish shader preservation. Cached headed captures are retained as historical compositor references. New reference runs use headless WebKit as required by the user; its screenshot backend may omit compositor backdrop filtering. Full packaged Tauri accessibility parity is not established by the WebKit fixture.

## Measurement contract

Apple M1, 60Hz Retina display; `KYBERN_FULL_RATE=1`, RPC wheel input at120Hz, scratch daemon port4337, 300 threads/20 projects, 3000-turn history and 12,405-file Explorer fixture. Ten-second warmup, three15-second resource windows per scenario. Original addon, same-candidate legacy control and optimized candidate run separately. Trace accounting and reverse-order streaming runs are outside the main acceptance samples. Frame intervals are native submission intervals; process GPU is per-PID AGX work, excluding WindowServer. Proxy timing is not physical input-to-present latency. No energy or ProMotion/120Hz guarantee is inferred.

## Measurement results

The first candidate is rejected. It placed both loops in one fragment and uploaded the 800-byte constant even for the control. It passed visual equivalence but did not improve streaming GPU against the original addon. V2 isolates the original fragment byte-for-byte and creates only the selected pipeline pair; its final measurements are pending.

V1 median, three 15s runs after 10s warmup; original / same-addon legacy / optimized:

| Scenario | CPU % | GPU ms/15s | MiB |
|---|---:|---:|---:|
| Streaming | 28.52 / 40.78 / 29.19 | 2729.8 / 4048.6 / 3275.3 | 234 / 236 / 236 |
| Thread scroll | 39.82 / 46.52 / 46.06 | 1128.9 / 1370.1 / 1358.7 | 235 / 215 / 215 |
| Sidebar scroll | 43.40 / 46.52 / 47.85 | 1170.9 / 1230.8 / 2539.8 | 224 / 205 / 242 |
| Explorer scroll | 50.81 / 49.42 / 57.86 | 1271.5 / 1282.8 / 1125.6 | 266 / 264 / 266 |

Streaming GPU/submission was 2.96 / 4.44 / 3.57ms; p95 was 20.06 / 24.09 / 21.03ms and p99 22.90 / 28.03 / 23.47ms. Static scene differences require per-scene accounting; these are not attributed to blur. Sidebar path-intermediate allocation is 4,198,400 bytes in original/control, but 16,793,600 in the slow candidate samples, with identical host and mounted-row counts. The attachment area changed fourfold; separate viewport traces are required to identify why before comparing those windows. Evidence is retained under `v1/`.

The old idle fixture persisted a running thread while overriding frontend status; it was not a valid settled idle acceptance fixture. Dedicated V2 idle runs persist actual idle status, disable counter probes and warm 20s; they must have exactly zero submissions and GPU work.

Earlier updater capture failures occurred before any blur state, while the built-in display showed a full-screen Space. They are discarded occlusion evidence (`rejected-native-v2*`). New guards check CoreGraphics on-screen membership and complete containment in the built-in display before and after captures/resource windows, without focusing or moving windows. A later island baseline comparison failed before filter checks; it did not recur with the guarded launcher. The guard also rejected three over-height native fixtures; their content heights are now 820 points, allowing the 32-point title bar to fit. All those functional checks passed. A fresh production fixture then opened on GA271 (X2080,Y310,W1280,H820), confirming that the primary-display assumption was insufficient. It was closed without capturing, and production main now opens hidden, computes the actual built-in display geometry, restores there and shows without activation. The pacing entry waits for restoration. Source checks and 337 tests passed; production visual confirmation is pending. At 03:42Z the built-in display became unavailable; CoreGraphics reported only a 1920×1080 external display while the session remained awake/unlocked. All app work is paused until an active built-in display is available. Presence checks now precede fixture launches, and the shared native display patch from orchestrator 29268adf is included in source for the eventual full rebuild.

## Remaining gaps and handoff

Pending a full rebuild with the shared placement patch, fresh production visual checks, viewport-matched paired resource measurements, exact-zero idle verification and cleanup. Current headless checks pass: pnpm typecheck, native tsc, perf/backdrop tsc, and 337 source tests (0 failures, 6912 assertions; `headless-tests-latest.log`). The standalone kernel tests passed 2/2 across 804 sigmas. Original reference addon SHA256 remains `1145f7914ae87f5cedd5993fdced48f07ea09a3824aad781dcbd8d78d236a5f8`.

Generated native targets/dependencies are temporarily retained for the pending rebuild; they are not committed. No fixture app or scratch daemon remains running. The wrapper only polls for an active built-in display before claiming a slot. No inactive-display sample is accepted. Encoder continuation and scratch-size buckets are cited research candidates, not active changes. Pre-existing desktop/composer full-translucency parity remains outside this kernel optimization. No source-damage-based pixel cache is implemented. Pass/encoder count remains unchanged; this change reduces filter arithmetic and eligible sample reads.
