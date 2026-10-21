# GPUIX animation inventory (motion/fps, 2026-10-20)

Paths are relative to `apps/gpuix/src`. **Tier 0** is Core Animation (compositor loops). **Tier 1** is
paint-only: `paintTransform`, `paintTranslate`, `paintAnimation`, with no React render or window
layout per frame. **Tier 2** is the native `motion` tween: no React per frame, but the window
re-renders every frame. **Tier 3** is JS per frame or timer-driven React state. "Now" gives the tier
after this lane; measured rates are in `../motion-fps-2026-10-20.md`.

## Loops

| Animation | Where | Before | Now |
| --- | --- | --- | --- |
| MatrixLoader dot pulse (orbit / pulse / scan / twinkle) | `MatrixLoader.tsx`. Used by: sidebar/rows:189, Transcript:328, transcript/rows:209,558, Turn:70,318, Composer:761,956, ModelPicker:611, subagents/Launch, Page:74, dock/Agents, nav/Sessions, Palette, Handoff, environment/Panel:69, dialogs/Account | tier 3, 200 ms `setInterval` (5 fps) | tier 0 when settled; tier 1 `paintAnimation matrix` while moving, clipped or covered |
| Running task glyph (pie breathe, 3.2 s) | `tasks/Glyphs.tsx` | tier 3 `useLoaderStep` | tier 0 / tier 1 `breathe` |
| Connection spinner (arc over ring, 1.3 s) | `shell/Connection.tsx` | tier 3, 8 pre-rotated SVGs | tier 0 / tier 1 `rotate` |
| kit Spinner / SpinIcon (1 s) | `kit/Spin.tsx`, `kit/Spinner.tsx`. Used by Composer:855, environments/kit:74, UpdateSurface:82, PrDetail:108,117, Sidebar:303 | tier 1 `rotate` | tier 0 / tier 1 |
| Live-label shimmer ("Thinking", "Loading changes…", live captions) | `transcript/motion.tsx`. Used by rows:217,565, Turn:149,404, live/ComputerLiveView:102 | tier 3, 8-step table at 5 Hz | tier 0 / tier 1 `shimmer` |
| Visual-reply loading wash (1.6 s breathe) | `transcript/Visual.tsx` | tier 3 `useLoaderTime` | tier 1 `paintTransform` opacity, retargeted each half cycle |
| Skeleton band sweep (2 s) | `kit/Skeleton.tsx`, settings/Integrations | tier 1 `paintTransform` translateX | unchanged |
| Caret blink (500 ms) / terminal cursor (600 ms) | `transcript/motion.tsx`, `terminal/Terminal.tsx` | tier 3, stepped by design | unchanged |
| Streaming text pacing (≤15 Hz commits) + per-word fade (350 ms) | `transcript/motion.tsx`, `store.ts` PACE_MS, native `stream_fade_md.rs` | JS pacing + paint-only fade | unchanged |
| Elapsed labels (1 Hz) | `MatrixLoader.tsx` `useLoaderSecond` | information, not motion | unchanged |

## One-shots and transitions

| Animation | Where | Mechanism | Notes |
| --- | --- | --- | --- |
| Press feedback (0.97, 80/150 ms) | `motion/press.ts` and every compact control | tier 1 `paintTransform.press` | — |
| Pops (badges, counts, chips; 250 ms) | `kit/Pop.tsx`, sidebar/rows, dock/Dock, composer/motion | tier 1 `pop` / `popTransform` | — |
| Success check, checkbox stroke | `motion/SuccessCheck.tsx`, `motion/success.ts`, `kit/Checkbox.tsx` | tier 1 transform + `stroke` | Checkbox box grow is tier 2 |
| Toasts (enter / exit / restack) | `shell/toasts.tsx` | tier 1 `useFade`; glide is tier 2 | — |
| Drop ring | `motion/DropHighlight.tsx` | tier 1 | — |
| Popup materialize (status glyph popover) | `composer/Menu.tsx` | tier 1 | — |
| Menus, tooltips, HoverCard, overlay dialogs, PR popovers | `composer/Menu.tsx` `PopupLayer` | tier 2 `<anchored motion>` (opacity + 2–4 px drift) | 60 fps measured. Paint-only conversion dropped: first step lands a frame later |
| AlertDialog / Sheet | `kit/AlertDialog.tsx`, `kit/Sheet.tsx` | tier 2 anchored | — |
| Rise / Popup / Swap / SwapOnChange | `motion/kit.tsx`, plus ~25 call sites | tier 2 opacity + top/left | conversion dropped (same reason) |
| Collapse / sidebar DisclosureGroup / Leave | `motion/kit.tsx`, `sidebar/motion.tsx` | tier 2 height + opacity | layout by nature |
| Sidebar width slide, dock slide, environment inset | `App.tsx`, `dock/Dock.tsx`, `split/Workspace.tsx` | tier 2 width | measured at 60 fps |
| Sliding pills (kit Segmented, SlidingPill, dock tabs, settings, usage, NavRail, ModelPicker thumb) | various | tier 2 left (+ width) | position-only ones could move to tier 1 |
| Switch / Toggle fill | `kit/Switch.tsx`, `kit/Toggle.tsx`, `dock/parts.tsx` | tier 2 | — |
| Theme cross-fade (280 ms) | `motion/themeFade.tsx` | tier 2 opacity of a screenshot | — |
| Sidebar Reveal / FadeBack / TitleSwap / MarqueeLabel | `sidebar/motion.tsx` | tier 2 | Marquee is a long linear `left` pan |
| Drag ghosts, reorder shifts, drop slot | `drag/*`, `sidebar/reorder.tsx`, `dock/reorder.tsx`, `tasks/*` | tier 1 `paintTranslate`, tier 2 opacity | edge auto-scroll uses `onFrame` (legitimate) |
| MotionFileTree hover / row / branch / chevron | `dock/MotionFileTree.tsx` | tier 2 | — |
| Transcript rail ticks / card, jump-to-bottom, lightbox, loading fade | `transcript/rail.tsx`, `Transcript.tsx`, `transcript/images.tsx` | tier 2 | — |
| Subagent page slide | `subagents/Page.tsx` | tier 2 translateX + opacity | — |
| Tasks SelectionBar | `tasks/SelectionBar.tsx` | tier 2 | its unmount timer (150 ms) is shorter than the 200 ms exit |
| Notes cards, outline pill, NoteThumb lift | `notes/*` | tier 2 | — |
| Usage bars, Accounts row flash | `usage/UsagePage.tsx`, `settings/Accounts.tsx` | tier 2 | — |
| Requests panels, environment panel, update surface, connection banner, preview chrome / mini chrome, live view | various | tier 2 | the preview loading bar is a 5.3 s width tween |
