# GPUIX motion at 60 fps, at idle cost — lane motion/fps, 2026-10-20

**Outcome.** The "5 fps-ish" motion was every continuous loop: the matrix loader (≈20 call sites:
sidebar running rows, working header, tool rows, composer, subagents), the running task glyph, the
connection spinner, the live-label shimmer and the visual-reply skeleton all sampled a shared 200 ms
React clock. They now run at display rate by default. Settled loops run in **Core Animation**: the app
presents no frames while they animate, so a running agent costs about the same as an idle window.
Transient motions (panels, menus, popovers, press, pop, toasts) already reached 60 fps and were left
unchanged. One paint-only conversion was tried and dropped (below).

Apple M1, 16 GiB, macOS 27, Bun 1.4.0, Rust 1.97.1, GPUIX 0.10.0 + patches. Windows open on the hidden
1440×900@2x 60 Hz test display (`GPUIX_BACKGROUND=1`); `KYBERN_FULL_RATE` default (1) everywhere.
Workload: `perf/bench/seed.ts` (300 threads / 20 projects, 1,000- and 3,000-turn threads, a synthetic
running thread; 20 tasks, half set running for the Tasks scene) on scratch port 4361.

## 1. What zeron and Zed do, and what applies here

Sources are the local clones under `ade-gpuix-scratch/research/` (zeron `911ec56`, zui `361ff20`, zed `b0f1e1cb2f`).

- **zeron runs loops at 30 or 15 Hz, not at display rate.** `crates/ui/src/motion.rs` has one
  `PulseClock` with `PULSE_TICK = 33 ms`. It is driven by an executor timer, not the display link,
  because repeating `with_animation` pinned the window at 120 Hz and cost 36% CPU. Spinners take
  per-entity leases that expire after 300 ms. With no leases the clock parks. Stride 2 gives 15 Hz
  (gradient spinner, running pill). All loops share one epoch, so they stay in phase. Reduced motion
  and background pause take no lease.
  - *Applies:* one shared clock that parks, a shared phase epoch, and leases taken only by painted
    leaves. We already had these in `native/frame.ts`, `useLoopVisibility` and the `started` instants
    on native tags.
  - *Does not apply:* zeron's 30/15 Hz rate. The user's bar is ≥ 60 fps, and zeron's rate is a
    concession to cost, not proof of smoothness.
- **zeron caches small animated entities.** `loaders.rs` gives `MiniSpinner` and `PulseGlow` their own
  cached entity of fixed size, notified only when props change, with dots in fixed slots.
  - Caveat: a notify still re-renders every ancestor view (`mark_view_dirty`). The cache only spares
    siblings.
  - *Applies:* fixed-size `cache` islands. MatrixLoader and the glyphs already are. A fixed slot is
    also what lets a loop reach the compositor here.
- **zui pauses the display link.** It runs only while a frame is requested, stops on occlusion, caps
  inactive windows at 30 fps, uses `maximumDrawableCount = 2` and trims idle scratch textures.
  - There is **no partial redraw or damage tracking in zeron, zui or Zed.** Every frame clears and
    re-encodes the whole scene.
  - *Applies:* idle must request no frames at all, which already holds here.
  - *Does not apply:* the inactive 30 fps cap. The user watches Kybern on another screen while agents
    run, so we keep `KYBERN_FULL_RATE`.
- **Zed's `with_animation` is per frame.** It calls `request_animation_frame` every frame
  (`elements/animation.rs`), re-rendering the current view and its ancestors and submitting the full
  scene. `with_max_fps` and `repeat_synced` are newer additions.
  - *Applies:* nothing beyond what we have. Our native `paintAnimation` / `paintTransform` path is
    already cheaper per frame: no element build or layout at all.
- **What none of them do, and WebKit does, is run the loop in the compositor.** The desktop's CSS
  keyframes cost the app nothing per frame. That is the technique adopted here (section 3).

## 2. Inventory and measured frame rate

"Before" is v0.10.1 behaviour: the v0.10.1 addon (`native/build/before.node`) with
`KYBERN_NATIVE_PAINT_ANIMATIONS=0`, which keeps the shipped JS paths. "After" is this branch with
default settings. Passive loops: 10 s warm-up, then 15 s of app submissions (`[kybern-submit]`). The
full table of ~70 animations, with file and line, mechanism, props and trigger, is in
[inventory.md](motion-fps/inventory.md). The rows below cover every family; the remaining ones are
rows of the families measured here.

| Animation | Clock / rate before | Invalidates | Delivered before | After |
| --- | --- | --- | --- | --- |
| MatrixLoader (all variants, ~20 sites) | shared 200 ms `setInterval`, React commit | loader island + commit | **5.2 fps** (p50 200 ms) | Core Animation: CA presentation p50 17.1 ms (display-rate ticks); 0 app frames |
| Running task glyph (breathe) | `useLoaderStep` 5 Hz | island | **5.2 fps** | Core Animation, 0 app frames |
| Connection spinner | `useLoaderStep` 8 pre-rotated SVGs | leaf | **5 fps, 45° steps** | Core Animation, measured 0.769 turns/s (1.3 s cycle) |
| Live label shimmer ("Thinking", captions) | 8-step table at 5 Hz | label + window relayout | **5–6 fps** (thread scene) | Core Animation (one masked layer per glyph); fits the native curve within 0.008 |
| Visual-reply skeleton | `useLoaderTime` 5 Hz | leaf | **5 fps** | `paintTransform` opacity tween at display rate (one React commit per 800 ms half-cycle) |
| kit Spinner / SpinIcon (PR checks, buttons) | native `rotate` paint loop | scene replay | 60 fps, full-window present | Core Animation, 1.000 turns/s |
| Skeleton band (`kit/Skeleton`) | `paintTransform` translate | scene replay | 60 fps | unchanged (60 fps, scene) |
| Press, pop, success check, stroke draw, toast fade, drop ring | `paintTransform` / `paintAnimation` one-shots | scene replay | 60 fps (round 9/10 checks) | unchanged |
| Sidebar width slide (220 ms) | native `motion` tween | window re-render | 60 fps: p50/p95/p99 16.6/18.5/21.2 ms, 0 > 33, render 5.0 ms p50 | unchanged |
| Dock slide | native `motion` width | window re-render | 60 fps through the slide; the 82 ms interval is the content-unmount frame after the slide has reached width 0 | unchanged |
| Menus / tooltips / popovers (`PopupLayer`) | `<anchored motion>` | window re-render | 60 fps: model picker p95 18.7–21.4 ms, render 5.7–8.9 ms p50 | unchanged (conversion dropped, §3) |
| Rise / Swap / Collapse / pills / switches | native `motion` | window re-render | 60 fps class (same mechanism as above) | unchanged |
| Streaming answer (paced text + paint-only word fade) | 15 Hz paced commits + native fade | window render | 62.6 fps, p95 23.6 ms | 59.7 fps, p95 23.6 ms (unchanged; see gaps) |
| Caret blink, terminal cursor | 500/600 ms toggles | leaf | stepped by design | unchanged |

Every loop measured below 60 fps before. Every transition was already display-paced.

## 3. Fixes

### JS (`apps/gpuix/src`)

- **`MatrixLoader.tsx`:** native paint loops are the default with the patched addon
  (`NATIVE_PAINT_ANIMATIONS = PATCHED_NATIVE && env !== '0'`). It adds `NATIVE_TEXT_PAINT` (default on)
  and a `matrix-loader` test id. The old 5 Hz clock remains only for `=0` and the stock addon.
- **`native/loop-visibility.ts`:** adds `useLoopRunning`, which combines the painted-in-clip observer
  with window visibility. A native loop presents until its prop is removed, so a hidden, minimized or
  other-Space window drops it. The visibility poll runs only while such a loop is painted.
- **`tasks/Glyphs.tsx`, `shell/Connection.tsx`, `transcript/motion.tsx`:** the running glyph,
  connection spinner and live label take the native path via `useLoopRunning`. The glyph also gets a
  `task-running-glyph` test id.
- **`transcript/Visual.tsx`:** the loading wash breathes with a paint-only `paintTransform` opacity
  tween, retargeted at each half cycle. Its curve, 1 → 0.55, is kept. The native `breathe` kind goes
  to 0.45.

### Native patches (`apps/gpuix/native/patches`)

`compositor_loops_gpui.py` and `compositor_loops_renderer.rs`, hooked with one line at the end of
`backdrop_gpui.py`. The design is in `native/README.md` → "Compositor loops".

- **Eligibility.** Every primitive of the tagged leaf must be one of:
  - a solid, borderless fill (`matrix`, `breathe`);
  - a monochrome sprite (`breathe`, `shimmer`, `rotate`). This covers SVG glyphs and text glyphs;
    subpixel text stays in the scene.

  The leaf must also be unclipped (rounded clips checked conservatively), outside any non-neutral
  `paintTransform`, and not covered by anything painted after it, including blur and shadow halos.
- **Promotion.** A leaf is promoted once its bounds are stable for one present. The scene repaints it
  transparent and stops requesting frames for it.
- **Renderer.** It keeps one CALayer per part as a sublayer of the Metal layer:
  - a fill colour with its corner radius, or the colour masked by the glyph's atlas tile, which is
    copied once from shared storage;
  - a repeating CA animation with the exact native curve, phase-aligned to the leaf's `started`
    instant. CA's `easeInEaseOut` is CSS `ease-in-out`; the shimmer gain is sampled into 33
    keyframes; rotation is clockwise.
- **Hand-back.** It happens in the same `CATransaction` as the Metal frame, covering movement,
  clipping, covering, recolour and unmount.
- **Off switches:** `KYBERN_COMPOSITOR_LOOPS=0`, a paused automation clock, `KYBERN_PAINT_PHASE_MS`,
  `KYBERN_SCOPED_BUFFERS=0`.

### Checks and tools (`apps/gpuix/perf/motion-fps`, plus one line in `native/check-update.sh`)

- **`lab.tsx` + `lab-check.ts`**, added to `update.sh`'s geometry batch in four modes: dark, light,
  reduced, and `KYBERN_COMPOSITOR_LOOPS=0`. With compositor loops on, it asserts:
  - 0 app frames once loops settle, and ≥ 1 layer per part (67 in the lab);
  - opacity stays in the curves' range, and turns are clockwise at 0.769 / 1.000 turns/s;
  - glyph masks are upright, checked by rendering them in place;
  - a covering box hands loops back to the scene (60 frames/s) and they return when it is removed;
  - a 12 pt layout shift moves the layers, and unmounting removes them.

  In reduced motion it asserts no frames and no layers; with compositor loops off, display-rate
  scene frames.
- **`ca-probe.ts`:** in-process layer probe. It reads frames, fills, ink and presentation opacity or
  angle, and needs no screen permission.
- **`run.ts`:** scenario runner. It reports frames, full draws, commits, CPU, GPU and footprint;
  per-motion intervals and draw costs; optional CA probe, OS window capture, OS-capture strips and a
  ScreenCaptureKit cadence pass. It uses the shared lease, screen gate, build-marker and
  foreign-process gates.
- **`strip.swift`**, **`cadence.swift`**.
- **`perf/bench/app.ts`:** `turn-started` (a live turn with no token stream) and the `ca-probe` action.

### Tried and dropped

- **Region paint as the cheap 60 Hz path** (`KYBERN_REGION_PAINT=1`, round 7/8 prototype).
  - At 60 Hz it measured 12.1 / 15.4 / 6.3% CPU and 986 / 877 / 762 ms GPU per 15 s
    (home / thread / tasks), against 13.9% / 3,275 ms for full-scene painting.
  - It still presents every frame, and it is disabled whenever a backdrop is in the scene.
  - Compositor loops made it unnecessary for settled loops, so it stays opt-in. It remains useful for
    loops that are covered or moving.
- **Paint-only popups and `Rise` / `Popup` / `Swap`** (`paintTransform` translate + fade instead of
  `<anchored motion>` / `motion.div` top/left).
  - It cut full window draws per model-picker open from 19 to 3, with mid-motion cadence unchanged.
  - But the first visible step came later on average: 23–25 ms versus 16–21 ms over two A/B repeats,
    and some opens lost a whole frame.
  - Cause: the native transform's first tick falls back to a full render when a freshly mounted
    scope is not yet tagged.
  - For 100+/day input-triggered popups that is a regression, so it was reverted.
- **Dock "prime then slide."** The 82 ms interval was the unmount frame after the closing slide, not
  a stutter. The change had no effect and was reverted; the harness now counts only intervals inside
  the motion.
- **ScreenCaptureKit cadence via a window stream, then a display stream.** For the Home loader region
  it returned unchanged crops even while OS window captures 250 ms apart differed. The tool is kept
  for diagnostics. CA cadence is taken from presentation sampling instead, and visuals from OS
  captures.

## 4. Resources (final A/B, quiet window, 2 repeats, medians)

| Scene | Before: fps / CPU % / GPU ms per 15 s / MiB | After: app fps / CPU % / GPU ms / MiB |
| --- | --- | --- |
| Idle Home | 0.1 / 3.03 / 3.4 / 212 | 0 / 3.27 / 0.0 / 216 (1 valid repeat) |
| Idle 3,000-turn thread | 0.1 / 3.47 / 3.6 / 232 | 0 / 2.83 / 0.0 / 233 |
| Home, running thread in sidebar | 5.2 (choppy) / 6.63 / 278.0 / 232 | 0 (loop at display rate in CA) / 3.83 / 0.0 / 222 |
| Running thread (header loader + "Thinking" + sidebar) | 6.1 (choppy) / 15.20 / 329.0 / 232 | 1.0 (the "Working for Ns" label, once a second) / 5.70 / 51.4 / 228 |
| Tasks board, 10 running | 5.2 (choppy) / 6.60 / 238.7 / 227 | 0 / 4.40 / 0.0 / 222 |
| Streaming answer | 62.6 / 42.33 / 3,464.7 / 244 | 59.7 / 42.43 / 3,122.8 / 242 |

- **Per-frame cost of the intermediate paths**, for 120 Hz readiness (same fixture, single runs):
  - painting the loops in the scene at 60 Hz cost ~2.4 ms CPU and ~3.6 ms GPU per frame
    (3,275 ms / 940 frames);
  - with region paint, ~1 ms GPU per frame.
- **Compositor cost.** After the hand-off the app does no per-frame work. WindowServer composites a
  handful of 2–16 pt layers; global WindowServer cost was not attributed.
- **Transient motions** (unchanged): window re-render 5.0–8.9 ms p50 per frame. That fits 60 Hz but
  not 120 Hz (see gaps).
- **Regression controls:**
  - sidebar scroll with a running loader in view (hand-offs on every stop):
    p50/p95/p99 16.66/17.47/18.19 → 16.67/17.51/18.41 ms, 0 frames > 33 ms in both;
  - thread scroll: 16.67/16.88/17.06 → 16.69/17.53/18.32 ms, 0 > 33.

  Single runs each; the other repeats were discarded for another lane's build.

Evidence lives under `/Users/mymac/projects/ade/previews/motion/fps/`:

- `results.jsonl`: every row, including the discarded ones and their reasons;
- `strips/strip-{before,after}-{home,thread,tasks}-running.png`: OS window captures about 100 ms
  apart. The appearance is identical; the difference is cadence;
- `shots/pair-home-running-pair/crop-{0,1}.png`: two OS captures 250 ms apart showing the CA loader
  animating;
- `ca-probe-*.json`: layer frames, colours, ink and 2 s presentation samples;
- `lab/`: lab-check probes;
- `rise-lab/`: paused-clock frames from the dropped Rise conversion;
- `log-*.txt`: diagnostic logs.

## 5. Builder guide

[`src/motion/README.md`](../src/motion/README.md). Its rules in short:

1. Loops use the existing loop components (`MatrixLoader`, `SpinIcon`, `Spinner`, `StatusGlyph`,
   `Shimmer`, `Skeleton`). Gate new ones with `useLoopRunning`. Settled loops reach Core Animation by
   themselves.
2. Never drive motion from React state or timers: no `useLoaderTime`, `setInterval` or `onFrame`
   loops.
3. Anything that only moves, fades, scales or rotates an element that is already mounted uses
   `paintTransform` / `paintTranslate` / `press`. Width and height changes use `motion`.
4. Input-triggered popups keep the tier-2 tween until the native first-tick fallback is fixed.
5. Every animation has a Reduce Motion path (opacity only, or none). Keyboard and 100+/day actions
   stay instant or under 120 ms.

## 6. Remaining gaps

- **The 1 Hz "Working for Ns" label** re-renders the window once a second in a running thread (51 ms
  GPU per 15 s).
- **Transient motions still re-render the window every frame** (5–9 ms in a 3,000-turn thread). They
  hold 60 Hz but are not 120 Hz-ready.
  - The paint-only replacement exists. It needs the native transform to tag new scopes on their mount
    frame, so the first tick does not fall back to a render.
- **Streaming holds about 60 fps,** but half its intervals exceed 16.7 ms (p95 23.6 ms) at 42% CPU.
  That is the text path, not motion, and it is unchanged by this lane.
- **Loops that are not composited:** subpixel-antialiased text, loops under a popup or tooltip, clipped
  loops at a scroll edge, and loops inside a fading or blurring `paintTransform`. These animate in the
  scene at display rate (60 fps, full present). `KYBERN_REGION_PAINT=1` reduces their GPU cost but
  stays opt-in.
- **Rotation is checked against the sprite's own square.** Spinner ink lies inside the inscribed
  circle; a glyph with corner ink could rotate slightly past a tight clip.
- **Colour space.** CA composites the layer colour as sRGB, while the scene's alpha blend happens in
  the drawable. No visible difference shows in the captures, but pixel equality between the two
  paths is not asserted.
- **Older cadence checks assume app frames.** `native/frame-check.ts` and `native/paint-region-check.ts`
  (loops8), and `scripts/kit9-spinner-check.ts`, check the scene path, so run them with
  `KYBERN_COMPOSITOR_LOOPS=0`. Results:
  - `frame-check` passes all four modes;
  - `paint-region-check` passes dark, then fails capturing the window after its minimize/resume step.
    The v0.10.1 addon fails identically;
  - the kit9 spinner check's phase-pixel assertion fails identically on v0.10.1.

  The compositor path is covered by `lab-check.ts`.
- **ScreenCaptureKit does not give a display cadence for compositor loops** in this setup (stale crops
  on the test display). The CA frame rate is shown by presentation-layer sampling (value changes at
  p50 17.1 ms) plus OS captures, not by a recorded video.
- **Not run:** a full five-scene repeat of the loops8 resource suite, and physical-display (built-in
  screen) or ProMotion measurements.
