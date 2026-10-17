# Porting the desktop to GPUIX

The goal is 1:1 parity with `apps/desktop` in features and UI/UX, at a
fraction of its RAM, CPU and GPU. Every change is judged on both: it must look
and behave like the desktop, and it must not make idle or animation cost worse
(`perf/README.md`).

## Source of truth

- Behaviour and copy: the matching file in `apps/desktop/src/views/`. Read it
  before porting; reuse its strings, order, and states.
- Geometry and colour: `apps/desktop/src/styles/kit.css`, the class constants in
  `components/kit/chat/composerPickerStyles.ts`, `lib/kit/sidebarRowStyles.ts`.
  Colours come from `src/theme.ts` (the desktop's own theme code); add a token
  there instead of hard-coding a hex, and cite the CSS line it mirrors.
- Logic: import pure desktop or `packages/kybern-client` modules directly when
  they have no DOM dependency (`toolLine`, `groupTurns`, `models.ts`, …). Bun
  resolves `@/` to `apps/desktop/src`. Never fork such logic.
- Icons: `src/icons.tsx` (the same Hugeicons glyphs and stroke widths as
  `lib/kit/icons.tsx`). Add glyphs there.

## GPUIX 0.10.0 rules (the README is ahead of the npm release)

- Check `node_modules/@gpuix/react/dist/**/*.d.ts` and
  `node_modules/@gpuix/native/index.d.ts` before using a documented API.
  Missing in 0.10.0: `registerFont`, `scrollbarColor`, `keyboardFocusDim`,
  `borderStyle`.
- `div` is not flex until `display: 'flex'`. Shrinking children need `minWidth: 0`.
- Every `<text>` needs `color`. Do not mix strings and expressions in one
  `<text>` (`Show {n} more` lays out as separate items): use a template string.
- In the patched native renderer, `overflow: 'hidden'` clips descendant paint
  and hit testing to the element's corner radii. Nested masks intersect and cached
  views retain their clipping. The stock npm addon still clips rectangularly.
- `<virtual-list>` ignores `padding` and its rows' outer margins: put spacing on
  each row as padding. Rows are its direct children with stable keys.
- No nested vertical scrollers. Long lists use `<virtual-list>`.
- Menus, popovers and tooltips must be `<anchored>`, `SelectContent` or
  `ComboboxContent` with an opaque fill, or they paint under the transcript.
- The `<textarea>` placeholder colour is fixed; `Composer.tsx` draws its own.
- An `<input>` consumes Enter as its own submit action: handle Enter with `onSubmit`,
  never `onKeyDown` (arrows and Escape do reach `onKeyDown`), unless you use the
  native key interception hook described in `native/README.md`.
- The patched `motion.div` adds native springs and layout-neutral translateX/translateY
  to width/height/top/left/opacity/borderRadius. Paint-only subtree scale/rotate/opacity/blur is `paintTransform`
  (`native/README.md`, "Paint-only subtree transforms"; `src/motion/press.ts`, `kit/Pop.tsx` `popTransform`).
  See `native/README.md` for key interception, secure inputs, close hooks, and code wrap.
  SVGs also support native `rotate` in degrees (`motion.svg`) and physical springs
  with `{ type: 'spring', stiffness, damping, mass }`. Div-subtree rotation via `paintTransform` is exact for glyphs, SVGs and paths only.

## App shell (`src/shell/`)

- `persist.ts`: `load(key, fallback)` / `save(key, value)`, a per-environment
  JSON file (`gpuix-ui.json` in the data dir), debounced and atomic; keys mirror
  the desktop's `localStorage` names (`kybern.sidebar.width`, `kybern.dock.width`).
- `layout.ts`: the panel width (208-480, saved, shrinks before the dock on a
  narrow window). `toasts.tsx`: `toast()` / `toast.error()` / `toast.dismiss()` and
  `<Toaster />`; `agentToasts.ts` raises the agent event toasts. `Connection.tsx`:
  banner and Welcome. `ErrorBoundary.tsx`: per-surface fallback with Reload.
  `window.ts`: frame save/restore, window width, OS appearance (one 300 ms poll).
- Hit testing: GPUIX tests a child before its parent, so a plain child over a
  handler swallows the press. Give decorative children `pointerEvents: 'none'`.
- An `<anchored>` layer paints an opaque backing under its content: size it to
  its opaque card (one layer per toast) and never use it for a transparent layer.
- Never call `[NSApplication sharedApplication]` before GPUI starts (it crashes
  on GPUI's own subclass); use `nsApp()` from `native/objc.ts`.

## Performance rules

GPUI rebuilds and lays out every built element in the window whenever anything
changes. So:

- Idle must be idle: no timers unless something visibly animates.
- Loop animations step on the shared clock in `MatrixLoader.tsx`; never add a
  separate `setInterval` for motion.
- Hidden panels unmount (see the sidebar's `panelMounted`), long lists are
  virtual, and big text goes in one native node (`<markdown>`, `<code>`,
  `<diff>`) rather than many `<text>` elements.
- Subscribe narrowly with `useApp(selector)`; memo rows.

## Cached islands (patched GPUIX)

The app runs on our patched `@gpuix/native` (`native/README.md`). Mark parts of
the window that stay put while something else animates as islands:
`<div {...ISLAND} style={{ width, height }}>` (`ISLAND` from `MatrixLoader.tsx`).
They need a definite width and height, no margins/insets of their own, and no
selectable text. Good candidates: sidebar rows (100% × 28), the title bar, the
rail, loaders, chips. An island that changes re-renders alone; the rest of the
window replays its last frame.

## Motion and feel

Follow the `/animate` rules: nothing animates on keyboard shortcuts or 100+/day
actions; entering/moving uses `EASE_OUT` (`ui.tsx`) at 150–250 ms; every motion
has a Reduce Motion path (`REDUCED_MOTION`). Hover/press states are instant.

## Verifying

```sh
pnpm typecheck
bun scripts/screenshot.ts <out.png> [--light]          # GPUIX_BACKGROUND, never steals focus
KYBERN_GPUIX_THREAD=<id|title> bun scripts/screenshot.ts …
bun perf/sample.ts 20 GPUIX=<pid>                      # CPU/GPU/RAM of a running instance
```

`@gpuix/react/automation` (`launch`, `getByTestId`, `click`, `fill`, `press`,
`clock.pause`, `captureFrames`) drives the real window; see
`scripts/interact.ts`. Give new controls a `testId`.

Screenshots for review go in the conversation folder,
`/Users/mymac/projects/ade/previews/gpuix/<topic>/`, never in the repo.

## Daemon safety

The default daemon is the user's real one (`~/.kybern`). Against it, only
read: never send, approve, archive, rename, pin, or create anything. For any
write, use the scratch daemon: `KYBERN_DATA_DIR=<scratch data dir>` (the brief
gives the path; it has one project, `scratch-project`). New threads there use
`claude-code` with model `claude-haiku-5-5`, short prompts, at most a few turns.
Drive it with the CLI too:
`/Applications/kybern.app/Contents/MacOS/kybern --data-dir <dir> threads|send|new|approvals …`.
