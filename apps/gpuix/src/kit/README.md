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

## Menus (`nav/overlay.tsx`)

`Menu`, `ContextMenu`, `MenuItem`, `MenuLabel`, `MenuSeparator`, `MenuCheckboxItem`/`MenuRadioItem` as before, plus
`<MenuSub id label icon? width=192 testId? disabled? maxHeight?>…items…</MenuSub>`: a row with a trailing chevron that opens a
nested popup (Base UI `SubmenuTrigger`: 100 ms hover open, a safe triangle from the pointer to the popup so a diagonal move
does not close it, → opens and focuses the first item, ← / Esc close one level). The geometry is `nav/menuGeometry.ts`
(unit tests in `menuGeometry.test.ts`). Pointer handling reads geometry on each move; no timers run while nothing hovers.

## Dialogs and sheets (`AlertDialog.tsx`, `Sheet.tsx`)

`AlertDialog` (props `open`/`defaultOpen`/`onOpenChange`, `width` 512, `testId`) with `AlertDialogHeader`, `AlertDialogTitle`,
`AlertDialogDescription`, `AlertDialogFooter` (`variant: 'default' | 'bare'`), `AlertDialogClose` (`variant` outline, `onClick`).
`Sheet` (`side` right/left/top/bottom, `variant`, `showCloseButton`, `dismissible`, `width` 448) with `SheetHeader`, `SheetTitle`,
`SheetDescription`, `SheetPanel`, `SheetFooter`, `SheetClose`. Both fade and move in and out (exits are faster), keep an Escape
stack (the innermost overlay closes first: a `Select` inside a `Sheet`) and return focus to the opener. `ModalLayer`,
`useEscapeLayer`, `usePresence` and `KitButton` (the desktop `Button`: `variant` default/outline/destructive/…, `size`, `icon`) are
exported for other dialogs.

## Form controls

- `Switch` (`checked`/`defaultChecked`/`onCheckedChange`, `disabled`, `aria-label`): 32×20 track, 12 px thumb travel, press stretch.
- `Checkbox` (same plus `indeterminate`, `invalid`): the check strokes itself in (a pre-rendered dash-offset sprite sequence on native
  opacity tweens, exact to the desktop's `.t-check-path`; no JS per frame).
- `Toggle` (`pressed`/`defaultPressed`/`onPressedChange`, `variant` default/outline, `size` xs/sm/default/lg, `icon`, children = label).
- `Segmented` (`options: {value,label,unavailable?}[]`, `value`, `onChange`, `busy`, `textSize` 14, `segmentHeight` 24, `segmentPadX` 8,
  `fill`): radiogroup with the raised thumb that slides between segments; arrow keys skip unavailable options.
- `TimePicker` (`value` "HH:MM", `onChange`, `width` 168): two scrolling columns.
- `Select` (`options: SelectEntry[]` = `{value,label,disabled?} | {group} | {separator:true}`, `value`/`defaultValue`/`onValueChange`,
  `placeholder`, `size` xs/sm/default/lg, `variant`, `surface` settings/composer, `side`, `align`, `sideOffset`, `width`, `label`):
  item-aligned popup like Base UI, type-ahead, check indicator.
- `Combobox` (`items`, `value`/`onValueChange`, `multiple` (chips), `placeholder`, `showTrigger`, `showClear`, `emptyText`,
  `itemToLabel`, `filter`, `width`): filtering input with a popup list and the empty state.

All take `testId` and (except the popups) `style`.

## Feedback

`Badge` (`variant`, `size` sm/default/lg, `icon`, `onClick`), `Skeleton` (`width`, `height`, `radius`, `still`; the light band moves
on one native tween, attached to the window like `background-attachment: fixed`), `Spinner` (`size` 24, `color`, `spinning`),
`Empty` + `EmptyHeader`, `EmptyMedia` (`variant` default/icon, `icon`), `EmptyTitle`, `EmptyDescription`, `EmptyContent`
(the header children rise in together, 12 px, 500 ms; `play={false}` for none).

## Resize (`Resize.tsx`)

`const col = useResize({ initial, min, max, side: 'left' | 'right', storageKey?, axis? })` gives `{ width, dragging, setWidth,
onPointerDown, reset }`; `<ResizeHandle edge label dragging onPointerDown onKeyDown onReset valueNow testId />` is the 16 px hit
area with the 2 px line on hover/focus/drag (arrow keys 16 px, Shift 64 px, double-click resets). `<ResizeCaptureLayer />` is mounted
once in `App.tsx` and follows the pointer during a drag (GPUIX only delivers mouse moves to the element under the pointer).
Used by the Explorer tree (176-520) and the PR list (288-512); the thread sidebar, dock and split dividers keep their own handles
(`shell/ResizeHandle.tsx`, `dock/`, `split/`), all driven by `scripts/kit9-resize-check.ts`.

## Attention pop (`Pop.tsx`)

`<Label paintAnimation={popAnimation()}>`: the desktop's `.t-pop` (scale 0.85 → 1, opacity 0.4 → 1, 250 ms `--ease-bounce`) on a
text or icon leaf, as a native paint animation (`native/patches/pop_gpui.py`, the same per-frame path as the spinner: no React or
layout per frame, frames stop when the curve ends). It plays when the leaf mounts; give it a new `key` to play again.
`usePopOnChange(active)` is true once `active` turned on after first render (virtual rows do not re-pop on scroll-in).
Leaves only: a box with a background does not scale (no subtree scale in the renderer yet).

## Motion helpers outside `kit/`

- `motion/themeFade.tsx`: theme switch cross-fade. `snapshotBeforeThemeChange()` before flipping the theme (done by
  `setAppearance` and the system-appearance poll); `<ThemeFade />` is the last child of the window root.
- `sidebar/motion.tsx` `MarqueeLabel`: a truncated row title pans to show its tail on hover (350 ms delay, 28 px/s).
- `kit/Spin.tsx` `SpinIcon`: the spinning glyph.
