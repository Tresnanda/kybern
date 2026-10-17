# Explorer projection and physical motion — round 7b

## Status and scope

**R3-6: motion verified; partial at integration until the native host wake option is enabled.** Explorer has native sibling position projection, SVG chevron rotation, physical layout/swap springs, and overlapping folder scale/rotation/crossfade. Four-mode live functional and visual assertions pass. **The 60 fps target is met with both `KYBERN_FULL_RATE=1` and the existing `KYBERN_VSYNC_WAKE=1` host option.** With full rate alone, the median is near 60 fps but p95 remains above 20 ms. Enabling/changing that host default belongs to the pacing lane; this Explorer lane does not silently change global startup settings.

The reference is the **desktop frontend in WebKit**, not a Tauri application window. It uses the desktop's actual FileTree and Explorer against the same scratch daemon. No installed application or normal daemon data was changed.

## Root causes and changes

- The previous 42–53 ms intervals were measured in an inactive background window without `KYBERN_FULL_RATE=1`. The matched original Explorer with that flag reaches a 16.94/17.17 ms median, but its p95 is 24.29/23.19 ms (dark/light). This is a scheduling correction, not an application optimization claim.
- `src/dock/MotionFileTree.tsx` used a physical height animation for every row. It now sets the scroll extent once, places surviving rows in fixed 29 px slots, and springs native `translateY` to each target position. Collapsed rows are removed immediately, matching the desktop's `visibleRows` map with `layout="position"`. Row entrances retain the desktop's 220 ms / −6 px easing and sibling stagger; the absolute branch line retains its 300 ms draw. The moving hover highlight also uses translation.
- Folder changes previously removed the outgoing glyph and omitted scale. Both keyed SVGs now overlap in a fixed 16 px slot until native completion. Centered SVG bounds interpolate 10.5↔14 px, exactly 0.75↔1 glyph scale, with ±8° rotation and opacity. Since each scaled object is a single SVG, no div-subtree scale capability is needed. A keyed glyph's initial state stays stable after its peer exits, avoiding a second spring start during cleanup.
- `src/dock/fileTreeMotion.ts` retains the capability shim and imports the desktop's actual `SPRING_LAYOUT` (360/32/0.6) and `SPRING_SWAP` (460/30/0.55). The supplied addon reports `{rotate:true,physicalSprings:true}`. Normal-mode rotation and physical springs therefore run natively; reduced motion uses duration zero and static rows/icons.
- Explorer fixture files are `scripts/dock7b-*` and `visual/screens/dock7b.*`. No shared production file, native patch, dependency version, or sidebar project-drag path changed.

Fixed geometry removes branch reflow from sibling displacement. It does **not** establish a native scene-only compositor: this renderer still builds/lays out the active window/islands during ordinary motion frames.

## Live verification and evidence

Evidence root: `/Users/mymac/projects/ade/previews/gpuix/round7/dock7b/`.

`dock7b-check.ts` passes dark/light × normal/reduced with actual input against the full application: nested lazy listings, source selection, collapse, rapid four-toggle reversals, keyboard activation, 400-file virtualization, Home/End scrolling, and return to the root. Normal-mode checks assert more than 200 px sibling displacement, changed native chevron pixels, two simultaneous folder layers, 0.75 starting scale, 1.0 endpoint scale, and native-completion removal. Reduced-mode samples have constant final sibling positions and identical chevron pixels throughout both actions.

Paired static views: [`dock7b-explorer-dark-pair.png`](/Users/mymac/projects/ade/previews/gpuix/round7/dock7b/dock7b-explorer-dark-pair.png) and [`dock7b-explorer-light-pair.png`](/Users/mymac/projects/ade/previews/gpuix/round7/dock7b/dock7b-explorer-light-pair.png). Each full-frame threshold-24 diagnostic is 1.92% differing pixels; that is not a pixel-identical claim.

Four-mode paired strips (desktop frontend in WebKit above, GPUIX below, labelled in the images):

| Mode | Expand | Collapse |
| --- | --- | --- |
| Dark, normal | [Pair](/Users/mymac/projects/ade/previews/gpuix/round7/dock7b/dark-normal-expand-strip.png) | [Pair](/Users/mymac/projects/ade/previews/gpuix/round7/dock7b/dark-normal-collapse-strip.png) |
| Dark, reduced | [Pair](/Users/mymac/projects/ade/previews/gpuix/round7/dock7b/dark-reduced-expand-strip.png) | [Pair](/Users/mymac/projects/ade/previews/gpuix/round7/dock7b/dark-reduced-collapse-strip.png) |
| Light, normal | [Pair](/Users/mymac/projects/ade/previews/gpuix/round7/dock7b/light-normal-expand-strip.png) | [Pair](/Users/mymac/projects/ade/previews/gpuix/round7/dock7b/light-normal-collapse-strip.png) |
| Light, reduced | [Pair](/Users/mymac/projects/ade/previews/gpuix/round7/dock7b/light-reduced-expand-strip.png) | [Pair](/Users/mymac/projects/ade/previews/gpuix/round7/dock7b/light-reduced-collapse-strip.png) |

Columns request 0, 16, 32, 64, 96, 128, 176, 224, 320, and 600 ms. Normal native siblings move 252.5→484.5 px on expansion and reverse on collapse; the desktop reference is 252→484 px. Reduced-mode samples stay at the final endpoint in both engines. Native frame originals and geometry live in `{dark,light}-{normal,reduced}-{expand,collapse}-gpuix/`. Nested and large views are `explorer-{nested,large}-{mode}-gpuix.png`. Only OS `screencapture -l <own window id>` captures native pixels. Timing/resource processes never call a screenshot API or manipulate the clock.

The visual fixture keeps one paused clock through both actions. Native `clock.resume()` returns to raw wall-clock Instants after manually advancing time; mixing those timelines can rewind an existing spring and invalidate the collapse strip. That discarded attempt is not performance or parity evidence. The live fixture also waits for the initial entrance to settle before recording its closed reference coordinate.

## Measurement environment

Apple M1, macOS 27.0.1, Bun 1.4.0, GPUIX 0.10.0; one nonactivating 1280×820 window; `GPUIX_BACKGROUND=1`, **`KYBERN_FULL_RATE=1`**, opaque backing; scratch daemon 4275. Supplied addon SHA256: `2a6d10d6d264cf8387506314b432c0f700b26a0a5531afb584cd2633f216d0e1`.

Workload: warm three-level, 13-row expanded tree, eight expand/collapse cycles. Native numbers are scene-submission intervals, not physical display presentation or input latency. No interval filtering is used. Host contention is uncontrolled. Diagnostic/profile runs are separate from acceptance timing.

| Source | Theme | Frames | p50 ms | p95 ms | Max ms |
| --- | --- | ---: | ---: | ---: | ---: |
| Original height motion, full rate | Dark | 464 | 16.94 | 24.29 | 37.92 |
| Original height motion, full rate | Light | 455 | 17.17 | 23.19 | 31.58 |
| Fixed slots + translation, full rate | Dark | 454 | 17.07 | 22.40 | 28.07 |
| Fixed slots + translation, full rate | Light | 443 | 17.10 | 21.27 | 26.04 |
| Same source + native vsync wake | Dark | 443 | 16.64 | 18.41 | 21.87 |
| Same source + native vsync wake | Light | 441 | 16.67 | 18.16 | 20.08 |

All six acceptance runs had no ≥500 ms stall; no intervals were discarded. The modest full-rate-only difference is one sample per condition and is not a robust speedup claim. The matched vsync-wake condition meets p95 ≤20 ms in both themes.

Original idle: **222 MiB physical footprint, 1.66% CPU, 6.8 ms GPU over 15.02 s**. Final immediate post-motion controls: 218 MiB / 1.86% / 8.2 ms without wake, 215 MiB / 1.39% / 5.0 ms with wake. These include the final native spring tail; **After waiting for native submissions to quiesce, a fresh control measured 208 MiB physical footprint, 2.06% CPU, 0.0 ms GPU over 15.02 s, and zero submitted frames during the sample** (`idle-explorer-settled.txt`, `idle-frames-settled.json`). There is no ongoing Explorer animation/paint loop at rest. Daemon and WindowServer are excluded. Native reduce-motion mode has no continuous motion cadence; its visual samples verify immediate endpoints rather than inventing an animation frame rate.

Separate live desktop-frontend WebKit rAF controls (700 ms, no clock mocking) measured: dark normal 45 callbacks, p50/p95 17/22 ms; light normal 46, 17/17 ms; dark and light reduced each 47, 17/18 ms. Browser rAF and native scene submission are different stages; these are scheduling controls, not a direct presentation-speed comparison.

## Separate diagnostic profile

`profile.log`, `profile-counts.json`, and `native-profile-{dark,light}.txt` come from separate fresh processes, with no screenshots or clock changes. They deliberately enable island logs and React commit instrumentation and therefore are **not acceptance timing**. Twenty cycles (40 toggles) produced:

| Theme | React commits | Island renders | Explicit island wakes | Native submissions |
| --- | ---: | ---: | ---: | ---: |
| Dark | 80 | 7,010 | 80 | 1,112 |
| Light | 83 | 7,009 | 81 | 1,110 |

React commits occur at input and folder-exit cleanup, not once per native frame. The 2 s / 1 ms native stack sample still contains `Window::compute_layout` → `TaffyLayoutEngine::compute_layout`; one dark main-thread call path contains 69 such samples out of 811 main-thread samples. The sample also spends time in the embedded host's `tick`/AppKit event pump. Counts and stack residence do not provide exact React-commit or per-frame stage wall times. Together with the unchanged-source vsync-wake A/B, they identify native scheduling and retained layout work, rather than a per-frame React tween.

## Native/shared integration and remaining limits

The unused hover key is cleared when a row disappears, preserving the previous hover lifecycle.

No new native API is required for the verified Explorer motion. Required existing APIs are `renderer.getMotionCapabilities()`, SVG `motion.rotate` in degrees, `motion.div` `translateY`, physical `{type:'spring',stiffness,damping,mass}`, and `onMotionComplete` with generation guards. The remaining performance integration is the existing **`KYBERN_VSYNC_WAKE=1`** host option (alongside full rate for background measurements), coordinated with pacing7. No new patch was added and no Cargo command was run.

For strict interruption-velocity parity, native `MotionState::sync` would need to carry the current physical derivative into the new response for each animated key; the existing JS descriptor/API can stay unchanged. Native translation does not yet retain spring velocity automatically on reversal; the fixture verifies the correct final endpoint after rapid reversals, not equivalence of intermediate interruption velocity. The tested small tree has 13 expanded rows, and the separate 400-file branch intentionally uses desktop-equivalent motion-free virtualization. This is not a battery/energy, physical presentation, arbitrary-large-tree animation, or full application pixel-parity certification.

## Validation and cleanup

- `pnpm typecheck`: pass.
- `bun test ./src`: 100 pass, 0 fail, 4622 assertions.
- No Cargo command or native build; no target directory created.
- Free space: **111 GiB before / 112 GiB after** (observed volume values; other lanes were active, so this is not an attributed reclaim claim).
- Stopped only this task's scratch daemon on 4275 and its Vite process tree. Browser/native fixtures closed their own processes; 4275 has no listener. Checked open files before removing task-generated output.
- Removed the 188 MiB GPUIX and 701 MiB desktop disposable dependency installs, scratch data/config/credentials, and temporary candidate file. No Rust target was created. Retained the supplied 23 MiB native addon/webview library and 67 MiB final evidence.
- Branch: `gpuix/dock7b`. Production motion commit: `a368f76c`. Fixtures, measured report, and hover-key cleanup are in the subsequent evidence commit; the final hand-off names its hash. The finished worktree is clean.

## Reproduction

From `apps/gpuix`, with the existing native addon and exact dependencies installed in both frontends:

```sh
bun scripts/dock7b-seed.ts
bun scripts/dock7b-check.ts
bun scripts/dock7b-locked.ts scripts/dock7b-measure.ts
PLAYWRIGHT_CORE=/path/to/installed/playwright-core/index.mjs bun scripts/dock7b-reference-check.ts
```

This run reused the installed Codex runtime's Playwright at `/Users/mymac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs` and its cached WebKit revision 2336 (WebKit 26.5). The old component-kit default path no longer existed. No package or browser was added. Locks are fair queued and each capture/measurement batch is under five minutes; both are released between batches.
