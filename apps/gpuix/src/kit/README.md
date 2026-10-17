# `src/kit/` — shared GPUIX primitives

Primitives other lanes (settings, composer, transcript, dialogs, platform) build on. Each one mirrors a desktop
`apps/desktop/src/components/kit/*` component: geometry, copy, states and motion come from the desktop source and are
checked against it, in images, with `scripts/kit9-pair.ts` (see "Verifying").

## Conventions

- One component per file, named export, documented props in this README (one section per component, below).
- Colours from `useTheme()` (`src/theme.ts`; cite the `kit.css`/component line for a new token). Text is `Label`.
- Every interactive part gets a `testId`. Pointer hover is instant unless the desktop eases it.
- Reduce Motion: every tween has a path (`REDUCED_MOTION` from `ui.tsx`): fades stay, movement goes.
- Popups are `PopupLayer`s (opaque, anchored; `composer/Menu.tsx`); tooltips and hover cards go through
  `kit/hoverController.ts` so only one is visible app-wide.
- Never a JS timer or React commit driving visible movement per frame: use `motion.div` tweens or paint animations.

## Verifying (the gallery)

`visual/kit/` renders a named *section* of the desktop's own kit components (Vite + WebKit, no daemon);
`src/kit/gallery/` renders the same section with GPUIX. States (`visual/kit/steps/*.ts`) say how to drive each side.

```sh
bun scripts/kit9-pair.ts <state ...> --theme both [--reduced]     # -> previews/gpuix/phase2/kit9/kit/kit-<state>-<theme>-{tauri,gpuix,pair,diff}.png
```

Motion: desktop strips with `document.getAnimations()` paused at offsets (see `scripts/kit9-notelift-tauri.mjs`), GPUIX strips with
`clock.pause()` + `clock.set(at + ms)` + `screenshot` (`scripts/kit9-notelift.ts`); `startGallery` in `scripts/kit9-lib.ts`
opens a section window. Frame cadence: `KYBERN_FRAME_TIMES=1` (`app.frameTimes()`), window kept visible with
`opts.visible`. Native paint animations (spinner) run on the real clock: freeze with `KYBERN_PAINT_PHASE_MS`.

## Hover popups (`hoverController.ts`, `hover.tsx`, `HoverCard.tsx`)

`useHover({ delay, closeDelay?, skip?, hoverable? })` returns `{ ctl, state }`; `hoverTrigger(ctl, key, element, pressRef, focusOpens)`
puts the handlers on a trigger; `HoverCard` is the generic `PreviewCard` (props: `trigger`, `children`, `side`, `align`,
`sideOffset` (8), `delay` (600), `closeDelay` (300), `skip`, `width`, `style`, `rootStyle`, `testId`, `disabled`).
`Tip` (`nav/overlay.tsx`) is the tooltip. State lives in plain fields, never read from a render closure, so an enter
and a leave inside one frame still close (R4-1).

## Spin (`Spin.tsx`)

`<SpinIcon source size color spinning periodMs testId />`: a glyph turning once per `periodMs` (1000) on the native
`rotate` paint animation (`native/patches/rotate_gpui.py`); still when hidden, minimized or under Reduce Motion.
