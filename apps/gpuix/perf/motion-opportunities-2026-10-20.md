# GPUIX motion opportunities — October 20, 2026

Audit lane `gpuix-audit` of the motion phase. Commit `98e9bef2b` (v0.10.1, `feat/motion-phase2` = `origin/main`).
Read-only audit: no source was changed. Evidence (static moments proposed for motion, dark theme, 1280×820 @2x on the
hidden test display): `/Users/mymac/projects/ade/previews/motion/gpuix-audit/` (64 PNGs, names = visual-pair screen ids).

Method: the GPUIX app ran against a scratch daemon (port 4362) seeded with the visual-pair fixture (2 projects, 9 notes,
25 tasks, ~30 conversation threads incl. thinking, tool rows, approvals, secret/brief/settings cards, queued follow-ups,
subagents, diff checkpoint, long thread, PR/usage fixture) plus 4 extra projects × 8 threads with one running thread for the
sidebar shots. Every surface below was opened and captured with the visual-pair steps, then read in source. The desktop
reference is the motion inventory of `apps/desktop` (`styles/motion.css`, `components/kybern/motion.tsx`, kit, views);
it is summarized in the "Desktop has / GPUIX lacks" column. The Gate (`find-animation-opportunities`) was applied per
surface with the motion-phase override (no 5–7 cap; keep everything that passes; keyboard and 100+/day actions instant).

## Summary

- **Surfaces walked: 41** (rail, sidebar rows/groups/states/hover/reorder, title bar, home/Draft, composer + tray +
  pickers + attachments + send/stop + status glyph, transcript user/assistant/tool/thinking/approval/secret/brief/
  queued/subagent/diff/images/visual/rail/scroll-to-bottom, dock tabs + empty, Agents tree, Activity, Explorer, Diff,
  Terminal, Preview + PiP, Notes gallery/editor/quick capture, Tasks list/board/detail/selection/quick add, Pull requests
  list/summary/menus, Usage, Settings, Palette, Sessions, Handoff, dialogs, alert dialogs, sheets, select/combobox,
  hover cards, tooltips, menus, toasts, banners, update announcement, theme switch, page switches, split panes, live view).
- **Proposals kept: 96** (P0: 12 foundation items, P1: 22, P2: 24, P3: 20, P4: 18). **Rejected: 16** (listed at the end).
- **Native work: 8 items** (N1–N8). **Suspected < 60 fps today: 17 items** (F1–F17).
- Biggest single lever: **P0.2 + P0.5** — move `Rise`, `Swap`, `Popup` and `PopupLayer` from layout tweens
  (`motion.div`/`<anchored motion>`: the whole window re-lays out every frame) to the paint-only `paintTransform`, which
  also restores the desktop's scale and blur that GPUIX dropped "because it had no equivalent" (it has had one since render9).
  Every caller (page switches, rows, popups, menus, swaps, dialogs) improves without touching its file.

### Where GPUIX stands vs the desktop

| Area | Status |
|---|---|
| Press feedback (`.press`) | Ported natively (`pressTransform`) on ~20 control families. `.press-row` darken missing everywhere. |
| Entrances (`t-row-enter`, `t-panel-enter`, `t-stagger`, send, section) | Ported as layout tweens without scale/blur. |
| Popups (menu, popover, tooltip, dialog, palette, alert, hover card) | Entrance is fade + 4 px drift (layout tween); **no exits**; only `StatusGlyph` uses the true scale (`materialize`). |
| Swaps (`TextSwap`, `IconSwap`) | New state fades up; **outgoing state vanishes**; many swaps not ported (button labels, statuses, copy link, reload/stop). |
| Disclosure | Height tweens ported (`Collapse`, `DisclosureGroup`); **chevrons never rotate** (glyph swap) except the file tree. |
| Panes (`t-pane`) | Missing: dock panes, PR tabs, terminal tabs, visual preview switch are instant. |
| Loops (MatrixLoader, shimmer, task breathe) | Stepped at 5 Hz by default (frame-rate lane). |
| Data motion (usage ring arc, limit meters) | Missing. |
| Toasts, theme fade, success check, checkbox draw, pop, marquee, drag physics, drop highlight | Ported natively; several richer than the desktop. |

### Package overview (disjoint file ownership)

| Package | Owns | Items | Depends on |
|---|---|---|---|
| **P0 Foundation** (lands first) | `src/motion/**`, `src/kit/Pop.tsx`, `src/composer/Menu.tsx`, `src/ui.tsx` | 12 | — |
| **P1 Shell, nav, sidebar, home** | `src/App.tsx`, `src/Draft.tsx`, `src/Sidebar.tsx`, `src/sidebar/**`, `src/nav/NavRail.tsx`, `src/nav/TitleBar.tsx`, `src/nav/Handoff.tsx`, `src/nav/Sessions.tsx`, `src/shell/**`, `src/split/**`, `src/environment/**`, `src/environments/**`, `src/platform/UpdateSurface.tsx` | 22 | P0 |
| **P2 Composer, transcript, requests, subagents, live view** | `src/Composer.tsx`, `src/composer/**` (not `Menu.tsx`), `src/Transcript.tsx`, `src/transcript/**`, `src/requests/**`, `src/subagents/**`, `src/coordinator/**`, `src/live/**`, `src/platform/ImageActions.tsx` | 24 | P0 |
| **P3 Dock, explorer, terminal, preview + overlays & kit** | `src/dock/**`, `src/terminal/**`, `src/preview/**`, `src/native/DiffView.tsx` (motion props only), `src/nav/overlay.tsx`, `src/nav/Palette.tsx`, `src/kit/**` (not `Pop.tsx`) | 20 | P0 |
| **P4 Pages** | `src/notes/**`, `src/tasks/**`, `src/pulls/**`, `src/usage/**`, `src/settings/**`, `src/editor/**` (TypeScript only), `src/dialogs/**` | 18 | P0 |
| Nobody (other lanes) | `src/MatrixLoader.tsx`, `src/transcript/motion.tsx` `Shimmer` internals, `src/native/**` (except DiffView), `native/patches/**`, `src/drag/**`, `src/main.tsx`, `src/theme.ts`, `src/state.ts` | — | frame-rate + native lanes |

P1–P4 can run in parallel once P0 is merged. A package that needs something from another package's file stops and
reports instead of editing it.

### Summary table (every kept proposal)

Freq: H = tens/day (near-imperceptible only), O = occasional, R = rare. "Today" is GPUIX. Durations are desktop tokens.

| # | Surface | Today | Purpose | Freq | Motion (tokens) | Native? |
|---|---|---|---|---|---|---|
| P0.1 | Motion tokens | `DURATION`/`EASE`/`DISTANCE` partial | cohesion | — | add stagger, spring, bounce, linear, SCALE, BLUR | — |
| P0.2 | `Rise` (all entrances) | layout tween, no scale/blur | prevent jarring | O | paintTransform: opacity + Y + scale + blur per kind | — |
| P0.3 | `Swap`/`SwapOnChange`/`TitleSwap` base | outgoing vanishes | state | O | true cross-swap: in 250 SO +4 px blur 2; out 150 IO −4 px blur 2; icon: scale .6 blur 2 250 IO | — |
| P0.4 | `Presence` (exit helper) | none | spatial | — | keep mounted through a paint exit, unmount on complete | — |
| P0.5 | `PopupLayer` | drift + no exit | spatial | O | default `materialize` scale .97 + blur 2 → 1, 250 SO; exit 150 → .99 | — |
| P0.6 | `Chevron` | glyph swap | state | H | rotate 0↔90° 220 ms `--ease-out` (paint) | — |
| P0.7 | `pressRowStyle` | missing | feedback | H | `active` fill = brightness .96 light / 1.08 dark, instant | — |
| P0.8 | `revealTransform` | Reveal in only | state | H | in 150 EO opacity + X 4 px; out 100 opacity | — |
| P0.9 | `MeterFill` | static | state | O | fill translates in its clip track 400 EO | — |
| P0.10 | `useCountPop` | ad hoc | feedback | O | keyed `t-pop` when a count changes | — |
| P0.11 | `hoverScale` | none | feedback | H | scale 1.05 150 EO on prominent buttons | — |
| P0.12 | `ArcDraw` | static rings | state | O | strokeDraw 400 EO on first value | N2 for value→value |
| P1.1 | Sidebar disclosure chevrons | glyph swap | state | H | `Chevron` 220 EO | — |
| P1.2 | Sidebar hover actions out | instant hide | prevent jarring | H | `revealTransform` out 100 | — |
| P1.3 | Thread status glyph change | instant | state | O | icon cross-swap 250 IO; dots pop | — |
| P1.4 | Thread title swap | fade-up only | state | O | P0.3 text swap | — |
| P1.5 | Sidebar surface remount | instant | spatial | O | `surface` enter 160 EO +4 px | — |
| P1.6 | Check for updates | spinner only | state | R | refresh ↔ spinner ↔ success check | — |
| P1.7 | Sidebar open/close | 220 EO both | spatial | O | open 260 drawer / close 200 drawer | F7 |
| P1.8 | Rail pill | 220 EO layout | spatial | H | 250 SO via `paintTranslate` | — |
| P1.9 | Rail usage rings | static | state | O | arc draw 400 EO; stale → .5 opacity 150 | N2 |
| P1.10 | Rail usage popover rows | no press | feedback | O | `pressRowStyle` | — |
| P1.11 | Settings open/close | 6 px rise, no exit | spatial | O | spring X 8→0 300 ms; exit 120 → X 6 | — |
| P1.12 | Back/forward dim | instant | state | H | opacity 150 | — |
| P1.13 | Header title swap | fade-up only | state | O | P0.3 | — |
| P1.14 | Update announcement | no scale/blur | prevent jarring | R | add scale .97 + blur 2 (350/250) | — |
| P1.15 | Home stagger | no blur | delight | O | P0.2 stagger + blur 3 | — |
| P1.16 | Handoff targets | instant arrow, loader swap | state | O | reveal arrow; icon swap | — |
| P1.17 | Sessions dialog opening | instant | state | O | icon swap to loader; rows enter on fresh | — |
| P1.18 | Split focus ring | static | state | O | ring fade 120 EO | — |
| P1.19 | Environment chevrons | rotate with duration 0 | state | O | 220 EO | — |
| P1.20 | Env SSH/address pill | 220 EO | spatial | O | 250 SO (`t-tabs`) | — |
| P1.21 | Connection banner, toasts | ported | — | — | keep; migrate banner to paint | — |
| P1.22 | Thread row press-row | none | feedback | H | `pressRowStyle` | — |
| P2.1 | Send button hover | none | feedback | H | `hoverScale` 1.05 | — |
| P2.2 | Send ↔ stop/sending | fade-up | state | H | P0.3 icon swap | — |
| P2.3 | Tray chips | no press | feedback | H | press .96 | — |
| P2.4 | Attachment tile remove | instant | prevent jarring | O | exit scale .85 opacity 0 150 | — |
| P2.5 | Queued row leaves | instant | prevent jarring | O | `Leave` 200 EO | — |
| P2.6 | Effort slider thumb | no held scale | feedback | O | held scale 1.06 200; settle spring 450 | — |
| P2.7 | Model picker busy dim | instant | state | O | opacity 150 | — |
| P2.8 | Transcript chevrons | glyph swap | state | H | `Chevron` | — |
| P2.9 | Message hover actions | instant | prevent jarring | H | opacity 150 in / 100 out | — |
| P2.10 | Jump to latest | no scale/blur | spatial | H | scale .95 blur 2, 250/150 | — |
| P2.11 | Copy → check | fade-up | feedback | H | P0.3 icon swap | — |
| P2.12 | Image load | instant | prevent jarring | O | `t-img` blur 8 scale .985 400 SO | — |
| P2.13 | Request cards | layout tween | spatial | O | paint enter + blur 2, exit 120 | — |
| P2.14 | Request submit labels | missing | state | O | text swap "Sending…" | — |
| P2.15 | Subagent/delegation status | instant | state | O | icon swap loader↔check, text swap | — |
| P2.16 | Subagent bar actions | instant | prevent jarring | O | 150 fade from blur 2 | — |
| P2.17 | Subagent strip collapse | instant | state | O | `Collapse` + `Chevron` | — |
| P2.18 | Held message rows | panel only | prevent jarring | O | row enter + disclosure | — |
| P2.19 | Visual reply | no frame fade | prevent jarring | O | frame fade 150; Open reveal 150 −2 px | — |
| P2.20 | Live view controls + ripple | missing | feedback | O | controls reveal 200 +4 px; click ripple 480 | — |
| P2.21 | Live view close | no exit | spatial | O | 160 → scale .98 | — |
| P2.22 | Transcript bottom fade | missing | state | H | gradient opacity 150 with `atTail` | — |
| P2.23 | Turn completion fold | verify | prevent jarring | O | `Collapse` close when live rows fold | — |
| P2.24 | Ultrathink frame | missing | delight | R | hue loop | N4 |
| P3.1 | Dock pane switch | instant | spatial | H | `t-pane` 250 SO +4 px scale .995 | — |
| P3.2 | Dock open/close | width 220 EO | spatial | O | spring 420/42/.7 + content fade | F8 |
| P3.3 | Dock tab pill | 220 EO | spatial | H | 250 SO | F12 |
| P3.4 | Dock tab add/close | instant | prevent jarring | O | tab enter scale .97 150; close 120 | — |
| P3.5 | Agents tree | glyph chevron, instant | state | O | `Chevron`, `Collapse`, row enter, swaps | — |
| P3.6 | Empty-state stagger bug | index 0 | delight | R | `index={i}` | — |
| P3.7 | Explorer loading | text | prevent jarring | O | skeleton after 150 ms; file pane `t-pane` | — |
| P3.8 | Diff file chevron + loading | none | state | O | `Chevron`; skeleton | — |
| P3.9 | Terminal tabs | instant | spatial | O | pane fade 150; close icon reveal | — |
| P3.10 | Preview chrome | instant | state | O | reload↔stop swap; dim 150; recents reveal | — |
| P3.11 | Preview surface fade, PiP exit | missing | prevent jarring | O | 150 fade; exit scale .96 | N3 |
| P3.12 | Menus + context menus exit | instant close | spatial | O | 150 → scale .99 opacity 0 | — |
| P3.13 | Tooltips | drift | spatial | H | scale .98 150 EO; out 80; instant chain | — |
| P3.14 | Dialogs | rise, instant close | spatial | O | backdrop 250/150; card .96 + blur 2 → 1 250 SO; out 150 → .98 | — |
| P3.15 | Palette (pointer-opened) | as dialog | spatial | O | dialog motion; ⌘K stays instant | — |
| P3.16 | Alert dialog | fade only | spatial | O | card scale .98 200 IO both ways | — |
| P3.17 | Hover card | drift | spatial | O | materialize scale .98 | — |
| P3.18 | Select popup (pointer) | none | spatial | O | materialize .98 150; keyboard instant | — |
| P3.19 | Segmented/Switch pills | layout | perf parity | H | `paintTranslate` | — |
| P3.20 | Badge count | none | feedback | O | `useCountPop` | — |
| P4.1 | Note open | instant | spatial | O | `note-doc-in` 200 SO +6 px | — |
| P4.2 | Note banner | instant | prevent jarring | O | 180 SO +4 px | — |
| P4.3 | Note save status | instant | state | H | text swap | — |
| P4.4 | Notes gallery stagger | layout tween | delight | O | paint stagger | — |
| P4.5 | Note card lift | layout `top` | feedback | H | paint translateY −2 + shadow layer | — |
| P4.6 | Note delete | instant | prevent jarring | O | exit scale .97 opacity 0 150 | — |
| P4.7 | Task glyph ↔ checkbox | instant | state | H | 80 ms cross-fade | — |
| P4.8 | Selection bar | no blur, no exit | spatial | O | + blur 2; exit 140 +4 px | — |
| P4.9 | Batch / run dock | missing | spatial | O | +16 px 260 drawer; out 160 10 px | — |
| P4.10 | Tasks sidebar projects | instant | state | O | `Chevron` + `Collapse` | — |
| P4.11 | Task page open (pointer) | instant | spatial | O | section enter 250 | — |
| P4.12 | Task status / counts | instant | feedback | O | glyph swap; column count pop | — |
| P4.13 | PR tabs + state filter | none | spatial | H | `t-tabs` pill 250 SO; content `t-pane` | — |
| P4.14 | PR loading, refresh, copy | text, static | state | O | skeleton; spin; copy swap | — |
| P4.15 | PR merged | none | delight | R | success check + state pill pop | — |
| P4.16 | Usage meters, segment swap | partly | state | O | `MeterFill`; content `t-pane`; number swap | — |
| P4.17 | Settings section switch + pill | instant / 220 EO | spatial | O | section 250 SO +6 px; pill 250 SO | — |
| P4.18 | Settings states | static | state | O | count pop + swap; chevron 180°; dim 150; skeleton | — |

---

## How every item is built and checked (read once, applies to all packages)

**Mechanism choice (binding).** In GPUIX, `motion.div` / `<anchored motion>` tweens of `opacity/top/left/width/height`
re-lay out and re-render the window on every frame (`motion/kit.tsx` header, `native/README.md` "Cached views"). The
paint-only paths run on native display callbacks with no React render, Taffy layout, prepaint or island wake:

| Need | Use | Where it is documented |
|---|---|---|
| fade / move / scale / rotate / blur a box or glyph | `paintTransform` on a host `div` | `native/README.md` "Paint-only subtree transforms" |
| move only (also pointer-driven) | `paintTranslate` / `renderer.setSubtreeTranslation` | "Retained subtree translation", `src/drag/PaintTranslate.tsx` |
| press squash | `paintTransform.press` via `pressTransform()` | `src/motion/press.ts` |
| pop a glyph/text | `paintAnimation: { kind: 'pop' }` | `src/kit/Pop.tsx` |
| draw a stroke | `paintAnimation: { kind: 'stroke' }` via `strokeDraw()` | `src/motion/success.ts` |
| spin | `SpinIcon` | `src/kit/Spin.tsx` |
| height change (disclosure) | existing `Collapse` / `DisclosureGroup` (layout — only option; frame-rate lane owns its cost) | `src/motion/kit.tsx` |

Never add a `motion.div` for opacity/translate/scale. Never add JS timers or per-frame React state for motion.
`paintTransform` facts builders need: `initial` (or `false`) → `animate`, `transition { duration (s), delay, ease }`,
optional `keyframes`, `origin [x, y]` fractions, `generation` to restart, `onMotionComplete(e)` with `e.motionGeneration`.
Changing `animate` retargets from the on-screen value (interruptible). An identity scope without `press` is not tagged,
so its first change renders once (fine for exits). `blur` adds a backdrop pass (bounds + 8 px) while it animates and
drops it when settled: keep blur ≤ 3 px except `t-img` (8 px), and never blur more than 4 elements at once (stagger index
≥ 4 and bulk inserts of > 3 rows enter without blur). Rotation is exact only for glyph/SVG subtrees: rotate icons, not boxes.
With the stock addon (`PATCHED_NATIVE` false, `KYBERN_GPUIX_NATIVE=npm`) every P0 helper returns `undefined` and the UI
simply appears: that is a diagnostic mode, not shipped.

**Reduce Motion.** `REDUCED_MOTION` from `src/ui.tsx`. Every item: drop translate/scale/rotate/blur, keep an opacity
change at `DURATION.quick` (150 ms) where the item fades, otherwise instant. Press, pop, hover scale: none.
Loops: still (frame-rate lane).

**Keyboard rule.** An action started from the keyboard (shortcuts, Enter/Escape, arrow navigation, ⌘K) shows its end state
at once. Existing exemplars: `requests/Panel.tsx` (`keyboardAnswer()` timestamp), `nav/overlay.tsx` `Dialog instant`,
`App.tsx` page switch `play`. Pass `play={false}` / `still` / `instant` from the keyboard path.

**Fresh-only.** Entrances play only for content that just appeared (`useFresh` in `transcript/motion.tsx`, `firstMount`
in `Sidebar.tsx`, `usePopOnChange` in `kit/Pop.tsx`). Initial loads, history pages and recycled virtual rows render plainly.

**Verification recipe (every item's acceptance refers to these).**
- **V-mech:** `cd apps/gpuix && pnpm typecheck && bun test ./src` pass.
- **V-strip:** a paused-clock frame strip under one UI lease, like `scripts/motion10-strips.ts`:
  `bun native/ui-lease.ts <lane> bun scripts/<your-strip>.ts`, launching with `GPUIX_BACKGROUND=1`, a scratch
  `KYBERN_DATA_DIR`/`KYBERN_CLIENT_CONFIG_DIR`, then `await app.clock.pause()`, trigger, and `app.clock.fastForward(ms)` +
  `screencapture -l <windowId>` at 0, 40, 80, 120, 160, 250, 400 ms (and the item's end). Save strips under
  `/Users/mymac/projects/ade/previews/motion/<lane>/`. The reviewer checks the listed frames.
- **V-cost:** with `KYBERN_DEBUG_ISLANDS=1`, a paint-only tween logs no island re-render between its first and last frame;
  after it settles the window is idle (`bun perf/sample.ts 15 GPUIX=<pid>`: ~0 submissions). Anything that loops or runs
  during streaming/scrolling also gets a 10 s warm-up + 15 s sample before/after (CPU %, GPU ms, footprint, frame
  intervals p50/p95/p99, frames > 16.7/33 ms) per `BRIEF-MOTION.md`.
- **V-rm:** the same strip with `KYBERN_REDUCED_MOTION=1`: no movement, opacity only (or none).
- **V-kbd:** the keyboard path of the same action is instant (single frame from before to after).
- Both themes for anything with blur, shadows or fills.

Scratch data: `VISUAL_SCRATCH=/Users/mymac/projects/ade-gpuix-scratch/motion-<lane> bun scripts/visual-pair.ts --gpuix-only
--keep <screen>` seeds the same fixture this audit used; screen ids are listed by `--list`.

---

## P0 — Foundation (lands first)

**Owns:** `src/motion/kit.tsx`, `src/motion/press.ts`, `src/motion/success.ts`, new `src/motion/Presence.tsx`,
new `src/motion/Chevron.tsx`, new `src/motion/Meter.tsx`, `src/kit/Pop.tsx`, `src/composer/Menu.tsx`, `src/ui.tsx`.
**Do not touch:** any caller file (callers adopt in P1–P4), `MatrixLoader.tsx`, `native/**`.
**Exemplars:** `motion/success.ts` (`successTransform`: a paintTransform builder that returns `undefined` under Reduce
Motion or the stock addon), `composer/Menu.tsx` `materializeTransform` (scale .97 + opacity, 250 SO, origin),
`shell/toasts.tsx:283–361` (paint entrance + faster exit + retarget), `requests/Panel.tsx` (presence pattern).
Keep every exported name and prop that exists today: callers must keep compiling unchanged.

### P0.1 — Mirror the remaining desktop tokens
- **File:** `src/motion/kit.tsx:17–30`. **Change:** extend, do not rename:
  ```ts
  export const DURATION = { stagger: 0.04, micro: 0.08, quick: 0.15, fast: 0.25, medium: 0.35, slow: 0.4, verySlow: 0.5, spring: 0.45 } as const
  export const EASE = { smoothOut: [0.22, 1, 0.36, 1], out: [0.23, 1, 0.32, 1], inOut: [0.77, 0, 0.175, 1], drawer: [0.32, 0.72, 0, 1],
    bounce: [0.34, 1.36, 0.64, 1], bounceStrong: [0.34, 3.85, 0.64, 1], linear: [0, 0, 1, 1] } as const
  export const SCALE = { large: 0.96, medium: 0.97, small: 0.98, tiny: 0.99, press: 0.97 } as const   // --scale-*
  export const BLUR = { small: 2, medium: 3, large: 8 } as const                                      // --blur-* (px)
  /** --ease-spring + --duration-spring (response .35 s, bounce .15) as the native spring. */
  export const SPRING = { type: 'spring', duration: 0.45, bounce: 0.15 } as const
  ```
  `kit/Pop.tsx` `EASE_BOUNCE` and `motion/press.ts` `PRESS_SCALE` become aliases of `EASE.bounce` / `SCALE.press`.
  No new token beyond the desktop's `motion.css:13–74`. **Accept:** V-mech; `grep -rn "0.34, 1.36"` finds only kit.tsx.

### P0.2 — `Rise` on `paintTransform`, with the desktop's scale and blur
- **File:** `src/motion/kit.tsx:39–80` (`ENTER`, `Rise`). **Trigger:** mount of fresh content (callers pass `play`).
- **Target values** (desktop class → GPUIX kind), all `ease: EASE.smoothOut`, initial → identity:

  | kind | desktop | initial | duration | delay |
  |---|---|---|---|---|
  | `row` | `t-row-enter` | opacity 0, translateY 4, blur 2 | 250 | — |
  | `panel` | `t-panel-enter` | opacity 0, translateY 8, scale .985, blur 2 | 350 | — |
  | `section` | `t-section-enter` / `settings-section-in` | opacity 0, translateY 6, blur 2 | 250 | — |
  | `stagger` | `t-stagger` | opacity 0, translateY 12, blur 3 (blur 0 when index ≥ 4) | 500 | index × 70 ms |
  | `send` | `chat-message-send-enter` | opacity 0, translateY 6, scale .985, blur 2 | 260 | — |
  | `pane` (new kind) | `t-pane` | opacity 0, translateY 4, scale .995 | 250 | — |
  | `surface` (new kind) | `sidebar-surface-enter` | opacity 0, translateY 4 | 160, `EASE.out` | — |
  | `image` (new kind) | `t-img` | opacity 0, scale .985, blur 8 | 400 | — |
- **How:** export `enterTransform(kind, index = 0): PaintTransformProps | undefined` and render
  `<div paintTransform={play ? enterTransform(kind, index) : undefined} style={{ display: 'flex', flexDirection: 'column', ...style }}>`.
  Keep `testId` placement as today. `origin` default [.5, .5]; `send` uses `[1, 1]` (bubble grows from the right edge).
- **Asymmetry/interrupt:** enter only (exits are P0.4). A remount restarts it (same as the desktop's keyed classes).
- **RM:** `{ initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: DURATION.quick } }`.
- **Perf:** removes one window relayout per frame for every entrance in the app (page switch, rows, queued rows,
  account steps, home stagger, Empty states, transcript rows/bubbles). Layout slot is final from frame 0, so siblings no
  longer slide with the 4–12 px offset (matches the desktop's transform).
- **Accept:** V-strip of a page switch (rail Home → Notes) at 0/40/80/120/250 ms shows the page 6 px low, blurred and
  faint at 0, sharp and settled at 250; V-cost: no island renders during the tween; V-rm; callers compile unchanged.

### P0.3 — True `TextSwap` / `IconSwap`
- **File:** `src/motion/kit.tsx:217–238` (`Swap`). Callers inheriting: `composer/motion.tsx` `SwapOnChange`,
  `transcript/motion.tsx:66` `SwapOnChange`, `ModelPicker`, `bubble`, `rows`, `ImageActions`, `TitleBar`.
- **Target:** `Swap` gains `kind?: 'text' | 'icon'` (default `'text'`). It keeps the previous child for the exit:
  wrapper `position: 'relative'`; the incoming child in flow; the outgoing child absolutely positioned at
  `left: 0, top: 0` (text: `right: 0`/`bottom: 0` not set; icon: centred box of the same size), `pointerEvents: 'none'`.
  - text in: opacity 0 → 1, translateY 4 → 0, blur 2 → 0, 250 ms `EASE.smoothOut`; text out: opacity 1 → 0,
    translateY 0 → −4, blur 0 → 2, 150 ms `EASE.inOut` (`t-text-swap`, `motion.css:206`).
  - icon in: opacity 0 → 1, scale .6 → 1, blur 2 → 0; icon out: reverse; both 250 ms `EASE.inOut` (`t-icon-swap:250`).
  - The outgoing copy unmounts on its `onMotionComplete` (generation guarded). A third change while one is leaving
    drops the oldest copy immediately (at most two copies).
- **First paint:** still plain (keep `SwapOnChange`'s rule). **RM:** opacity only, 150 ms, no copy kept.
- **Perf:** paint-only; one extra mounted node for 250 ms. **Accept:** V-strip of the composer send ↔ sending swap and a
  copy → check at 0/60/120/250 ms shows both states overlapping mid-way (no blank frame, no jump); V-cost; V-rm.

### P0.4 — `Presence`: exits for anything that unmounts
- **New file:** `src/motion/Presence.tsx`.
  ```tsx
  export function Presence({ show, enter, exit, children, onGone, testId, style }: {
    show: boolean; enter?: PaintTransformProps; exit: { to: TransformValues; duration: number; ease?: Ease }
    children: ReactNode; onGone?: () => void; testId?: string; style?: StyleDesc })
  ```
  Keeps the last children while `show` is false (pattern of `requests/Panel.tsx` `PanelPresence`), animates
  `paintTransform` to `exit.to` with `pointerEvents: 'none'`, unmounts on `onMotionComplete` for the exit generation,
  and calls `onGone`. Re-showing mid-exit retargets back to identity (interruptible, no restart). Safety: if the window is
  hidden (`isWindowVisible()` false) unmount immediately — native frames do not run while hidden, so completion would
  never arrive. Keyboard callers pass `exit.duration: 0` (unmount at once).
- **Presets** exported next to it (desktop values): `EXIT.menu = { to: { opacity: 0, scale: .99 }, duration: .15 }`,
  `EXIT.tooltip = { to: { opacity: 0, scale: .98 }, duration: .08 }`, `EXIT.dialog = { to: { opacity: 0, scale: .98 }, duration: .15 }`,
  `EXIT.backdrop = { to: { opacity: 0 }, duration: .15 }`, `EXIT.row = { to: { opacity: 0, translateY: -4 }, duration: .15 }`,
  `EXIT.reveal = { to: { opacity: 0 }, duration: .1 }`, `EXIT.pane = { to: { opacity: 0, translateY: 4, scale: .995 }, duration: .15 }`.
  All exits use `EASE.smoothOut` (the desktop's exits share the enter curve and are ~40 % faster; do not fork the identity).
- **RM:** exit becomes opacity-only at 100 ms. **Accept:** unit test with a fake renderer for: exit keeps children until
  completion, re-show cancels, hidden window unmounts at once, keyboard duration 0 unmounts at once.

### P0.5 — `PopupLayer` materializes by default and can exit
- **File:** `src/composer/Menu.tsx:60–175`. Today `materialize` (paint scale .97) is opt-in and used only by
  `composer/StatusGlyph.tsx:137`; every other popup uses the `<anchored motion>` layout tween (fade + 4 px drift).
- **Target:**
  - Default every popup that is not `still` to `materialize`, with `origin` derived from `side`/`align` (bottom-start →
    `[0, 0]`, bottom-end → `[1, 0]`, top-start → `[0, 1]`, right → `[0, .5]`, left → `[1, .5]`, centred → `[.5, .5]`).
    Enter: `{ scale: SCALE.medium, opacity: 0, blur: BLUR.small }` → identity, 250 ms `EASE.smoothOut` (`menu.tsx:104`,
    `popover.tsx:64`). `kind: 'tooltip'`: `{ scale: SCALE.small, opacity: 0 }`, 150 ms `EASE.out`.
    `fade` layers (dialog scrim/card) keep their API; P3.14 sets the card values.
  - New prop `leaving?: boolean`: when true, animate to the exit preset (`EXIT.menu` / `EXIT.tooltip`) and
    `onLeft?: () => void` fires on completion. P3 wires this through `Presence`-style state in `nav/overlay.tsx`.
  - Remove the layout `motion` from `<anchored>` for materialized layers (already done for `materialize`).
- **Interrupt:** reopen during exit retargets. **RM:** 150 ms opacity both ways (existing `materializeTransform` RM path).
- **Perf:** removes a full relayout per frame for every menu/tooltip/popover/dialog open. The glass backdrop already moves
  inside the transform for `materialize` (one blur pass).
- **Accept:** V-strip of the composer model picker opening at 0/40/80/160/250 ms: grows from its trigger corner, slightly
  blurred, no drift; StatusGlyph popup unchanged; V-cost; V-rm.

### P0.6 — `Chevron` that rotates
- **New file:** `src/motion/Chevron.tsx`.
  `export function Chevron({ open, size = 14, color, turn = 90, testId })`: one `chevronRight` glyph (use `N.chevronRight`
  / `T.chevronRight` source — same SVG) wrapped in a `div` sized `size × size` with
  `paintTransform={{ initial: false, animate: { rotate: open ? turn : 0 }, transition: { duration: DISCLOSURE, ease: EASE.out } }}`
  (`DisclosureChevron`, 220 ms ease-out). `turn={180}` with a `chevronDown` source flips picker chevrons (250 ms `EASE.out`,
  `SettingsScreen:1133`). Initial render shows the end state (no rotation on mount).
- **Freq:** tens/day → the desktop's own 220 ms; keyboard toggles also rotate (the rotation does not delay the content).
- **RM:** `duration: 0`. **Perf:** glyph sprite rotation is exact and paint-only (`native/README.md` limits: rotate glyph
  subtrees only). **Accept:** V-strip at 0/55/110/220 ms shows 0°, ~45°, ~80°, 90°; no layout shift.

### P0.7 — `.press-row` darken
- **File:** `src/motion/press.ts`. `export function pressRowStyle(t: Theme, rest: string): StyleDesc` returns
  `{ active: { backgroundColor: shade(rest, t.variant === 'dark' ? 1.08 : 0.96) } }` where `rest` is the row's hover fill
  and `shade` multiplies RGB (alpha kept) like CSS `brightness()` (`motion.css:128`). Instant, like the desktop.
- **Why style, not paintTransform:** `active` styles already paint natively without React state (`ui.tsx` `ChromeButton`).
- **RM:** unchanged (not motion). **Accept:** unit test for `shade`; a held row is visibly darker (light) / lighter (dark).

### P0.8 — `revealTransform`: hover-revealed controls fade both ways
- **File:** `src/motion/kit.tsx`. `export function revealTransform(shown: boolean, slide = true): PaintTransformProps | undefined`
  → `{ initial: false, animate: { opacity: shown ? 1 : 0, translateX: shown || !slide ? 0 : 4 }, transition: { duration: shown ? .15 : .1, ease: EASE.out } }`
  (`t-reveal`, 150 ms in; exit ~30 % faster). Callers keep the element mounted while the row is hovered *or* for 100 ms
  after (use `Presence` with `EXIT.reveal`), and set `pointerEvents: 'none'` when not shown.
- **Freq:** tens/day hover → subtle, matches desktop. **RM:** opacity only. **Accept:** V-strip of a sidebar row hover-out.

### P0.9 — `MeterFill`: bars that fill without layout
- **New file:** `src/motion/Meter.tsx`. `MeterFill({ value, axis = 'x', length, thickness, radius, color, play })`: a track
  `div` with `overflow: 'hidden'` and `borderRadius`, holding a full-length fill offset by `-(1 - value) * length` on the
  axis via `paintTransform` `{ initial: play ? { translateX: -length } : false, animate: { translateX: -(1 - value) * length }, transition: { duration: DURATION.slow, ease: EASE.out } }`
  (`.limit-meter-track > span`, 400 ms ease-out). `axis: 'y'` grows upward (usage bars). Value changes retarget.
- **Why:** `paintTransform` scale is uniform (no `scaleX`), translate-inside-a-rounded-clip is exact and paint-only
  (`native/README.md`: masks inside the scope map through the transform; the entry mask stays).
- **RM:** `duration: 0`. **Accept:** V-strip of a 0 → 60 % fill at 0/100/200/400 ms; right end keeps its radius.

### P0.10 — `useCountPop(value)`
- **File:** `src/kit/Pop.tsx`. Returns a React `key` that changes when `value` changes after first render (not on mount,
  not when a virtual row recycles), for `<Label key={key} paintAnimation={popAnimation()}>`. Wraps `usePopOnChange`.
- **Accept:** unit test: first render no pop; change → new key; same value → same key.

### P0.11 — `hoverScale` for prominent buttons
- **File:** `src/motion/press.ts`. `hoverPressTransform(hover: boolean, enabled = true)`: combines the existing press
  (`press: { scale: .97, down .08, up .15 }`) with `animate: { scale: hover ? 1.05 : 1 }`, 150 ms `EASE.out`
  (`button.tsx:108` prominent `hover:scale-105`). One React render per hover change; the tween is paint-only.
- **RM/stock:** `undefined`. **Accept:** V-strip of hover-in on the composer send button (P2.1).

### P0.12 — `ArcDraw` for rings
- **File:** `src/motion/success.ts` (next to `strokeDraw`). `arcDraw(dash: number)` = `strokeDraw(dash, 0)` with
  `cycleMs: 400`, `ease: EASE.out` (`.rail-usage-arc`, stroke-dashoffset 400 ms). It draws the arc in from 0 when the arc
  mounts or its `key` changes. Value-to-value tweening (old → new) needs native N2; until then callers re-key only when the
  value changes by ≥ 5 points, so small refreshes do not redraw.
- **Accept:** V-strip of a ring drawing in; no redraw on an unchanged refresh.

---

## P1 — Shell, navigation, sidebar, home

**Owns:** `src/App.tsx`, `src/Draft.tsx`, `src/Sidebar.tsx`, `src/sidebar/**`, `src/nav/NavRail.tsx`, `src/nav/TitleBar.tsx`,
`src/nav/Handoff.tsx`, `src/nav/Sessions.tsx`, `src/shell/**`, `src/split/**`, `src/environment/**`, `src/environments/**`,
`src/platform/UpdateSurface.tsx`. **Do not touch:** P0 files, `nav/overlay.tsx`, `nav/Palette.tsx`, `MatrixLoader.tsx`.
**Exemplars:** `sidebar/motion.tsx` (`Reveal`, `FadeBack`, `Leave`, `DisclosureGroup`: tokens and RM handling),
`sidebar/rows.tsx:514,576` (`usePopOnChange` + `popAnimation`), `shell/toasts.tsx` (paint entrance/exit).
Evidence: `shell-home-dark.png`, `shell-sidebar-hover-dark.png`, `shell-sidebar-collapsed-dark.png`,
`shell-new-chat-hover-dark.png`, `thread-header-dark.png`, `toasts-dark.png`, `banner-*.png`, `env-panel-dark.png`,
`split-drop-dark.png`, `update-announcement-dark.png`, `shell3-rail*.png`.

### P1.1 — Sidebar disclosure chevrons rotate
- **Files:** `sidebar/rows.tsx:176–179` (`DisclosureChevron`, "instant") and its callers (project groups, recents,
  nested subagent groups, "Helper review" child toggle). **Desktop:** `Sidebar.tsx:293,432,595,761` rotate 220 ms.
- **Trigger:** click on a project/group header (tens/day). **Motion:** replace the glyph swap with P0.6 `Chevron turn={90}`;
  the rows' `DisclosureGroup` (already 220 ms ease-out) runs in sync. **Interrupt:** retargets. **RM:** instant.
- **Accept:** V-strip of collapsing `kybern-app` at 0/110/220 ms: chevron mid-turn while rows collapse; V-kbd (keyboard
  toggle, if bound) still rotates but content follows `DisclosureGroup` rules.

### P1.2 — Hover actions fade out, not vanish
- **Files:** `sidebar/motion.tsx:67–84` (`Reveal`: "They hide at once when the pointer leaves"), uses in `sidebar/rows.tsx:438,443,597`.
- **Trigger:** pointer leaving a row (tens/day). **Motion:** P0.8 `revealTransform` (in 150 EO + 4 px, out 100 opacity)
  via `Presence` with `EXIT.reveal`; the resting glyph's `FadeBack` (150 ms) now overlaps instead of popping. **RM:** opacity.
- **Perf:** paint-only; the leaving copy has `pointerEvents: 'none'`. **Accept:** V-strip of hover-out: archive/pin icons
  fade over 100 ms while the status glyph fades back; no frame with both fully opaque at the same x.

### P1.3 — Thread status glyph changes cross-swap; new dots pop
- **File:** `sidebar/rows.tsx:184–193` (`StatusGlyph`). **Today:** MatrixLoader → nothing/dot swaps instantly.
- **Trigger:** turn starts/ends, approval needed, failure, unread (occasional, ambient).
- **Motion:** wrap the glyph in P0.3 `Swap kind="icon" active={state}` (250 ms IO, scale .6 + blur 2 both ways).
  Unread / failed dots that appear after first render pop (`popTransform()` on the dot box, `usePopOnChange`), the same
  way "Pending" does at `rows.tsx:514`. Recycled virtual rows must not pop (use the existing `usePopOnChange` rule).
- **RM:** instant. **Accept:** V-strip while a scratch thread goes running → idle+unread: loader shrinks/blurs out while the
  blue dot pops in; scrolling the list does not replay pops.

### P1.4 — Thread title swap keeps the old title for its exit
- **File:** `sidebar/motion.tsx:103–121` (`TitleSwap`, fade-up 4 px only). Rebuild on P0.3 `Swap kind="text"` so the old
  title leaves (−4 px, blur 2, 150 IO). Keep `MarqueeLabel` behaviour. **Freq:** occasional (agent titles, renames).
- **Accept:** V-strip of a rename shows both titles mid-swap, then only the new one.

### P1.5 — Sidebar surface enter
- **File:** `Sidebar.tsx` (the list's root when its surface changes: environment switch, filter on/off, Projects ↔ chat
  list). **Desktop:** `sidebar-surface-enter` 160 ms ease-out from +4 px (`kit.css:111`).
- **Motion:** key the list root by surface and wrap it in `Rise kind="surface"` (P0.2); `play={false}` on first mount and
  when switched by keyboard. **RM:** opacity 150. **Accept:** V-strip of an environment switch.

### P1.6 — "Check for updates" status
- **File:** `Sidebar.tsx:303` (`SpinIcon` while checking). **Desktop:** `Sidebar.tsx:452–457` icon swap refresh ↔ spinner ↔ check.
- **Motion:** `Swap kind="icon"` between refresh, `SpinIcon`, and `SuccessCheck` (`motion/SuccessCheck.tsx`, 500 ms
  `t-success`) when the result is "up to date"; back to refresh after 2 s with another swap. **Freq:** rare → delight ok.
- **Accept:** V-strip of check → up-to-date shows the check rotating/drawing in.

### P1.7 — Sidebar open/close timing matches the desktop drawer
- **File:** `App.tsx:136–170` (width tween 220 ms `EASE_OUT` both ways). **Desktop:** `sidebar.tsx:40–48` open 260 ms,
  close 200 ms, `--ease-drawer`. **Motion:** `transition = open ? { duration: .26, ease: EASE.drawer } : { duration: .2, ease: EASE.drawer }`.
  Keyboard toggle (⌘B / title-bar shortcut) stays `{ duration: 0 }` (already `still`). **RM:** unchanged (instant).
- **Perf:** still a layout (width) tween — listed as F7 for the frame-rate lane; do not change the mechanism here.
- **Accept:** V-strip open at 0/65/130/260 ms follows the drawer curve (fast start, long settle).

### P1.8 — Rail pill: desktop curve, paint-only
- **File:** `nav/NavRail.tsx:67–72` (`motion.div` `top`, 220 ms `EASE_OUT`). **Desktop:** `t-tabs-pill` 250 ms `--ease-smooth-out`.
- **Motion:** render the pill once at its layout slot and move it with `paintTranslate`
  `{ initial: false, animate: { translateY: index * STEP }, transition: { duration: DURATION.fast, ease: EASE.smoothOut } }`
  (`src/drag/PaintTranslate.tsx` shows the generation/completion handling). Keyboard page switches (⌘1…⌘5): jump.
- **Freq:** navigation by click, tens/day: a 250 ms slide is spatial feedback the desktop already has.
- **Perf:** removes a window relayout per frame. **Accept:** V-strip Home → Tasks; V-cost (no island renders).

### P1.9 — Rail usage rings draw and dim
- **File:** `nav/NavRail.tsx:151–236` (`UsageRing`, static). **Desktop:** `RailUsage.tsx:86–89` arc 400 ms; stale → 0.5.
- **Motion:** P0.12 `arcDraw` on the arc `<svg>` when the first value arrives and when it moves ≥ 5 points; stale
  data: `paintTransform` opacity 1 → 0.5, 150 ms `EASE.out` (and back). **Native:** exact old → new tween is N2.
- **RM:** no draw (arc at value), opacity change instant. **Accept:** V-strip on first load; no redraw on identical refresh.

### P1.10 — Usage popover rows press
- **File:** `nav/NavRail.tsx` (rail usage popover rows). Add P0.7 `pressRowStyle`. **Accept:** held row darkens/lightens.

### P1.11 — Settings opens and closes as a layer
- **File:** `App.tsx:190` (`PageEnter` = `Rise section`, no exit). **Desktop:** `App.tsx:325–333`: enter spring from
  x 8 (300 ms), exit 120 ms to x 6.
- **Motion:** enter `paintTransform { initial: { opacity: 0, translateX: 8 }, animate: identity, transition: { type: 'spring', duration: .3, bounce: 0 } }`;
  leave via `Presence` `{ to: { opacity: 0, translateX: 6 }, duration: .12 }` while the workspace page enters with
  `Rise section`. Opened/closed by ⌘, or Escape: instant. **RM:** opacity 150 / 100.
- **Accept:** V-strip open and close by pointer; V-kbd for ⌘, and Escape.

### P1.12 — Back/forward dim
- **File:** `nav/TitleBar.tsx` (back/forward buttons). **Desktop:** `chrome.tsx:135` 150 ms opacity.
- **Motion:** `paintTransform { initial: false, animate: { opacity: enabled ? 1 : .35 }, transition: { duration: .15, ease: EASE.out } }`.
  **Freq:** tens/day, but only an opacity change → passes as near-imperceptible. **Accept:** strip after first navigation.

### P1.13 — Header title swap
- **File:** `nav/TitleBar.tsx:212–217,316` (`TitleSwap`). Adopt P0.3 text swap (via the P1.4 component).
  Thread switches by keyboard (⌘[ / ⌘]) render the new title plainly (first paint per thread is already plain).

### P1.14 — Update announcement matches `t-toast`
- **File:** `platform/UpdateSurface.tsx:101–113` (opacity + 16 px, 350/250 ms). Add `scale: SCALE.medium` and
  `blur: BLUR.small` to the paint entrance and exit (`motion.css:77`). **Freq:** rare. **Accept:** strip of its entrance.

### P1.15 — Home heading stagger gets its blur back
- **File:** `Draft.tsx:49,54,86` (`Rise stagger` 0/1/2). No change needed beyond P0.2; verify. **Accept:** strip of a fresh
  home at 0/70/140/500 ms: three lines rising 12 px with blur 3, 70 ms apart.

### P1.16 — Handoff targets
- **File:** `nav/Handoff.tsx:86` (arrow appears instantly on hover; `MatrixLoader` replaces it when busy).
- **Motion:** arrow via P0.8 `revealTransform` (150 in / 100 out, 4 px); arrow ↔ loader via `Swap kind="icon"`.
  **Accept:** strip of hover then click.

### P1.17 — Sessions dialog opening state
- **File:** `nav/Sessions.tsx:276,366`. Swap the row's glyph to the loader with `Swap kind="icon"`; rows that arrive after
  the dialog is open (a refresh) enter with `Rise kind="row"`; the first page renders plainly.

### P1.18 — Split pane focus ring fades
- **File:** `split/Workspace.tsx:131` (static ring). **Desktop:** `.split-thread-pane::after` 120 ms.
- **Motion:** keep the ring mounted; `paintTransform` opacity 0 ↔ 1, 120 ms `EASE.out`. **Freq:** tens/day pane focus by
  pointer; keyboard focus moves (⌘⌥←/→) instant. **Accept:** strip of clicking the other pane.

### P1.19 — Environment disclosure chevrons
- **File:** `environments/kit.tsx:93` (`motion.svg` rotate with `duration: 0`). Replace with P0.6 `Chevron` (220 EO).

### P1.20 — SSH / address chooser pill
- **File:** `environments/Dialogs.tsx:49` (`translateX` 220 EO). Use 250 ms `EASE.smoothOut` (`t-tabs`) and `paintTranslate`.

### P1.21 — Connection banner (keep) and toasts (keep)
- `shell/Connection.tsx:88` matches the desktop (150 ms, −4 px, both ways): migrate its `motion.div` to `Presence` with
  `{ initial: { opacity: 0, translateY: -4 } }` / `{ to: { opacity: 0, translateY: -4 }, duration: .1 }` (paint-only).
- `shell/toasts.tsx`: **no change** — it already follows the user's toast preference (X-dismiss, opacity + clearing blur +
  97 % settle, faster mirrored exit). Do not add the desktop's 16 px rise (rejected R6).

### P1.22 — Thread rows press-row
- **File:** `sidebar/rows.tsx:148` (rows already skip scale: wide). Add P0.7 `pressRowStyle(t, accent(t))` to thread,
  project and "New chat"/"Resume session" rows. **Freq:** 100+/day clicks, but instant colour only (no motion) — allowed.

---

## P2 — Composer, transcript, requests, subagents, live view

**Owns:** `src/Composer.tsx`, `src/composer/**` except `Menu.tsx`, `src/Transcript.tsx`, `src/transcript/**` (not the
`Shimmer` internals or `useLoaderTime` in `transcript/motion.tsx`), `src/requests/**`, `src/subagents/**`,
`src/coordinator/**`, `src/live/**`, `src/platform/ImageActions.tsx`.
**Do not touch:** P0 files, `MatrixLoader.tsx`, streaming pacing (`useSmoothText`, `useStreamEffects`, virtual rows) —
read `apps/desktop/perf/README.md` and `apps/gpuix/perf/README.md` before touching anything that runs while streaming.
**Exemplars:** `transcript/rows.tsx:391–395` (fresh-only `Rise`), `transcript/rows.tsx:207–209` (loader → `SuccessCheck`),
`requests/Panel.tsx` (keyboard-instant presence).
Evidence: `conversation-*.png`, `convo9-*.png`, `composer-home-workspace-dark.png`, `shell3-rail*.png`, `palette-dark.png`.

### P2.1 — Send button hover scale
- **File:** `Composer.tsx:759–794`. Replace `pressTransform(!disabled)` with P0.11 `hoverPressTransform(hover, !disabled)`.
  **Desktop:** `button.tsx:108` prominent `hover:scale-105` 150 ms. **RM:** none. **Accept:** strip of hover-in/out.

### P2.2 — Send ↔ sending/stop swap
- **File:** `Composer.tsx:759–765` (`SwapOnChange` fade-up). P0.3 `kind="icon"`: arrow shrinks/blurs out while the loader
  or stop square grows in. Sending by ⌘↩/↩ is keyboard: the swap still plays because it reports state, not navigation
  (it does not delay input). **Accept:** strip at 0/60/125/250 ms.

### P2.3 — Tray chips press
- **File:** `composer/Tray.tsx`, `composer/chips.tsx` (no press today). `pressTransform(true, SCALE.large)` (0.96,
  `Draft.tsx:198` desktop). **Accept:** strip of mouse-down on the branch chip.

### P2.4 — Attachment tile removal
- **File:** `Composer.tsx:903` (`Pop` on add; removal instant). **Motion:** `Presence` exit
  `{ to: { opacity: 0, scale: .85 }, duration: .15 }` (mirror of `t-pop`, faster), then the row closes. Neighbour tiles
  jump left after removal (layout) — accepted; do not FLIP. **RM:** opacity 100. **Accept:** strip of clicking ✕ on a tile.

### P2.5 — Queued follow-up leaves
- **File:** `Composer.tsx:1021–1045` (`Rise row` on add; send/remove instant). Wrap rows in the existing sidebar `Leave`
  pattern (copy the 200 ms collapse+fade from `sidebar/motion.tsx:206–237` into `composer/motion.tsx`; do not import
  from P1-owned files). **Accept:** strip of removing a queued row (`conversation-queued`).

### P2.6 — Effort slider held thumb and settle
- **File:** `composer/ModelPicker.tsx:938–1015`. **Desktop:** held thumb scale 1.06 + shadow 200 ms; settle 450 ms spring.
- **Motion:** thumb `paintTransform.press { scale: 1.06, down: { duration: .2 }, up: { duration: .15 } }`; the release
  settle uses `SPRING` (P0.1) instead of 200 ms EO; 70 ms tracking while dragging stays. Shadow: a shadow layer under the
  thumb whose opacity rides the same press (use `paintTransform` opacity on the layer). **Accept:** strip of press-drag-release.

### P2.7 — Model picker busy dim
- **File:** `composer/ModelPicker.tsx` (busy state). `paintTransform` opacity → .5 over 150 ms `EASE.out` (`ModelPicker.tsx:592–599`).

### P2.8 — Transcript chevrons rotate
- **Files:** `transcript/kit.tsx:50–52` (`Chevron` glyph swap) — re-export P0.6 `Chevron` here so `rows.tsx:262`,
  `Turn.tsx` ("Worked for", edited files, "show all", diff file) rotate 220 ms while `Collapse` opens.

### P2.9 — Message hover actions fade
- **File:** `transcript/bubble.tsx:216–219` (`opacity: hover ? 1 : 0`, instant). **Desktop:** `Transcript.tsx:110` opacity transition.
- **Motion:** `revealTransform(hover, false)` (150 in / 100 out, opacity only — they sit under the text, no slide).
  **Accept:** strip of hovering a user bubble; copy button clickable only when shown.

### P2.10 — Jump to latest: scale and blur
- **File:** `Transcript.tsx:465–495` (`ScrollToBottom`, `motion.div` on `bottom`, comment "drops scale and blur").
- **Motion:** `Presence` with enter `{ opacity: 0, translateY: 4, scale: .95, blur: 2 }` → identity 250 SO and exit
  `{ to: { opacity: 0, translateY: 4, scale: .95, blur: 2 }, duration: .15 }`; `origin [.5, 1]`. **Perf:** removes a relayout
  per frame while scrolling away from the tail (this appears mid-scroll). **Accept:** strip of scrolling up 600 px.

### P2.11 — Copy → check
- **Files:** `transcript/bubble.tsx:51`, `transcript/markdown.tsx:115`, `platform/ImageActions.tsx:68` (`SwapOnChange`).
  Adopt P0.3 `kind="icon"`; the check reverts after its existing timeout with the same swap.

### P2.12 — Image reveal (`t-img`)
- **File:** `transcript/images.tsx:115–119` (image appears when decoded). **Motion:** `Rise kind="image"` (P0.2: opacity 0,
  scale .985, blur 8 → identity, 400 ms SO) once the image reports load; history images render plainly (`useFresh`).
  **Perf:** one 8 px blur pass for 400 ms per fresh image — measure V-cost with 3 images arriving at once; drop blur to 3 px
  if any frame > 16.7 ms. **RM:** opacity 150. **Accept:** strip with a fresh assistant image.

### P2.13 — Request cards on paint
- **File:** `requests/Panel.tsx` (`PanelEnter`/`PanelPresence`: layout `top` tween 180/120 ms). Keep the timings (they are
  intentionally snappier than the desktop and keyboard answers stay instant) but move to `paintTransform`
  `{ opacity: 0, translateY: 6, blur: 2 }` → identity 180 EO; exit `{ to: { opacity: 0, translateY: 3 }, duration: .12 }`.
  **Accept:** strip of `conversation-approval` appearing and of a pointer approve; V-kbd for a keyboard approve.

### P2.14 — Submit labels swap
- **File:** `transcript/Requests.tsx` (approve/decline/submit buttons; secret/question/coordinator cards). **Desktop:**
  `QuestionSteps:63`, `SecretRequestPanel:167`, `UserInputPanel:115`, `CoordinatorCards:132/210` TextSwap to "Sending…"/"Saving…".
  Wrap the button label in `Swap kind="text" active={label}`. **Accept:** strip of approving with the pointer.

### P2.15 — Subagent / delegation status swaps
- **Files:** `subagents/Page.tsx:74`, `subagents/Launch.tsx:34–38`, `transcript/Messages.tsx:102,131`.
  Loader ↔ check/alert via `Swap kind="icon"`; status words ("Working" → "Done") via `Swap kind="text"`.

### P2.16 — Subagent bar actions appear
- **File:** `subagents/Page.tsx` (bar actions mount when a child finishes). **Desktop:** `sa-bar-action` 150 ms fade from blur 2.
  `paintTransform { initial: { opacity: 0, blur: 2 }, animate: identity, transition: { duration: .15, ease: EASE.out } }`.

### P2.17 — Subagent strip collapses
- **File:** `requests/Activity.tsx:110–111` (strip collapse instant). Use `Collapse` (220 ms) + P0.6 `Chevron`.

### P2.18 — Held message rows
- **File:** `requests/Activity.tsx:101–110`. New held rows `Rise kind="row"` (fresh only); detail disclosure `Collapse` +
  `Chevron` (`HeldMessagesPanel:25,53,66–70`).

### P2.19 — Visual reply frame and Open button
- **File:** `transcript/Visual.tsx` (frame appears when ready; Open button static). **Desktop:** kit.css 3514–3589: frame
  150 ms fade; Open button reveal 150 ms from −2 px on hover. The frame is a native web view: fade the **card chrome and
  skeleton** with `paintTransform` and leave the web view's own alpha to N3; the Open button uses
  `revealTransform` with translateY −2 (`slide` variant on Y). **Accept:** strip of a fresh visual reply.

### P2.20 — Live view controls and click ripple
- **File:** `live/ComputerLiveView.tsx:70–102`. **Desktop:** `.computer-live-controls` 200 ms from +4 px;
  `.computer-live-marker` 480 ms ripple.
- **Motion:** controls `revealTransform` on hover (Y 4 px, 200 ms in / 120 out). Ripple: a 24 px ring at the click point,
  `paintTransform { initial: { scale: .4, opacity: .5 }, animate: { scale: 1.6, opacity: 0 }, transition: { duration: .48, ease: EASE.out } }`,
  unmounted on completion; at most 3 at once. **Freq:** occasional (agent clicks) → feedback. **RM:** no ripple; controls fade.

### P2.21 — Live view closes
- **File:** `live/Floating.tsx:67` (fade in, no exit scale). Exit via `Presence` `{ to: { opacity: 0, scale: .98 }, duration: .16 }`
  (`kybern.css:301`).

### P2.22 — Bottom scroll fade
- **File:** `Transcript.tsx` (near `ScrollToBottom`, `atTail` state exists). **Desktop:** `.chat-scroll-fade` (kit.css:3340).
- **Motion:** a 32 px gradient strip above the composer (background → transparent), shown when `!atTail`, opacity 0 ↔ 1
  over 150 ms `EASE.out` (`paintTransform`). Purpose: state (more content below). No movement. **Accept:** strip when
  scrolling off the tail; no extra frames while settled.

### P2.23 — Turn completion fold (verify, then fix if instant)
- **File:** `transcript/Turn.tsx:148–170`. When a live turn completes, its work rows fold into "Worked for …". Check
  with `transcript-motion.ts` whether the rows disappear in one frame; if so, start the fold `open` and close it with the
  existing `Collapse` (220 ms) on completion. Never animate while the user is scrolled up (reading position is preserved:
  keep the anchor logic in `Transcript.tsx`). **Accept:** strip of a turn completing in `stream.fixture.tsx`.

### P2.24 — Ultrathink frame (needs N4)
- **File:** `Composer.tsx` (ultrathink keyword state). **Desktop:** `.ultrathink-*` 10 s rainbow / hue loop (kit.css:3241–3270).
  Rare, delight. Blocked on native N4 (hue/colour loop on paint). Do not emulate with JS colour ticks.

---

## P3 — Dock, explorer, terminal, preview + overlays and kit

**Owns:** `src/dock/**`, `src/terminal/**`, `src/preview/**`, `src/native/DiffView.tsx` (motion props only),
`src/nav/overlay.tsx`, `src/nav/Palette.tsx`, `src/kit/**` except `kit/Pop.tsx`.
**Do not touch:** P0 files (`composer/Menu.tsx` `PopupLayer` is P0), `dock/MotionFileTree.tsx` springs (already parity),
`drag/**`. **Exemplars:** `dock/Dock.tsx:200–205` (press + pop), `kit/Sheet.tsx` (enter/exit both ways), `kit/AlertDialog.tsx:66–110`
(presence for overlay layers). Evidence: `dock-*.png`, `blur-popover-dark.png`, `dialog-*.png`, `palette-dark.png`,
`close-guard-dark.png`, `pulls-merge-menu-dark.png`.

### P3.1 — Dock pane switch (`t-pane`)
- **File:** `dock/Dock.tsx` (only the chosen pane is mounted; tab click swaps instantly). **Desktop:** `RightPanel.tsx:155–190`.
- **Motion:** key the pane by tab id and wrap it in `Rise kind="pane"` (P0.2: opacity 0, +4 px, scale .995 → 1, 250 SO).
  The outgoing pane unmounts at once (desktop keeps it under `opacity: 0`; GPUIX releases memory — keep that).
  Keyboard tab switches: `play={false}`. **Accept:** strip Agents → Explorer; V-kbd.

### P3.2 — Dock open/close
- **File:** `dock/Dock.tsx:85` (width tween 220 EO, no opacity). **Desktop:** `App.tsx:297–316` width + opacity spring
  (stiffness 420, damping 42, mass .7).
- **Motion:** width transition `{ type: 'spring', stiffness: 420, damping: 42, mass: .7 }` (physical springs are native,
  `native/README.md` "Rounded overflow and Explorer motion"); the dock content fades `paintTransform` opacity 0 → 1 over
  250 SO on open and 1 → 0 over 150 on close. Shortcut toggles: instant. **Perf:** width = layout → F8.

### P3.3 — Dock tab pill curve
- **File:** `dock/Dock.tsx:185` (left + width, 220 EO). Use 250 ms `EASE.smoothOut`. Width changes require layout (F12):
  keep `motion.div` here; if both tabs are equal width, move only `left` with `paintTranslate`.

### P3.4 — Dock tabs appear and close
- **File:** `dock/Dock.tsx` (tab strip). A tab added from the + menu enters `paintTransform { opacity: 0, scale: .97 }` →
  identity, 150 EO; a closed tab leaves via `Presence` `{ to: { opacity: 0, scale: .97 }, duration: .12 }` before the
  strip closes the gap. **Accept:** `dock-add-menu` → add Terminal.

### P3.5 — Agents tree (lineage)
- **File:** `dock/Agents.tsx:146–153`. Chevron → P0.6 `Chevron`; children toggle → `Collapse` (220 ms); fresh children
  `Rise kind="row"`; phase loader ↔ check/alert `Swap kind="icon"`; status text `Swap kind="text"`
  (`LineageRow:61,75–119`). **Accept:** strip of a child finishing in `conversation-subagents` with the dock open.

### P3.6 — Empty-state stagger actually staggers
- **File:** `kit/Empty.tsx:22` passes `index={0}` to every item. Use `index={i}` (desktop `t-stagger`, 70 ms apart, max 3
  items here). **Accept:** strip of the dock empty state (`dock-agents`): icon, title, description 70 ms apart.

### P3.7 — Explorer loading states
- **File:** `dock/Explorer.tsx:212` ("Loading file…" text). **Desktop:** `Explorer.tsx:230,371` skeleton sweep; folder
  loading spinner. **Motion:** show `kit/Skeleton` lines after 150 ms (never flash for fast loads: the transcript's
  `chat-mount-loader-in` rule); the loaded file enters with `Rise kind="pane"`. Folder rows show `kit/Spinner` (size 12) in the
  chevron slot after 150 ms while children load. **Accept:** strip with a slow file (large fixture).

### P3.8 — Diff view chevrons and loading
- **Files:** `dock/Diff.tsx`, `native/DiffView.tsx` (file headers). File header chevron → P0.6 `Chevron`; loading →
  `Skeleton` after 150 ms. Do not animate hunk content (data).

### P3.9 — Terminal tabs
- **File:** `terminal/Terminal.tsx` (tab panes instant; close icon instant). **Desktop:** `Terminal.tsx:199` pane opacity,
  `:221–224` close icon hover fade. **Motion:** the newly shown tab's pane `paintTransform` opacity 0 → 1 150 EO (no
  translate: terminal text must not shift); close icon `revealTransform(hover, false)`. Never use `visibility: hidden`.
  **Accept:** `dock-terminal` with two tabs.

### P3.10 — Preview chrome
- **File:** `preview/Chrome.tsx:65–76`, `preview/Preview.tsx:105`. Reload ↔ stop: `Swap kind="icon"`; back/forward/reload
  dim: `paintTransform` opacity 150 EO (instead of instant `opacity` style); address bar hover reveal 150 ms; empty-state
  recents: press + remove-button `revealTransform`. **Accept:** `dock-preview` strip of a reload.

### P3.11 — Preview surface fade, PiP exit (needs N3)
- **Files:** `preview/Surface.tsx`, `preview/MiniChrome.tsx`. **Desktop:** kit.css 3643/3674/3746: 150 ms fades; PiP exit
  scale .96. The page itself is a native WKWebView layer that `paintTransform` cannot fade. Implement the chrome part now
  (header, border, shadow via `Presence`); the web view alpha/scale waits for N3.

### P3.12 — Menus and context menus exit
- **File:** `nav/overlay.tsx:240–410` (`Menu`, `ContextMenu`, `MenuSub`). Today they unmount at once.
- **Motion:** keep the popup mounted after close with P0.5 `leaving` (150 ms → scale .99, opacity 0), then unmount; the
  trigger regains focus immediately (do not wait for the exit). Close by Escape/keyboard pick: unmount at once. Picking an
  item with the pointer plays the exit. Submenus exit with the parent. **Accept:** strip of a pointer pick in
  `pulls-merge-menu`; V-kbd for Escape.

### P3.13 — Tooltips
- **File:** `nav/overlay.tsx:714–788` (`Tip`). With P0.5 `kind="tooltip"`: scale .98 → 1, 150 EO in; exit 80 ms;
  `state.instant` (a neighbour just closed) stays still in and out. **Freq:** tens/day → this is the desktop's own subtle motion.
  **Accept:** strip of hovering one rail button, then sliding to the next (second is instant).

### P3.14 — Dialogs
- **File:** `nav/overlay.tsx:829–925` (`Dialog`: fade + 4 px rise, instant close). **Desktop:** `dialog.tsx:27,55`.
- **Motion:** scrim: opacity 0 → .6 250 SO, exit 150. Card: `{ opacity: 0, scale: SCALE.large, blur: BLUR.small }` → identity
  250 SO (paint, `origin [.5, .5]` — modals stay centred); exit `EXIT.dialog` (150 → scale .98). Card and scrim exit
  together; focus returns at once. `instant` (shortcut-opened) stays still both ways.
- **Accept:** strip of `dialog-project` opening/closing by pointer; V-kbd; both themes (scrim compositing on light).

### P3.15 — Palette
- **File:** `nav/Palette.tsx` → `Dialog variant="palette"`. ⌘K open/close: instant (Gate: keyboard, 100+/day). Opened from
  the sidebar search icon (pointer): P3.14 motion. Result list changes while typing: never animated.

### P3.16 — Alert dialog card scale
- **File:** `kit/AlertDialog.tsx:66–120` (fade both ways, no scale). Add `scale: SCALE.small` (.98) to the card's paint
  enter/exit, 200 ms `EASE.inOut` both ways (`alert-dialog.tsx:22,46`). **Accept:** `close-guard`.

### P3.17 — Hover card
- **File:** `kit/HoverCard.tsx:56–67`. P0.5 `materialize` with `scale: SCALE.small`, origin at the trigger side;
  instant when chained (`hoverController`). Exit 80 ms.

### P3.18 — Select popup (pointer-opened)
- **File:** `kit/Select.tsx` (desktop has no motion: "appears and disappears at once"). Additive: pointer-opened popup
  `materialize` scale .98 + opacity, 150 ms `EASE.out`, exit 100 ms; keyboard-opened (Space/Enter/↓): instant.
  `alignItemWithTrigger` placement: origin at the selected row's vertical centre. **Freq:** occasional (settings, filters).

### P3.19 — Segmented / Switch / Toggle pills on paint
- **Files:** `kit/Segmented.tsx:121`, `kit/Switch.tsx:126–129`, `dock/parts.tsx:57`. Equal-width segments and switch thumbs
  move only `left`: replace the `motion.div` with `paintTranslate` (same durations: segmented 250 SO, switch 200 EO). The
  switch's held thumb stretch (`scale-x 1.1`) needs non-uniform scale: keep today's behaviour (N5 would allow it).

### P3.20 — Badge counts pop
- **File:** `kit/Badge.tsx`. When the badge's numeric content changes after first render: P0.10 `useCountPop` + `popAnimation()`.

---

## P4 — Pages: Notes, Tasks, Pull requests, Usage, Settings, dialogs

**Owns:** `src/notes/**`, `src/tasks/**`, `src/pulls/**`, `src/usage/**`, `src/settings/**`, `src/editor/**`
(TypeScript only; `rich-editor` native element is out of scope), `src/dialogs/**`.
**Do not touch:** P0 files, `kit/**`, `tasks/drag.tsx` and `drag/**` physics (parity measured in round 8).
**Exemplars:** `notes/NoteThumb.tsx:26–31` (paint press), `tasks/SelectionBar.tsx:36`, `settings/Accounts.tsx:146` (row flash).
Evidence: `notes-*.png`, `tasks-*.png`, `pulls-*.png`, `usage-*.png`, `settings-*.png`, `dialog-worktree-dark.png`.

### P4.1 — Opening a note
- **File:** `notes/NoteEditor.tsx` (mounts plainly). **Desktop:** `note-doc-in` 200 ms, 6 px (`notes.css:784`).
- **Motion:** document column `paintTransform { opacity: 0, translateY: 6, blur: 2 }` → identity, 200 ms `EASE.smoothOut`,
  when opened by pointer from the gallery/list; Enter-opened: instant. **Accept:** strip from `notes-gallery` click.

### P4.2 — Note banner
- **File:** `notes/NoteEditor.tsx:231`. **Desktop:** `note-banner-in` 180 ms, 4 px. `Rise`-style paint enter, fresh only.

### P4.3 — Save status
- **File:** `notes/EditorBar.tsx` / `notes/Header.tsx` (save status text). `Swap kind="text"` ("Saving…" → "Saved");
  desktop `SaveStatus:80` 150 ms opacity. Typing itself never animates; only the status label swaps, at most once per save.

### P4.4 — Gallery stagger on paint
- **File:** `notes/NotesPage.tsx:183–210` (`motion.div` opacity + `top` per card, 25 ms stagger). Keep the timing
  (170 ms, 6 px, 25 ms), move to `paintTransform`; no blur (many cards). Only on first gallery open per session and
  filter changes by pointer. **Perf:** removes N relayouts per frame. **Accept:** V-cost on a 30-note gallery.

### P4.5 — Note card hover lift on paint
- **File:** `notes/NoteThumb.tsx:89–101` (`motion.div` lift via layout). Use `paintTransform translateY −2` (140 ms
  `EASE.out`); the lift shadow becomes a second shadow layer whose opacity rides the same hover (paint opacity).
  Press `.985` unchanged. **Freq:** tens/day hover → matches the desktop's subtle lift.

### P4.6 — Deleting a note
- **File:** `notes/NotesPage.tsx` (card removal instant). Pointer delete (menu): `Presence` `{ to: { opacity: 0, scale: .97 }, duration: .15 }`
  then remove; keyboard delete (⌫ in gallery): instant. Neighbours reflow without FLIP.

### P4.7 — Task glyph ↔ checkbox
- **File:** `tasks/TaskList.tsx:188–192,242` (instant swap on hover/selection). **Desktop:** tasks.css 1608–1656, 80 ms
  cross-fade. Both layers stay mounted in one 16 px slot; `paintTransform` opacity 80 ms `EASE.out` (`DURATION.micro`).
  **Freq:** tens/day hover → 80 ms opacity is near-imperceptible by design. **Accept:** `tasks-hover` strip at 0/40/80 ms.

### P4.8 — Selection bar blur and exit
- **File:** `tasks/SelectionBar.tsx:36`. Move to `paintTransform`: in `{ opacity: 0, translateY: 8, blur: 2 }` 200 SO;
  out `{ opacity: 0, translateY: 4 }` 140 ms via `Presence` (`tasks.css:1695`). **Accept:** `tasks-select` strip.

### P4.9 — Batch composer dock and run dock
- **Files:** `tasks/TasksPage.tsx`, `tasks/RunComposer.tsx`, `tasks/TaskWindow.tsx`. **Desktop:** `TaskBatchDock:198`,
  `dockMotion.ts:19–21` (+16 px, 260 ms `--ease-drawer`; out 160 ms, 10 px); `TaskRunDock:256–422` panels 180 ms fade,
  out 100 ms. Implement with `Presence` and paint values above.

### P4.10 — Tasks sidebar project group
- **File:** `tasks/TasksSidebar.tsx:119–121` (glyph swap, rows instant). P0.6 `Chevron` + `Collapse` around the project list.

### P4.11 — Task page open by pointer
- **File:** `tasks/TaskDetail.tsx` / `tasks/TasksPage.tsx`. `Rise kind="section"` when opened by click from list/board;
  Enter/⌘↓ opens instantly. Back to list: no motion (frequent).

### P4.12 — Task status and counts
- **Files:** `tasks/Glyphs.tsx`, `tasks/Header.tsx`, board column headers. Status glyph changes (todo → running → done):
  `Swap kind="icon"`; column/group counts: `useCountPop`. Running glyph breathe stays with the frame-rate lane (F3).

### P4.13 — PR tabs and state filter
- **Files:** `pulls/PrTabs.tsx` (no pill), `pulls/PullRequestsPage.tsx` (Open/Merged/Closed/All, no pill). **Desktop:**
  `PrTabs:33–84` `t-tabs` + press; `PrList` segmented. **Motion:** one sliding pill / underline per group via `paintTranslate`
  (250 SO) when widths are equal, otherwise `motion.div` left+width (F12); tab content `Rise kind="pane"`. Press on tabs.
  **Accept:** `pulls-summary` → Changes → Timeline strip.

### P4.14 — PR loading, refresh and copy
- **Files:** `pulls/PrStates.tsx` ("Loading…" text), `pulls/PrDetail.tsx:50` (refresh static), copy-link button.
  Skeleton rows after 150 ms (`kit/Skeleton`); refresh glyph `SpinIcon` while refreshing; copy link `Swap kind="icon"` to
  a check for 1.5 s.

### P4.15 — PR merged
- **File:** `pulls/PrDetail.tsx` (merge flow). After a successful merge: the state pill swaps Open → Merged with
  `Swap kind="text"` + `popTransform()` on the pill, and a `SuccessCheck` (500 ms `t-success`) replaces the merge button
  glyph for 1.5 s. **Freq:** rare → delight budget. **RM:** plain swap.

### P4.16 — Usage meters and switches
- **Files:** `usage/AccountMark.tsx` (`LimitMeter` static), `usage/UsagePage.tsx:128` (bars: `height` tween, 30 bars),
  `usage/controls.tsx:25`. **Motion:** limit meters P0.9 `MeterFill` 400 EO; daily bars `MeterFill axis="y"` (first load
  only, 25 ms stagger kept) — removes 30 concurrent layout tweens; group-by switch (Agent/Model/Day): breakdown table
  `Rise kind="pane"`; the three headline numbers `Swap kind="text"` when the range changes by pointer.
  Bars do **not** re-grow on every switch (R12).

### P4.17 — Settings section switch and nav pill
- **File:** `settings/SettingsScreen.tsx:82,90` (`virtual-list key={tab}` remounts plainly; pill `top` 220 EO).
  **Desktop:** `settings.css:29` 250 ms from +6 px; `t-tabs` 250 SO. **Motion:** wrap the list's heading + first section in
  `Rise kind="section"` keyed by tab (pointer only); pill via `paintTranslate` 250 SO; keyboard tab moves: instant.
  **Accept:** `settings-general` → Appearance strip.

### P4.18 — Settings live states
- **Files:** `settings/*.tsx`. Status texts (`SettingsScreen:591` equivalents): `Swap kind="text"`; "Right now" daemon
  counts (`SettingsScreen:693,706`): `useCountPop` + text swap; project overrides chevron → `Chevron turn={180}` 250 EO;
  unit dim 150 ms opacity; Accounts loading → `Skeleton` after 150 ms; `dialogs/WorktreeCleanup.tsx` checked count → `useCountPop`.

---

## Native work (for the native lane; do not build in P0–P4)

| # | Capability | Unblocks | Notes |
|---|---|---|---|
| N1 | **Colour transitions for `hover`/`active` styles** (`backgroundColor`, `borderColor`, `color`) with a declared duration/ease, painted through scoped paint (fill/opacity allowlist), no React state | every hover fill in the app (desktop `transition-colors` 150 ms on buttons, rows, tabs, chips; `ResizeHandle` hairline) | Highest leverage native item: today every hover fill snaps. |
| N2 | `stroke` paint animation **from fraction → to fraction** with retargeting | usage rings (P1.9), composer context ring (`StatusGlyph.tsx:105`), PR checks ring | Today `strokeDraw` only draws in from 0. |
| N3 | Opacity/scale animation of embedded **WKWebView** layers following the host `paintTransform` | preview surface fade, PiP exit (P3.11), visual reply frame (P2.19) | CALayer animation tied to the native clock. |
| N4 | **Colour/hue loop** and gradient band sweep on text/border (`t-shimmer` band, ultrathink rainbow) | P2.24; a true `.t-shimmer` sweep instead of the brightness pulse | Must pause offscreen/hidden like `rotate`. |
| N5 | Non-uniform scale (`scaleX`/`scaleY`) in `paintTransform` | switch held-thumb stretch, `t-bar` scaleX | `MeterFill` covers bars without it. |
| N6 | Press feedback and tick inside `rich-editor` checklists (`.92` press) | notes checklists (`notes.css:1423–1446`) | Inside `patches/rich_editor.rs`. |
| N7 | Height disclosure without per-frame window layout (paint clip reveal + sibling translation, final layout once) | `Collapse`, `DisclosureGroup`, `Leave`, dock/sidebar width | Also the frame-rate lane's lead for F4–F8. |
| N8 | Shadow parameter tween in `paintTransform` (spread/opacity independent of scale) | note card lift, task ghost, effort thumb | Workaround: an extra shadow layer with paint opacity. |

## Suspected below 60 fps today (for the frame-rate lane; not fixed by these packages)

| # | Where | Why |
|---|---|---|
| F1 | `MatrixLoader` everywhere (sidebar running, transcript Working, composer sending, subagents, Agents dock, palette, sessions, handoff, model picker reload, settings installs, account dialog, undo) | 200 ms shared tick (`MatrixLoader.tsx:24`, 5 Hz) unless `KYBERN_NATIVE_PAINT_ANIMATIONS=1` (`pacing-round7`: "historical 5 Hz loop remains an unresolved defect"). |
| F2 | `Shimmer` (Thinking, active tool label, "Loading changes…", live view caption) | `SampledShimmer` reads `useLoaderTime` on the same 5 Hz clock. |
| F3 | Task running glyph breathe (`tasks/Glyphs.tsx:99–108`) | `useLoaderStep` 8 steps at 5 Hz. |
| F4 | Connection spinner fallback (`shell/Connection.tsx:49`) | 8 pre-rotated frames on the loader clock when not native. |
| F5 | Visual reply skeleton (`transcript/Visual.tsx:158`) | `useLoaderTime` breathe on the 5 Hz clock. |
| F6 | Environment inset (`split/Workspace.tsx:150`) | width tween; measured 35–38 ms median / 51–53 ms p95 submissions (`perf/motion-2026-10-16.md`). |
| F7 | Sidebar open/close (`App.tsx:136`) | width tween relayouts the window every frame. |
| F8 | Dock open/close (`dock/Dock.tsx:85`) | width tween. |
| F9 | `Collapse` / `DisclosureGroup` / `Leave` (transcript, sidebar) | height tweens; cold disclosure p95 63–66 ms in light (`pacing-round7`). |
| F10 | Usage daily bars (`usage/UsagePage.tsx:128`) | 30 concurrent height tweens (P4.16 moves them to paint). |
| F11 | Notes gallery card stagger (`notes/NotesPage.tsx:183`) | N concurrent `top` tweens (P4.4 moves to paint). |
| F12 | Pills with width: dock tabs (`Dock.tsx:185`), mention chips, PR tabs | left + width tween. |
| F13 | Every `Rise`/`Popup`/`Swap`/`PopupLayer` entrance and the page switch (`App.tsx:235`) | layout tweens (P0.2/P0.3/P0.5 fix). Home stagger measured 49.9/93.7 ms before display wake. |
| F14 | `ScrollToBottom` (`Transcript.tsx:475`) | `bottom` tween while scrolling (P2.10). |
| F15 | Rail / settings / usage / segmented pills, switch thumbs | `top`/`left` tweens (P1.8, P3.19, P4.17). |
| F16 | Effort slider (`ModelPicker.tsx:994,1015`) | `left` tween during drag at 70 ms. |
| F17 | Preview loading bar (`preview/Chrome.tsx:91`) | 5.3 s `width` tween relayouts the window for its whole length. |

Elapsed-time labels (1 Hz) and the caret blink (`steps(2)`) are stepped by design.

## Rejected candidates (Gate question that killed each)

| # | Candidate | Rejected by |
|---|---|---|
| R1 | Palette open/close via ⌘K (`nav/Palette.tsx`) | Frequency/keyboard: 100+/day, shortcut-initiated. Pointer-opened only (P3.15). |
| R2 | Mention / slash / skill completion popup (`composer/Completion.tsx`) | Keyboard: opened by typing `@`, `/`, `$`. |
| R3 | Combobox popup (`kit/Combobox.tsx`) | Keyboard: typing-driven; desktop also none. |
| R4 | Sliding selection highlight between sidebar threads | Frequency: 100+/day and ⌘[ / ⌘] navigation. |
| R5 | Transcript history entrance / message stagger on thread open | Fresh-only rule: initial loads and history pages never animate. |
| R6 | Toast 16 px slide-up (desktop `t-toast` rise) | User preference (GPUIX toasts: cross-fade + clearing blur, X-dismiss, no slide). |
| R7 | Typing effects in the composer or editors | Typing never animates. |
| R8 | Page cross-fade via frame capture (like `ThemeFade`) for navigation | Speed: synchronous capture ~80 ms per switch, tens/day. |
| R9 | Hover scale/lift on dense rows (threads, tasks, PR rows, files) | Function: dense, information-heavy lists; tens/day. Note thumbnails keep the desktop's lift. |
| R10 | Re-growing usage bars on every Agent/Model/Day switch | Function: data the user is reading; first load only. |
| R11 | Diff hunk / code block reveal animations | Function: data being read. |
| R12 | Settings search result filtering motion | Keyboard: typing-driven. |
| R13 | `t-border-beam` (orbiting border streak) | Purpose: decorative loop; unused on the desktop too. |
| R14 | Sidebar thread rows sliding when the list re-sorts by activity | Function + frequency: ambient re-sorts many times a day while reading; motion would pull attention. |
| R15 | Dock pane exit cross-fade (keeping the old pane mounted) | Speed/memory: the GPUIX dock deliberately unmounts hidden panes; entrance only (P3.1). |
| R16 | Stepped ring spinner (desktop `bits.tsx` `steps(24)`) | Performance rule: stepping existed for WebKit cost; GPUIX keeps the smooth native `SpinIcon`. |

## Verdict

GPUIX already ports most of the desktop's motion vocabulary, several pieces natively and better than the web build
(toasts, drag physics, success check, file tree). What makes it feel static is that its port was written before
`paintTransform` existed: entrances, popups and swaps are layout tweens that dropped the desktop's scale and blur, lose
their outgoing half, and never exit; chevrons never turn; panes and tabs switch instantly. P0 fixes the mechanism once
for every caller; P1–P4 then fill ~75 concrete gaps across the shell, conversation, dock and pages. Highest leverage:
P0.5 (popups materialize and exit) together with P0.2 (paint entrances). Two items depend on native work (N2 rings
value→value, N3 web view fades), and the most-seen "choppy" motion (F1–F5 loops) belongs to the frame-rate lane.
