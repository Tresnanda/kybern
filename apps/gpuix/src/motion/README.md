# Writing smooth, cheap motion in GPUIX

Every animation must render at 60 fps (frame cost under 16.7 ms, aim under 8 ms) and cost nothing when it is
not running: no frames, no timers. This guide lists what GPUIX can animate today, what each tool costs per
frame, and the patterns that keep motion smooth. Measurements behind it: `../../perf/motion-fps-2026-10-20.md`.

## The cost model in one table

GPUIX draws the whole window in one Metal pass. What differs between tools is how much work runs *before*
that pass on each frame.

| Tier | Tools | Per frame | Use for |
| --- | --- | --- | --- |
| 0. Compositor | settled `paintAnimation` loops (matrix, breathe, shimmer, rotate) | Nothing in the app: Core Animation runs the curve in WindowServer. The window presents no frames until the scene changes. | Every continuous loop. You get it automatically by using the loop components below. |
| 1. Paint-only | `paintTransform`, `paintTranslate`, `paintAnimation`, `paintTransform.press` | Native display callback re-maps retained paint. No React, no element build, no Taffy layout, no island wake. Then one scene replay + GPU submit. | Everything that moves, scales, fades, rotates or pulses without changing layout. **Default choice.** |
| 2. Native tween | `motion.div` / `motion={…}` (opacity, top/left/right/bottom, width, height, borderRadius, translateX/Y, SVG rotate), `<anchored motion>` | No React, but the native host re-renders and re-lays out the window (cached islands replay) every frame. | Things that must change layout: disclosure height, panel width, sliding pills whose width changes. Keep them short (≤ 300 ms). |
| 3. JS per frame | `onFrame` (`native/frame.ts`), `useLoaderTime` | A React commit, then tier 2's work, every frame. | Nothing that loops. Only computations that cannot be expressed natively, and then only for one-shot motions. |

Measured in the 3,000-turn bench thread (`../../perf/motion-fps-2026-10-20.md`): a settled loop costs
nothing (Home with a running thread: 1.1% CPU, ~6 ms GPU per 15 s, the same as idle); the same loop painted
in the scene at 60 Hz cost 12–14% CPU and 0.9–3.3 s GPU per 15 s. A tier-2 frame re-renders the window
(5–9 ms CPU there; fine for 60 Hz, not for 120 Hz). A tier-3 loop at 60 Hz was measured at ~35–50% CPU and
was rejected. **Never drive a loop from React state.**

Tier 1 starts on the frame its element first paints. A `paintTransform` that mounts with an `initial` value (a popup,
a `Rise`, a `Swap`) is timed from the React batch that mounted it, so its mount frame already shows the first step;
the layout tween it replaced paints its mount frame at the initial value (invisible for a fade) and shows its first
step one frame later. Input → first visible step on the model picker in the 3,000-turn bench thread
(`../../perf/motion-native/latency.ts`, `KYBERN_POPUP_MOTION=layout` is the control): 45 ms p50 vs 62 ms for the old tween
(`../../native/README.md` → "Motion latency"). What remains of that latency is the mount frame itself (the popup's island renders
and lays out), not the motion. Scopes that rest at identity and will move again (a `Presence` exit, a hover reveal
hiding) pass `retain: true` (the helpers below do), so their next change is retained from its first frame too.

## Tier 1: paint-only primitives

All of these need the patched addon (`PATCHED_NATIVE` from `../native/local-build.ts`; with the stock npm
addon they do nothing, so the element simply shows its final state). Layout never moves; hit testing follows
the paint like a CSS transform.

### `paintTransform`: scale, rotate, translate, opacity, blur on a whole subtree

```tsx
<div paintTransform={{
  initial: { opacity: 0, scale: 0.97, translateY: 4, blur: 2 },   // or false: start at `animate`
  animate: { opacity: 1, scale: 1, translateY: 0, blur: 0 },
  transition: { duration: DURATION.fast, ease: [...EASE.smoothOut] }, // seconds; cubic-bezier, y may leave [0, 1]
  keyframes: [{ offset: 0.6, scale: 1.02 }],                         // optional CSS-style stops
  origin: [0.5, 0.5],                                                 // fractions of the box
  generation,                                                         // bump to restart from `initial`
}} onMotionComplete={e => { if (e.motionGeneration === generation) done() }}>
  …
</div>
```

- Changing `animate` retargets from what is on screen. A new `generation` with an `initial` restarts.
- Exits: keep the element mounted, set `animate` to the exit values (≈30% shorter, ease-in or `EASE.out`), and
  unmount in `onMotionComplete`. `shell/toasts.tsx` (`useFade`) and `kit/AlertDialog.tsx` are worked examples.
- `blur` is a backdrop pass over the subtree; a settled blur (0) drops it. Prefer a 2–4 px blur on entrances
  instead of a bare opacity crossfade.
- Rotation is exact for glyphs, SVGs and paths; boxes rotate their centres only. Rotate icon subtrees.
- `scaleX` / `scaleY` multiply `scale` on one axis about `origin` (a held switch thumb's `scale-x-110`, a bar filling
  from one end); corners stay round at the smaller stretch. `shadowOpacity` fades only the subtree's drop shadows.
- `retain: true` keeps the scope's retained paint while it rests at identity: use it on anything that will exit or
  hide later (`presenceTransform` and `revealTransform` set it), so that change is paint-only from its first frame.
- Ready-made: `pressTransform()` (`press.ts`, `:active` squash), `popTransform()` (`../kit/Pop.tsx`, `t-pop`),
  `successTransform()` (`success.ts`, `t-success`), `materialize` on popup layers (`../composer/Menu.tsx`),
  `Rise hold` (wait at the first frame, e.g. until `<img onLoad>` reports the bitmap decoded).

### `paintTransform.press`: native `:active`

```tsx
<div paintTransform={pressTransform(!disabled)} onClick={…}>…</div>
```

Squashes to 0.97 on primary mouse-down (80 ms) and back (150 ms) with no React state. Compact controls only
(buttons, icon buttons, chips); rows and full-width controls never scale.

### `paintTranslate`: move a retained subtree

```tsx
<div paintTranslate={{ initial: false, animate: { translateX: 0, translateY: offset },
  transition: { type: 'spring', duration: 0.3, bounce: 0.05 } }}>…</div>
```

Same evaluator as `motion` (tweens, duration/bounce springs, physical springs), but paint-only. Use it for
list reorders, drag carries (`../drag/PaintTranslate.tsx`, `../drag/carry.ts`) and sliding indicators whose
size does not change.

### `paintAnimation`: native loops and one-shots on passive leaves

| `kind` | On | Does |
| --- | --- | --- |
| `matrix` (`cycleMs`, `delayMs`) | div fill | The matrix-loader dot pulse (rest 22% → full at 15% → rest at 45%). |
| `breathe` (`cycleMs`) | div fill or SVG | Opacity 1 → 0.45 → 1, ease-in-out. |
| `shimmer` (`cycleMs`, `highlight`) | `Label` text | `.t-shimmer`: a soft band of `highlight` sweeps across the text, glyph by glyph (the live label, 2 s). Without `highlight`, a brightness pulse 1 → 1.6 → 1. |
| `hue` (`cycleMs`) | div fill, SVG or `Label` | `hue-rotate(0 → 360deg) saturate(1.2)`; scene only (not composited). |
| `rotate` (`cycleMs`) | square SVG | `animate-spin`. |
| `pop` (`cycleMs`, `delayMs`) | text or SVG leaf | `t-pop` once on mount, then stops asking for frames. |
| `stroke` (`cycleMs`, `delayMs`, `dash`, `ease`, `from`, `to`, `retarget`) | `<svg source>` | `t-check-draw` stroke draw-in, once; with `from`/`to`/`retarget` a ring that eases from value to value (`ringValue` in `success.ts`). |

The leaf must be passive: fixed size, no children (except a `Label`'s text), no handlers, no hover/active
style, no border, shadow or backdrop. Loops run until the prop is removed, so **always gate them**:

```tsx
const loop = useLoopRunning(!REDUCED_MOTION)       // native/loop-visibility.ts: painted in its clip + window shown
<svg ref={loop.ref} source={ARC}
  {...(loop.running ? { paintAnimation: { kind: 'rotate', cycleMs: 1300 } } : {})}
  style={{ width: 14, height: 14, color }} />
```

Once a loop's leaf has stayed put for one frame, is unclipped and nothing is painted over it, it moves to Core
Animation (tier 0) by itself (`native/README.md` → "Compositor loops"). To keep that working: give loaders a
fixed slot (don't let a label next to them reflow every second), keep them out of clipped scroll edges and
out of a `paintTransform` that is fading or blurring, and prefer single-colour glyphs (subpixel text stays in
the scene). A loop that is moving, clipped or covered still animates smoothly in the scene at display rate.

Use the existing components rather than new loops: `MatrixLoader`, `kit/Spin.tsx` (`SpinIcon`),
`kit/Spinner.tsx`, `kit/Skeleton.tsx`, `transcript/motion.tsx` (`Shimmer`), `tasks/Glyphs.tsx`
(`StatusGlyph`). Every loop on screen shares the display callback, so two loaders cost about the same as one.

## Tier 2: native tweens (`motion`)

```tsx
<motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: h, opacity: 1 }}
  transition={{ duration: DISCLOSURE, ease: [...EASE.out] }} onMotionComplete={…} />
```

- Animatable: `opacity`, `top/right/bottom/left`, `width`, `height`, `borderRadius`, `translateX/Y`, SVG
  `rotate`. Springs: `{ type: 'spring', duration, bounce }` or `stiffness/damping/mass`.
- Each frame re-lays out the window outside cached islands. If the motion only moves or fades (`top`, `left`,
  `opacity`, `translateX/Y`), use `paintTransform`/`paintTranslate` instead: identical pixels, tier-1 cost.
- Height/width motions are legitimate (`Collapse` in `kit.tsx`, the sidebar width, the environment inset), but
  wrap expensive neighbours in islands so the per-frame relayout stays small.
- Hover and press colours (`style.hover` / `style.active` background and border colours) fade natively under the
  window root's `hoverTransition` (`HOVER_FADE_ROOT` in `kit.tsx`, 90 ms): the flip renders once, the frames after it
  re-tint the quads in place. A press lands at once and eases back on release; a rest colour changed by state (a
  selection moved by the keyboard) stays instant; `hoverTransition={false}` opts a subtree out. Text colour and
  other hover properties still switch at once.

## Embedded web documents

Previews and visual replies are native WKWebViews, outside the GPUI scene, so `paintTransform` cannot fade them.
`webHost.present(id, to, { from, duration, ease, origin })` (`../native/webview.ts`) fades and scales the document's
layer in Core Animation (no app frames); `webDocumentEnter(id, webHost.present)` (`kit.tsx`) is the 150 ms entrance.
Call it before the document is first shown.

## Islands (`cache`)

`<div cache style={{ width, height }}>` (`ISLAND`, `FILL_ISLAND` from `../MatrixLoader.tsx`) replays its last
paint until something inside it changes. Put fixed-size animated widgets and heavy static neighbours in
islands. Rules (`../../native/README.md` → "Island rules"): definite width and height; no margins or insets on
the island itself; new islands render inline on their first frame; never create or touch an island's entity
during a draw (it would replay stale paint forever). Inside virtual-list rows islands work but need a definite
height.

## What makes motion choppy

- A loop driven by React state or a timer (`setInterval`, `useLoaderTime`, `useLoaderStep`): it either steps
  (the historical 5 Hz loaders, still what `KYBERN_NATIVE_PAINT_ANIMATIONS=0` and the stock addon show) or
  commits React 60 times a second.
- A loop whose bounds change every frame or second (a loader inside a row whose width tracks a ticking label):
  it can never settle into the compositor and keeps the window presenting at 60 Hz.
- A tier-2 tween of `top`/`left`/`opacity` in a heavy window: correct pixels, but every frame re-lays out the
  window; long threads push frames over 16.7 ms.
- Starting motion and heavy work in the same frame (mounting a large subtree as it fades in). Mount first,
  animate on the next frame, or animate a lighter wrapper.
- A `generation` that changes on every render: the motion restarts each commit and never finishes.
- Animating an element that is also re-keyed: the host is new, so it jumps to `initial`.

## Reduced motion

`REDUCED_MOTION` (`../ui.tsx`) is read once at startup (`KYBERN_REDUCED_MOTION=1/0` overrides the system
setting). Every animation needs a path for it:

- Movement, scale, rotation and blur: drop them; keep an opacity fade of ≤ 150 ms or nothing.
- Loops: hold the rest frame (loaders, spinners) or the static label; never animate.
- Information (elapsed seconds, progress) keeps updating; it is not motion.
- Helpers already do this: `pressTransform`, `popTransform`, `popAnimation`, `successTransform`, `strokeDraw`
  return `undefined`, and `Rise`/`Popup`/`Collapse` fall back to short fades or instant changes.

```tsx
const enter = REDUCED_MOTION
  ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: DURATION.quick } }
  : { initial: { opacity: 0, translateY: 6, blur: 2 }, animate: { opacity: 1, translateY: 0, blur: 0 },
      transition: { duration: DURATION.fast, ease: [...EASE.smoothOut] } }
<div paintTransform={PATCHED_NATIVE ? enter : undefined}>…</div>
```

## Tokens

`DURATION`, `EASE`, `DISTANCE`, `ENTER`, `POPUP`, `DISCLOSURE`, `HOVER_FADE` in `kit.tsx` mirror the desktop's
`styles/motion.css`. Hover < 100 ms, press 80/150 ms, menus 150–250 ms, panels 200–300 ms, pages 250–400 ms;
exits ≈30% faster than entrances; keyboard-driven and 100+/day actions stay instant.

## Checking your animation

- Loops in the compositor: `bun perf/motion-fps/lab-check.ts` (layers, curves, hand-back); add your component
  to `perf/motion-fps/lab.tsx` if it is a new loop. `MOTION_CA_PROBE=1` on `run.ts` probes a scenario.
- Frame rate and cost: `bun perf/motion-fps/run.ts <label> <scenario>` (scratch daemon, hidden test display,
  shared UI lease) reports submission intervals p50/p95/p99, frames over 16.7/33 ms, full draws (window
  relayouts), React commits, CPU, GPU and footprint. Add a scenario for a new loop or a heavy transition.
- Curves: the native checks pause the automation clock (`app.clock.pause()`, `app.clock.set(ms)`) and compare frames against
  the desktop CSS in WebKit (`native/subtree-transform-check.ts`, `scripts/render9-strips.ts`).
- Idle: after the motion ends the window must submit no frames (`idle-home`, `idle-thread` scenarios).
- Input → first visible step and fallback renders: `bun perf/motion-native/latency.ts <label> model-picker
  reveal-exit` (native `KYBERN_MOTION_TRACE=1`: input, batches, renders, retained ticks and presents on one clock).
- Hover fades, rings, web documents, checklist press: `native/hover-fade-check.ts`, `native/ring-check.ts`,
  `native/webview-check.ts`, `src/editor/check.ts` (all in, or next to, `native/update.sh`).

## Zoomable images (`zoom.ts`, `zoomController.ts`, `ZoomSurface.tsx`)

The lightbox and the image tab zoom one image node with a `paintTransform` (scale + translate, origin top-left); nothing relayouts
per wheel event. `zoom.ts` is the geometry (fit, 100% = actual device pixels, 800% cap, clamping, pointer-anchored zoom),
`ZoomController` the state and input (`onScroll` pans, ⌘-scroll zooms, drag pans, double click and the HUD toggle fit ↔ 100%, ⌘+ ⌘− ⌘0),
and `ZoomSurface`/`ZoomHud` subscribe to its snapshot so only they re-render. GPUIX 0.11 delivers no pinch/magnify event to JS, so a
trackpad pinch does nothing. Run `bun src/motion/zoom.verify.ts` (needs the patched addon) against a tall image.

- ⌘-scroll toward the top (GPUI `deltaY > 0`, the wheel rolled up) zooms in, as ⌘/ctrl-scroll does in browsers, Figma and Sketch.
- A press that travels more than 4 pt is a drag: the click its release produces is swallowed, so a pan released over the
  letterbox never closes the lightbox and never counts towards a double click.
- Escape closes the lightbox whatever the zoom (Quick Look's rule; ⌘0 is the way back to fit). The lightbox stops Escape and the
  zoom keys (`stopPropagation`): GPUIX bubbles a keystroke through every ancestor and then the window handlers, and an empty
  composer's window handler cancels the agent's turn on Escape while a request is pending. The image tab ignores Escape.
- Memory: the zoom is the transform of one retained `PolychromeSprite` (`subtree_transform_window.rs` scales its bounds), so the
  image is decoded and uploaded once at its own pixel size, whatever the zoom; nothing re-decodes, re-rasterizes or allocates
  per zoom level. That one copy is still width × height × 4 bytes in the decoded `RenderImage` and again in the atlas (an
  8000 × 8000 image is about 256 MB each), the same as before zoom existed.
