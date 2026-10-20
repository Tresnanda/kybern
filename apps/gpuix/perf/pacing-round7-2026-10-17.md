# Frame pacing, PR scrolling and passive Metal damage — round 7

**Status: partial acceptance.** Shared display callbacks, display-rate wake and frame-local drawable release are enabled. Smooth app-loop integration (including native matrix/task loops), retained region rendering and native glyph tint remain **opt-in**: correctness, target release and idle controls pass, but repeated full-app GPU samples did not consistently meet the approved running-thread gate. R3-8 and round-one item 10 are **partial**, not closed.

## Root causes and changes

1. The shared loader clock sampled at 200 ms (5 Hz). Matrix variants, task glyphs, connection spinner and transcript live labels visibly stepped. The new native/frame.ts provides the requested onFrame(callback): unsubscribe contract: one native subscription, monotonic milliseconds shared by all callbacks, bounded acknowledgements, stale-generation protection, and no subscription without consumers or while hidden. Older addons use one scheduled 60 Hz timeout. main.tsx installs the existing renderer. A display-source callback is not a physical presentation fence.
2. Native animations were delivered at an inactive/background cadence and the Bun host polled between display ticks. Selective integration of f9e5e2a7 adds acknowledged display wake and full-rate inactive motion. Both now default on; KYBERN_VSYNC_WAKE=0 / KYBERN_FULL_RATE=0 retain comparison paths. That branch was not merged wholesale.
3. Existing scoped paint already skipped element render/layout for eligible fixed leaf colors, but cloned/replayed/sorted the full scene and submitted the full Metal window. paint_buffers_gpui.py now updates stable typed GPU slots directly. Geometry, inherited state, structure and text changes keep normal invalidation.
4. paint_region_gpui.py + paint_region_renderer.rs + paint_region.metal add a lazy retained color target, exact full-target reconstruction after ordinary scene generations, and damage-union scissoring on passive frames. Paths and backdrop filters conservatively fall back to full rendering. The target is discarded when passive loops park, on occlusion, resize or backing-size changes. Enable with KYBERN_REGION_PAINT=1. It is not permanent idle memory.
5. Simple native glyph tint preserves focus and selection without a React update per frame. frame_gpui.py deduplicates curve evaluation per leaf rather than once per glyph. Enable with KYBERN_NATIVE_PAINT_ANIMATIONS=1 and KYBERN_NATIVE_TEXT_PAINT=1. Within the opt-in integration, the JS live label uses the continuous shared frame clock; the native glyph flag avoids that cost. This preserves the port's existing uniform pulse; the desktop's gradient-clipped shimmer remains a visual parity gap.
6. Repeated addon captures exposed an embedded drawable-lifetime problem: an AppKit autorelease pool could span multiple draws/captures. Frame-local pools now wrap MetalRenderer.draw and render_to_image. Old captures 3/7 stalled for 1,116/1,099 ms; the fixed binary completed all ten at 81–88 ms. The old sampled stack blocked in CAMetalLayer.nextDrawable / semaphore_timedwait_trap. No-capture PR baselines had p95 below 20 ms. This establishes capture contamination; it does not establish that a one-second physical user-scroll stall is fixed. A later experimental blit control also had one 1,450 ms outlier and target reallocation; it is excluded and the blit experiment was rejected.
7. Within the opt-in loop integration, Tasks running glyph holds its ring stationary and pulses only its pie fill with the desktop's 1.6 s alternating curve. Connection spinner uses a stationary ring and continuously rotating arc. Elapsed labels use an independent visibility-aware one-second clock, including under reduced motion.

## Environment and limits

Apple M1, macOS 27, Bun 1.4.0, GPUIX 0.10.0. Scratch installed daemon: port 4274, round7-pacing data; deterministic PR proxy; no real-daemon mutations or model turns. Frozen dependencies only; cached Playwright 1.62.1 / WebKit 2336, no downloads or package upgrades.

Resource controls use 10 s warm-up (the later running-thread pair uses 30 s), then 15 s process CPU-time and per-PID AGX accumulatedGPUTime deltas, followed by physical footprint. Daemon and WindowServer are excluded. Other host processes remain. Differences under roughly three CPU percentage points are not demonstrated wins; GPU samples varied substantially across the session. These are process GPU-time observations, not energy or battery measurements.

Native windows hold a fair-queued atomic UI lease, are ordered visibly without activation and launch with GPUIX_BACKGROUND=1. Resource controls ignore physical mouse input and park the synthetic pointer outside controls; a hovered tooltip otherwise legitimately introduces a backdrop and selects full rendering. Captures happen outside timed scroll windows. Paused strips document curves, not live cadence. The region comparison excludes 2-pixel window edges and conservative 52×52-pixel bottom-corner squares, which include the OS corner antialiasing. The remaining client pixels compare exactly; raw differences in excluded areas are retained and counted separately.

The PR fixture contains 30 rows, a 40-section formatted description, 30 files with 2,400-line patches each, and 30 review entries. Each scene receives 180 wheel packets scheduled at 60 Hz, half down and half up. Native RPC-to-post-draw stderr receipt includes transport; desktop next-rAF latency is a different proxy. Neither measures physical input-to-photon latency. The desktop reference is the actual frontend in Playwright WebKit, **not a native Tauri/WKWebView host measurement**.

## Resource samples and default decision

| Source / renderer | Scene | CPU % | GPU ms / 15 s | MiB | Frames | p50 / p95 ms | React / island renders |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| baseline | tasks | 3.17 | 48.03 | 224 | 75 | 200.89 / 216.52 | 75 / 0 |
| native | tasks | 10.20 | 367.00 | 196 | 902 | 16.67 / 18.58 | 0 / 0 |
| region | tasks | 4.25 | 99.23 | 224 | 901 | 16.67 / 17.72 | 0 / 0 |
| baseline | home | 2.58 | 1.85 | 201 | 2 | 28.19 / 28.19 | 2 / 1 |
| region | home | 4.04 | 0.32 | 161 | 1 | — / — | 2 / 1 |
| Old 5 Hz, first local fixture | thread | 4.98 | 75.83 | 218 | 75 | 200.96 / 225.55 | 77 / 227 |
| Rejected 60 Hz JS shimmer | thread | 18.94 | 723.00 | 232 | 902 | 16.67 / 18.63 | 919 / 1733 |
| Native glyph + region, first control | thread | 9.36 | 68.79 | 220 | 902 | 16.67 / 18.51 | 18 / 3 |
| Earlier all-on candidate | home | 2.19 | 0.50 | 191 | 1 | — / — | 2 / 1 |
| Earlier all-on candidate | settled-thread | 1.86 | 3.34 | 206 | 2 | 11.52 / 11.52 | 3 / 2 |
| Old 5 Hz, persisted running fixture | thread | 7.50 | 132.70 | 195 | 75 | 200.72 / 221.34 | 75 / 220 |
| text-region-old-evaluation | thread | 12.86 | 296.62 | 219 | 903 | 16.67 / 18.52 | 15 / 2 |
| text-region-dedup | thread | 4.92 | 346.34 | 216 | 902 | 16.67 / 18.63 | 15 / 0 |
| text-full | thread | 7.24 | 845.81 | 201 | 901 | 16.67 / 18.27 | 15 / 0 |
| Earlier all-on candidate | tasks | 8.02 | 549.43 | 217 | 903 | 16.67 / 18.25 | 0 / 0 |
| Final defaults (historical loops retained) | home | 3.25 | 1.89 | 192 | 2 | — | 2 / 1 |
| Final defaults (historical loops retained) | settled-thread | 2.79 | 3.38 | 200 | 3 | — | 3 / 2 |
| Final defaults (historical loops retained) | tasks | 4.57 | 59.44 | 200 | 75 | 199.99 / 201.99 | 75 / 0 |
| Final defaults (historical loops retained) | thread | 9.69 | 101.03 | 208 | 90 | 199.87 / 205.50 | 92 / 227 |

The first equal-motion Tasks control improved from 10.20% / 367 ms to 4.25% / 99 ms at 60 Hz. The stepped 5 Hz row is not an acceptable target. That single pair does not establish repeatability: subsequent native-text region GPU controls measured 296–346 ms versus 132.70 ms for the persisted-fixture 5 Hz control, exceeding both that contemporaneous value and the approved historical 75.83 ms ceiling. Native-text deduplication improved CPU from 12.86% to 4.92%, but did not demonstrate a GPU reduction. Thus region and glyph tint remain opt-in.

The experimental fullscreen Metal blit was rejected: Tasks 4.45% / 273 ms included a 1,450 ms outlier and reallocation; running thread 11.14% / 873 ms was worse than shader-copy controls. Source and final addon retain the shader-copy implementation. All exploratory samples are retained in resources.jsonl rather than silently selecting favorable runs.

Earlier all-on idle controls show no recurring animation work: Home 2.19% / 0.50 ms GPU / 191 MiB, settled thread 1.86% / 3.34 ms / 206 MiB, with one/two late startup frames over 15 s. Historical idle-regression report: Home 1.40% / 1.28 ms / 161 MiB; Home with a 5 Hz running row 4.12% / 95.85 ms / 188 MiB; Tasks 6.91% / 77.80 ms / 193 MiB. These differing binaries/workloads are context, not an equal-motion speedup claim.


The subsequent smooth-JS running-thread fallback measured **34.62% CPU / 733 ms GPU / 206 MiB**, 914 React commits and 1,737 island renders at 16.67/18.12 ms. It was rejected as a default. Therefore the complete smooth-loop integration is gated by KYBERN_NATIVE_PAINT_ANIMATIONS=1, with KYBERN_NATIVE_TEXT_PAINT=1 and KYBERN_REGION_PAINT=1 selecting the low-React prototypes. Outside that experiment, the historical clock and visuals are retained; **the default continuous-loop pacing defect remains open**. The approved 60 fps rule is not declared satisfied by retaining 5 Hz. Display-rate wake for existing native transitions is independent and remains enabled.

## Retained target lifetime and pixel controls

- Region 0, same process Home → animated Tasks → parked Home: **189 → 203 → 199 MiB**. No region allocation.
- Region 1, same process Home → animated Tasks → parked Home: **192 → 221 → 205 MiB**. Native allocation and release diagnostics observed.

The region target is 2560 × 1640 × 4 bytes (about 16 MiB). In the pointer-parked repeat, active-to-parked footprint fell 16 MiB with region versus 4 MiB without. Alloc/release diagnostics confirm lifetime; cross-process footprint differences do not isolate the target. Earlier +28 MiB total-process differences were not all attributable to it.

Dark/light × normal/reduced motion: exact client-interior equality against full redraw in seven states (initial, tint, geometry change, backdrop-filter fallback, occlusion/resume, native-window resize, size restore), including matrix, task glyph and native text. Amplified diff PNGs and excluded OS-edge pixel counts remain in region/. Color/opacity/geometry edits, selection, hit testing, focus/editing, removal/remount and target release pass. Runtime filtered fallback is exercised; the paths guard is source-checked, without a dedicated GPUI path scene in this fixture. Backing-size reconstruction is exercised by resize; physical migration across displays with different backing scales **needs a physical two-display test**.

## PR scrolling: before / after / desktop frontend reference

Native values below are post-draw submission intervals. Reference values are rAF intervals. The before configuration selects historical app source/inactive clock/wake; both cost-instrumented runs use the same fixed drawable-pool addon, so the capture bug cannot manufacture a performance win.

| Mode | Scene | Before p50 / p95 ms | After p50 / p95 ms | WebKit p50 / p95 ms | Native RPC→submit p50 / p95 ms | WebKit input→rAF p50 / p95 ms |
| --- | --- | --- | --- | --- | --- | --- |
| dark / normal | list | 16.68 / 26.08 | 16.65 / 17.83 | 17.00 / 18.00 | 5.58 / 8.82 | 16.00 / 17.00 |
| dark / normal | summary | 16.75 / 18.11 | 16.60 / 17.53 | 17.00 / 18.00 | 16.49 / 17.06 | 17.00 / 18.00 |
| dark / normal | changes | 16.66 / 16.77 | 16.56 / 17.88 | 17.00 / 18.00 | 14.23 / 14.77 | 17.00 / 18.00 |
| dark / normal | timeline | 16.64 / 24.82 | 16.66 / 17.66 | 17.00 / 18.00 | 12.14 / 12.86 | 17.00 / 18.00 |
| dark / reduced | list | 16.56 / 18.46 | 16.72 / 17.88 | 17.00 / 17.00 | 5.88 / 7.16 | 17.00 / 17.00 |
| dark / reduced | summary | 17.44 / 18.27 | 16.62 / 32.80 | 17.00 / 19.00 | 16.44 / 16.89 | 16.00 / 19.00 |
| dark / reduced | changes | 16.49 / 17.79 | 16.74 / 30.74 | 17.00 / 18.00 | 14.09 / 14.56 | 16.00 / 18.00 |
| dark / reduced | timeline | 16.50 / 18.07 | 16.66 / 23.33 | 17.00 / 21.00 | 0.10 / 15.89 | 17.00 / 21.00 |
| light / normal | list | 16.70 / 18.05 | 16.67 / 18.65 | 17.00 / 18.00 | 14.77 / 16.58 | 17.00 / 18.00 |
| light / normal | summary | 16.71 / 17.59 | 16.54 / 17.62 | 17.00 / 18.00 | 16.40 / 16.89 | 17.00 / 18.00 |
| light / normal | changes | 16.75 / 17.92 | 16.66 / 16.73 | 17.00 / 17.00 | 16.57 / 16.69 | 17.00 / 17.00 |
| light / normal | timeline | 16.55 / 17.87 | 16.66 / 17.10 | 17.00 / 17.00 | 8.95 / 10.00 | 17.00 / 17.00 |
| light / reduced | list | 16.65 / 17.92 | 16.67 / 22.34 | 17.00 / 18.00 | 0.20 / 6.60 | 16.00 / 18.00 |
| light / reduced | summary | 16.69 / 18.14 | 16.45 / 17.68 | 17.00 / 17.00 | 16.30 / 16.76 | 17.00 / 17.00 |
| light / reduced | changes | 16.73 / 33.29 | 16.61 / 18.14 | 17.00 / 17.00 | 13.97 / 14.39 | 16.00 / 17.00 |
| light / reduced | timeline | 16.58 / 17.67 | 16.62 / 17.87 | 17.00 / 17.00 | 8.50 / 9.14 | 17.00 / 17.00 |

| Normal dark scene | After render p50 / p95 ms | Included layout p50 / p95 ms | Layout calls p50 | React commits / island renders |
| --- | --- | --- | ---: | --- |
| list | 4.97 / 5.68 | 1.82 / 2.24 | 14 | 4 / 270 |
| summary | 15.97 / 16.31 | 11.60 / 11.76 | 34 | 0 / 180 |
| changes | 13.74 / 14.22 | 9.02 / 9.21 | 55 | 0 / 180 |
| timeline | 8.06 / 8.71 | 4.18 / 4.76 | 35 | 0 / 190 |

The long summary still lays out its whole single Markdown virtual row on each scroll frame: about 12 ms of the approximately 16 ms render cost. Changes spends about 9 ms in layout; Timeline about 4 ms. Summary/Changes have zero React commits during scroll, so React is not the dominant cause. GPUI list rebuilds and lays out visible items, including the giant summary row. Existing Markdown parse/syntax caches retain formatted content; they do not retain its entire layout/paint geometry. Region replay only applies to passive tints and cannot remove this scroll layout. Reduced-dark after p95 remains 32.80 ms (summary) and 30.74 ms (Changes): **R3-8 is partial**.

The list, formatted description, file diffs, review entries and controls remain visible in both references. The fixture's missing daemon scopes field initially caused a desktop EnvironmentSwitcher boundary error; scopes=[] fixed it and all four WebKit reference captures were rerun. Native Tauri host latency, matched OS-level physical wheel input and sustained inertial scrolling remain unverified.

## Full-app motion cadence

Each cell is live native draw-start p50 / p95 milliseconds over a short action window, not a GPU presentation fence. Reduced motion intentionally produces only a few discrete updates; large intervals between separate updates in that mode are not continuous-motion dropped frames. Missing samples are explicit.

| Mode | App interaction | Before p50 / p95 ms | After p50 / p95 ms | After frames |
| --- | --- | --- | --- | ---: |
| dark / normal | worked disclosure open | 34.53 / 50.95 | 16.73 / 27.72 | 17 |
| dark / normal | tool disclosure open | 43.69 / 72.96 | 16.55 / 21.48 | 17 |
| dark / normal | tool disclosure close | 35.10 / 42.03 | 16.23 / 18.89 | 16 |
| dark / normal | worked disclosure close | 48.03 / 53.82 | 16.71 / 18.45 | 16 |
| dark / normal | sidebar close and title position | 42.31 / 51.58 | 16.40 / 18.92 | 18 |
| dark / normal | sidebar open and title position | 35.62 / 50.38 | 16.48 / 25.03 | 18 |
| dark / normal | environment open and inset | 34.47 / 58.20 | 16.57 / 22.05 | 21 |
| dark / normal | environment close and inset | 34.29 / 49.85 | 16.65 / 20.65 | 21 |
| dark / normal | dock open | 39.62 / 54.69 | 16.52 / 18.74 | 16 |
| dark / normal | dock add menu | 35.21 / 50.33 | 16.66 / 24.58 | 18 |
| dark / normal | dock tab pill | 16.76 / 24.15 | 18.50 / 19.39 | 4 |
| dark / normal | dock close | 39.84 / 49.33 | 16.59 / 20.71 | 16 |
| dark / normal | composer menu | 46.18 / 54.71 | 16.64 / 18.29 | 17 |
| dark / normal | rail pill and notes section | 37.40 / 44.47 | 16.63 / 21.66 | 19 |
| dark / normal | home stagger | 49.87 / 93.68 | 16.58 / 17.33 | 14 |
| dark / normal | settings entrance | 39.12 / 53.68 | 16.56 / 16.87 | 18 |
| dark / normal | settings tab pill | 35.59 / 54.05 | 16.71 / 18.31 | 15 |
| dark / reduced | worked disclosure open | 17.16 / 271.02 | 275.85 / 275.85 | 2 |
| dark / reduced | tool disclosure open | 78.10 / 78.10 | 149.93 / 149.93 | 3 |
| dark / reduced | tool disclosure close | 19.93 / 19.93 | 348.69 / 348.69 | 3 |
| dark / reduced | worked disclosure close | 15.62 / 15.62 | 15.54 / 15.54 | 2 |
| dark / reduced | sidebar close and title position | 21.38 / 21.38 | 16.79 / 16.79 | 2 |
| dark / reduced | sidebar open and title position | 11.96 / 21.85 | 23.31 / 23.31 | 3 |
| dark / reduced | environment open and inset | 21.96 / 33.74 | 18.35 / 25.19 | 4 |
| dark / reduced | environment close and inset | 26.29 / 26.29 | 27.32 / 27.32 | 3 |
| dark / reduced | dock open | 14.70 / 21.61 | 20.81 / 22.72 | 4 |
| dark / reduced | dock add menu | 20.12 / 20.12 | 19.62 / 19.62 | 3 |
| dark / reduced | dock tab pill | 14.46 / 21.56 | 16.33 / 20.05 | 4 |
| dark / reduced | dock close | 17.00 / 21.86 | 14.22 / 22.10 | 4 |
| dark / reduced | composer menu | 11.23 / 11.23 | 11.75 / 11.75 | 2 |
| dark / reduced | rail pill and notes section | 35.46 / 51.71 | 16.72 / 29.29 | 12 |
| dark / reduced | home stagger | 34.94 / 47.84 | 16.82 / 69.57 | 9 |
| dark / reduced | settings entrance | 38.10 / 50.53 | 16.86 / 21.83 | 13 |
| dark / reduced | settings tab pill | 27.44 / 27.44 | 15.11 / 15.11 | 2 |
| light / normal | worked disclosure open | 34.02 / 72.42 | 16.71 / 66.83 | 18 |
| light / normal | tool disclosure open | 45.55 / 56.47 | 16.74 / 62.76 | 18 |
| light / normal | tool disclosure close | 35.06 / 41.60 | 16.71 / 65.74 | 17 |
| light / normal | worked disclosure close | 35.03 / 43.21 | 16.63 / 18.01 | 16 |
| light / normal | sidebar close and title position | 35.00 / 55.67 | 16.64 / 18.72 | 18 |
| light / normal | sidebar open and title position | 35.70 / 55.22 | 16.69 / 25.87 | 18 |
| light / normal | environment open and inset | 35.49 / 47.36 | 16.59 / 17.73 | 20 |
| light / normal | environment close and inset | 44.71 / 51.93 | 16.61 / 23.04 | 21 |
| light / normal | dock open | 36.01 / 51.12 | 16.30 / 26.92 | 16 |
| light / normal | dock add menu | 35.46 / 47.46 | 16.69 / 30.77 | 18 |
| light / normal | dock tab pill | 13.58 / 32.70 | 15.35 / 15.35 | 3 |
| light / normal | dock close | 34.83 / 46.73 | 16.55 / 33.65 | 17 |
| light / normal | composer menu | 44.94 / 56.33 | 16.66 / 24.20 | 18 |
| light / normal | rail pill and notes section | 40.34 / 51.46 | 16.75 / 28.09 | 18 |
| light / normal | home stagger | 35.99 / 107.50 | 16.78 / 17.22 | 13 |
| light / normal | settings entrance | 36.70 / 49.47 | 16.70 / 26.49 | 19 |
| light / normal | settings tab pill | 35.45 / 52.66 | 16.83 / 17.91 | 16 |
| light / reduced | worked disclosure open | 17.15 / 285.24 | 17.53 / 283.40 | 4 |
| light / reduced | tool disclosure open | 16.76 / 16.76 | 27.86 / 27.86 | 2 |
| light / reduced | tool disclosure close | 19.25 / 19.25 | 266.73 / 266.73 | 3 |
| light / reduced | worked disclosure close | 16.65 / 16.65 | — / — | 1 |
| light / reduced | sidebar close and title position | 25.48 / 25.48 | 9.12 / 9.12 | 2 |
| light / reduced | sidebar open and title position | 16.51 / 22.05 | 26.96 / 26.96 | 3 |
| light / reduced | environment open and inset | 17.33 / 36.42 | 33.83 / 33.83 | 3 |
| light / reduced | environment close and inset | 11.97 / 11.97 | 9.88 / 9.88 | 2 |
| light / reduced | dock open | 21.24 / 24.75 | 16.64 / 20.93 | 4 |
| light / reduced | dock add menu | 18.69 / 18.69 | 17.29 / 17.29 | 2 |
| light / reduced | dock tab pill | 14.30 / 21.16 | 16.66 / 21.43 | 5 |
| light / reduced | dock close | 34.83 / 34.83 | 36.19 / 36.19 | 3 |
| light / reduced | composer menu | 11.56 / 11.56 | 11.89 / 11.89 | 2 |
| light / reduced | rail pill and notes section | 36.48 / 52.58 | 16.78 / 28.02 | 12 |
| light / reduced | home stagger | 51.35 / 87.71 | 16.80 / 82.10 | 10 |
| light / reduced | settings entrance | 44.16 / 51.48 | 16.75 / 21.58 | 13 |
| light / reduced | settings tab pill | 15.05 / 15.05 | 14.72 / 14.72 | 2 |

Normal-dark examples: Environment opening 34.47/58.20 → 16.57/22.05 ms; Home stagger 49.87/93.68 → 16.58/17.33 ms. Some normal-light cold disclosure p95 values still reach 63–66 ms. These measurements use the candidate configuration (all experimental loop flags on) and do not justify saying every transition is a perfect 60 fps. The settled fixtures have no continuous running indicator, so the native wake path is the material transition change.

Four-mode continuous native loop checks: normal dark 16.67/18.54 ms and light 16.67/18.45 ms, 180–181 draws / 3 s, zero island renders; both reduced modes zero recurring draws and static pixels. Matrix orbit/pulse/scan/twinkle, task pie and text tint pixels are exercised. Backpressure, shared subscriptions, stale callbacks, unsubscribe, minimize and unmount parking pass. Desktop component reference rAF p50 is 17 ms and p95 18–19 ms. Its reduced-mode rAF counter still runs for measurement; the CSS animations themselves are disabled.

## Project drag and task invalidation

| Mode | Before project drag p50 / p95 ms | After p50 / p95 ms | After frames |
| --- | --- | --- | ---: |
| dark / normal | 21.78 / 52.70 | 16.71 / 20.03 | 61 |
| dark / reduced | 15.64 / 46.30 | 16.66 / 19.90 | 62 |
| light / normal | 24.18 / 49.03 | 16.68 / 20.12 | 61 |
| light / reduced | 16.40 / 42.57 | 16.67 / 20.06 | 60 |

Actual five-project sidebar drag, 90 pointer moves, drop-order assertion passed in all four modes. These are draw-start intervals. This compares the full scheduling configuration, not region rendering in isolation. tasks7's separately reported baseline was 35.84/39.14 ms and is a different workload.

**Position/translate updates still invalidate sibling and ancestor islands.** The typed/region path bypasses ancestor invalidation only for eligible fixed-geometry leaf color animations; it does not intercept geometry/style mutations from drag. tasks7b reported roughly 216 renders per fixed row island and 320 nav-rail renders over 120 moves, board CPU ~49%, list p95 ~22 ms after removing React commits. Those are sibling-lane observations, not a measurement on this final build. No task drag, sidebar reorder or Explorer source was edited here.

A safe passive subtree translation API needs more than shifting paint: use tasks7b's requested batched setter setSubtreeTranslation(elementId, {translateX, translateY}) and native subtree paintMotion with existing tween/spring fields, backed by a retained fixed-geometry subtree handle. At the same frame it must translate recorded paint primitives, inherited clips/masks, native hitboxes, selection/caret geometry and automation bounds, damage the union of old/new bounds, and leave unrelated cached entities unnotified. Child geometry/text/inherited-style edits invalidate that handle normally. Path/filter/unsupported scene contents must fall back to ordinary rendering. Reusing existing translate style with only paint moved would leave input geometry stale. The exact sibling contract is in tasks7b/comparison.json: latest pointer wins; pointer capture, selection and AX survive; transformed visual bounds are observed while slot wrappers stay fixed; cancel/drop/remount invalidate translation. This larger primitive is specified, **not implemented** in this lane.

## Evidence pairs and reproducibility

Evidence root: /Users/mymac/projects/ade/previews/gpuix/round7/pacing/ (outside git).

| Item | Desktop frontend WebKit image/strip | GPUIX image/strip |
| --- | --- | --- |
| Matrix variants and running task pie (four modes) | desktop-loops/desktop-{dark,light}-{0,1}-{0..9}.png | region/{dark,light}-{0,1}-1-{initial,recolored}.png; frame/ |
| PR list, Summary, Changes, Timeline (four modes) | desktop-webkit-{dark,light}-{0,1}-{scene}.png | after-cost-{dark,light}-{0,1}-{scene}.png |
| Environment open (four modes) | No matched reference strip captured: unverified | motion-region-{dark,light}-{0,1}/environment-strip/ |
| Native text pulse | Desktop gradient shimmer differs: parity gap | text/; region/ |
| Drawable stall | Not a desktop comparison | drawable-pool.json, baseline-stall.sample, pool-{baseline,pool}-{0..9}.png |

Concrete four-mode reference links (the desktop column is frontend WebKit):

| Mode / scene | Desktop reference | GPUIX |
| --- | --- | --- |
| dark normal / list | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/desktop-webkit-dark-0-list.png) | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/after-cost-dark-0-list.png) |
| dark normal / summary | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/desktop-webkit-dark-0-summary.png) | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/after-cost-dark-0-summary.png) |
| dark normal / changes | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/desktop-webkit-dark-0-changes.png) | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/after-cost-dark-0-changes.png) |
| dark normal / timeline | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/desktop-webkit-dark-0-timeline.png) | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/after-cost-dark-0-timeline.png) |
| dark normal / matrix + task | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/desktop-loops/desktop-dark-0-0.png) | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/frame/loops-dark-reduced0-0.png) |
| dark reduced / list | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/desktop-webkit-dark-1-list.png) | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/after-cost-dark-1-list.png) |
| dark reduced / summary | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/desktop-webkit-dark-1-summary.png) | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/after-cost-dark-1-summary.png) |
| dark reduced / changes | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/desktop-webkit-dark-1-changes.png) | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/after-cost-dark-1-changes.png) |
| dark reduced / timeline | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/desktop-webkit-dark-1-timeline.png) | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/after-cost-dark-1-timeline.png) |
| dark reduced / matrix + task | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/desktop-loops/desktop-dark-1-0.png) | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/frame/loops-dark-reduced1-0.png) |
| light normal / list | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/desktop-webkit-light-0-list.png) | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/after-cost-light-0-list.png) |
| light normal / summary | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/desktop-webkit-light-0-summary.png) | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/after-cost-light-0-summary.png) |
| light normal / changes | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/desktop-webkit-light-0-changes.png) | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/after-cost-light-0-changes.png) |
| light normal / timeline | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/desktop-webkit-light-0-timeline.png) | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/after-cost-light-0-timeline.png) |
| light normal / matrix + task | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/desktop-loops/desktop-light-0-0.png) | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/frame/loops-light-reduced0-0.png) |
| light reduced / list | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/desktop-webkit-light-1-list.png) | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/after-cost-light-1-list.png) |
| light reduced / summary | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/desktop-webkit-light-1-summary.png) | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/after-cost-light-1-summary.png) |
| light reduced / changes | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/desktop-webkit-light-1-changes.png) | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/after-cost-light-1-changes.png) |
| light reduced / timeline | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/desktop-webkit-light-1-timeline.png) | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/after-cost-light-1-timeline.png) |
| light reduced / matrix + task | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/desktop-loops/desktop-light-1-0.png) | [Image](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/frame/loops-light-reduced1-0.png) |

Raw motion cadence: motion-{baseline,region}-{theme}-{reduced}/cadence.json; PR and project JSON beside images; resources.jsonl, memory-{0,1}.json. Frame timestamps are labeled by source; none is asserted to be a physical display timestamp.

Reproduce from apps/gpuix using the final addon staged in native/build:
- bun perf/pacing-shipping-controls.ts: final defaults plus four-mode native region/frame/text checks.
- bun perf/pacing-fixture.ts -- bun perf/pacing-motion.ts after dark 0: actual-app action cadence (set KYBERN_PACING_ADDON for an alternate addon).
- bun perf/pacing-scroll.ts after-cost dark 0 with KYBERN_FRAME_COSTS=1 and KYBERN_FRAME_TIMES=1: PR cost/proxy measurement.
- bun perf/pacing-webkit.ts dark 0: desktop frontend reference. PLAYWRIGHT_CORE may select an existing cached module.
- bun perf/pacing-fixture.ts -- bun perf/pacing-memory.ts 1: lazy-target footprint cycle.

The helpers use only the lane's own port/data and acquire the fair UI lease; hold groups hand it back before five minutes. Historical binary comparisons require rebuilding the recorded source/patch configuration; intermediate addons are deliberately removed at cleanup.

## Acceptance and remaining work

- Shared onFrame contract and drawable lifetime: implemented; automated shared/native controls pass.
- Display wake/full-rate inactive default: enabled; four-mode full-app improvements and true-idle parking verified.
- Native matrix/task loops: implemented opt-in, reduced-motion rest frames verified. Outside the experiment the historical 5 Hz loop remains an unresolved defect; it is not claimed as an accepted 60 fps result.
- Smooth app-loop / region / text default-on: **not accepted**, retained opt-in because the repeated GPU gate is unresolved. Memory/pixel/resize/occlusion controls pass.
- R3-8: **partial**, long-row layout and reduced-dark dropped frames remain; no physical-input-to-display or native Tauri host comparison.
- Round-one item 10: **partial**. The call-site inventory is complete for direct native motion hosts, and common paths have live four-mode tables. Rare tooltip/dialog/toast/send/mini-player/image/subagent/split/row-exit interactions and some pills lack individual before/after cadence and matched desktop strips. Shared machinery is not a substitute for exercising them.
- Explorer and Tasks drag are sibling-owned; no changes here. Include dock7b's provided Explorer full-rate wake comparison as external evidence only: dark p95 22.40 → 18.41 ms, light wake-off p95 21.27 ms.
- Cross-display backing-scale migration needs a physical two-display test.
- Native glyph pulse preserves the prior port, not the desktop gradient shimmer. A glyph-mask gradient implementation is still required for exact visual parity.

## Files and checks

Native additive patches: frame_drawable_gpui.py; frame_gpui.py/frame_hooks.py; paint_buffers_gpui.py; paint_region_gpui.py/paint_region_renderer.rs/paint_region.metal; paint_text_hooks.py/paint_text_gpui.py; frame_cost_gpui.py. apply_hooks.py and backdrop_gpui.py contain small additive hook calls. Native JS runtime patch enables wake by default; the checked-in pnpm patch and its SHA256 lock entries match. No dependency versions changed.

Branch gpuix/pacing7, from b6f5d7ee. Safe independent implementation commits: 645c3b8a (frame adapter), 811241d7 (drawable lifetime), 3af5967c (opt-in region/text prototype), 3eb0f086 (wake/dedup), 38024f6f (gated app integration).

Shared app edits: main.tsx installs the frame renderer; native/frame.ts and its tests implement the shared source; MatrixLoader.tsx drives passive native dots and shared display-time fallbacks; ui.tsx adds optional native text metadata. Other app edits are tasks/Glyphs.tsx (no drag), shell/Connection.tsx, transcript/Turn.tsx/motion.tsx and the optional long PR fixture.

Validation: app/native/perf TypeScript; 103 source tests, 0 failures, 4,636 assertions. Rust 1.97.1 release addon builds; upstream unused-code and future-compatibility warnings remain. Actual native controls pass scoped color/opacity, cached-island replay/overlay, layout observers and velocity springs, Markdown selection/wrapping, 30k-line diff, syntax worker lifecycle/cancellation/queues, UTF-16 editing/undo/redo/font metrics, native key interception/titlebar/close handling, native frame backpressure/parking, glyph tint selection, and four-mode region equality/fallback/resize/occlusion. Final rerun status and free-space cleanup are recorded in the handoff.

Disk: 115 GiB free before heavy work; 112 GiB at the last build. Cleanup removed the 1.8 GiB native target, 184 MiB upstream checkout, disposable GPUIX/desktop dependencies, intermediate addons, runtime staging, Python cache and scratch data. The final 24.4 MB addon, existing 102 KB webview dylib and 62 MiB evidence remain. Actual free space after cleanup: **114 GiB** (115 GiB before heavy work, 112 GiB at last build). No scratch process or UI lease remains.

Integration note: clip7's rounded-clip patch is not present in this branch. Its encoder scissor must intersect the passive damage scissor, or its scenes must conservatively take the full-render fallback. Re-run region pixel equality after combining those native patches; current equality results do not certify the future combination.

[Validation manifest](/Users/mymac/projects/ade/previews/gpuix/round7/pacing/validation.json) records the addon SHA256, commands, gate decisions and final default controls.

## Native animation call-site inventory


Audit of 61 direct motion hosts at base b6f5d7ee (line numbers refer to that base), including reused primitives. Continuous loader, text pulse and spinner consumers are described above; wrapper consumers inherit their primitive and still need scenario-specific verification.

| Call site | Driver | Live before / after |
| --- | --- | --- |
| `src/App.tsx:132` | Native transition | Sidebar open/close table above |
| `src/Transcript.tsx:217` | Native transition | Dedicated cadence not captured |
| `src/Transcript.tsx:367` | Native transition | Dedicated cadence not captured |
| `src/composer/ModelPicker.tsx:976` | Native transition | Dedicated cadence not captured |
| `src/composer/ModelPicker.tsx:997` | Native transition | Dedicated cadence not captured |
| `src/composer/motion.tsx:37` | Native transition | Dedicated cadence not captured |
| `src/dock/Dock.tsx:81` | Native transition | Dock open/close table above |
| `src/dock/Dock.tsx:153` | Native transition | Dock tab pill table above |
| `src/dock/parts.tsx:54` | Native transition | Dedicated cadence not captured |
| `src/dock/reorder.tsx:190` | Native transition | Dedicated cadence not captured |
| `src/drag/Ghost.tsx:67` | Native transition | Dedicated cadence not captured |
| `src/drag/Ghost.tsx:68` | Native transition | Dedicated cadence not captured |
| `src/drag/Ghost.tsx:77` | Native transition | Dedicated cadence not captured |
| `src/drag/Ghost.tsx:83` | Native transition | Dedicated cadence not captured |
| `src/drag/Ghost.tsx:104` | Native transition | Dedicated cadence not captured |
| `src/drag/shift.tsx:45` | Native transition | Dedicated cadence not captured |
| `src/environment/Panel.tsx:51` | Native transition | Environment open/close table above |
| `src/environments/Dialogs.tsx:74` | Native transition | Dedicated cadence not captured |
| `src/live/ComputerLiveView.tsx:63` | Native transition | Dedicated cadence not captured |
| `src/live/ComputerLiveView.tsx:64` | Native transition | Dedicated cadence not captured |
| `src/live/Floating.tsx:67` | Native transition | Dedicated cadence not captured |
| `src/motion/kit.tsx:74` | Native transition | Home stagger instance measured; other entrances unverified |
| `src/motion/kit.tsx:105` | Native transition | Dock/composer menu instances measured; other popovers unverified |
| `src/motion/kit.tsx:198` | Native transition | Worked/tool disclosure instances measured |
| `src/motion/kit.tsx:228` | Native transition | Dedicated cadence not captured |
| `src/nav/NavRail.tsx:61` | Native transition | Rail pill table above |
| `src/nav/TitleBar.tsx:155` | Native transition | Title position with sidebar table above |
| `src/nav/TitleBar.tsx:215` | Native transition | Dedicated cadence not captured |
| `src/notes/NoteEditor.tsx:227` | Native transition | Dedicated cadence not captured |
| `src/notes/NotesPage.tsx:183` | Native transition | Dedicated cadence not captured |
| `src/notes/NotesPage.tsx:195` | Native transition | Dedicated cadence not captured |
| `src/preview/Chrome.tsx:91` | Native transition | Dedicated cadence not captured |
| `src/requests/Panel.tsx:10` | Native transition | Dedicated cadence not captured |
| `src/requests/Panel.tsx:23` | Native transition | Dedicated cadence not captured |
| `src/settings/SettingsScreen.tsx:77` | Native transition | Settings tab pill table above |
| `src/settings/controls.tsx:62` | Native transition | Dedicated cadence not captured |
| `src/settings/controls.tsx:120` | Native transition | Dedicated cadence not captured |
| `src/shell/Connection.tsx:78` | Native transition | Dedicated cadence not captured |
| `src/shell/ResizeHandle.tsx:50` | Native transition | Dedicated cadence not captured |
| `src/shell/toasts.tsx:288` | Native transition | Dedicated cadence not captured |
| `src/sidebar/motion.tsx:48` | Native transition | Dedicated cadence not captured |
| `src/sidebar/motion.tsx:55` | Native transition | Dedicated cadence not captured |
| `src/sidebar/motion.tsx:74` | Native transition | Dedicated cadence not captured |
| `src/sidebar/motion.tsx:92` | Native transition | Dedicated cadence not captured |
| `src/sidebar/motion.tsx:111` | Native transition | Dedicated cadence not captured |
| `src/sidebar/motion.tsx:125` | Native transition | Dedicated cadence not captured |
| `src/sidebar/motion.tsx:136` | Native transition | Dedicated cadence not captured |
| `src/sidebar/motion.tsx:141` | Native transition | Dedicated cadence not captured |
| `src/sidebar/motion.tsx:148` | Native transition | Dedicated cadence not captured |
| `src/sidebar/reorder.tsx:279` | Native transition | Project-drag table above; no individual shift isolation |
| `src/sidebar/reorder.tsx:280` | Native transition | Project-drag table above; no individual hide isolation |
| `src/split/Workspace.tsx:150` | Native transition | Environment inset table above |
| `src/split/Workspace.tsx:273` | Native transition | Dedicated cadence not captured |
| `src/split/Workspace.tsx:275` | Native transition | Dedicated cadence not captured |
| `src/subagents/Page.tsx:43` | Native transition | Dedicated cadence not captured |
| `src/tasks/SelectionBar.tsx:33` | Native transition | Dedicated cadence not captured |
| `src/transcript/images.tsx:133` | Native transition | Dedicated cadence not captured |
| `src/transcript/rail.tsx:76` | Native transition | Dedicated cadence not captured |
| `src/transcript/rail.tsx:85` | Native transition | Dedicated cadence not captured |
| `src/usage/UsagePage.tsx:128` | Native transition | Dedicated cadence not captured |
| `src/usage/controls.tsx:24` | Native transition | Dedicated cadence not captured |


## Continuous and shared-clock consumers

| Consumer | Before | After candidate | Acceptance |
| --- | --- | --- | --- |
| Matrix orbit | Shared 200 ms clock (nominal; no isolated before distribution) | Native loop lab 16.67/18.54 ms dark; 16.67/18.45 light | Opt-in; reduced holds still |
| Matrix pulse | Same shared clock | Same native loop lab, actual pixels exercised | Opt-in |
| Matrix scan | Same shared clock | Same native loop lab, actual pixels exercised | Opt-in |
| Matrix twinkle | Same shared clock | Same native loop lab, actual pixels exercised | Opt-in |
| Running task pie | Whole SVG stepped at shared 5 Hz | Stationary ring/native fill; same loop lab | Opt-in; four modes |
| Live transcript pulse | Running scene 200.96/225.55 ms first baseline | Persisted native text scene 16.67/18.63 ms | Opt-in; GPU gate unresolved |
| Connection spinner | Eight shared-clock steps | Continuous arc implementation; dedicated live cadence/reference strip not captured | Unverified, opt-in |
| Working / subagent elapsed labels | Shared 5 Hz clock drove informational seconds | Independent visibility-aware 1 s updates | Information, not motion |
| Streaming text reveal | Existing paced data commits | Unchanged | Separate streaming workload; not claimed as an animation fix |
| Drag edge-scroll | Existing interval in base branch | onFrame contract supplied for tasks lane | Sibling integration, not edited here |
