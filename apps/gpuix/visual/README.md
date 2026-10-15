# Visual pair tool

Renders the same screen in the Tauri desktop UI and in GPUIX, at the same
logical window size, and writes a side-by-side image and a difference heatmap.

```sh
cd apps/gpuix
bun scripts/visual-pair.ts notes-gallery tasks-list --theme both --keep
bun scripts/visual-crop.ts notes-gallery dark 52 90 620 300   # stacked zoom, Tauri over GPUIX
node visual/measure.mjs notes-gallery dark '.note-card-title'   # Tauri rect + computed type
bun scripts/visual-pair.ts --down                               # stop the scratch daemon and Vite
```

- Screens are the keys of `visual/screens.gpuix.ts` and `visual/screens.tauri.mjs`
  (`notes-gallery`, `notes-list`, `notes-hover`, `notes-search-empty`,
  `notes-editor`, `notes-editor-scrolled`, `notes-editor-image`,
  `notes-quick-capture`, `tasks-list`, `tasks-board`, `tasks-detail`,
  `tasks-quick-add`, `tasks-select`). With no names, every screen runs.
- `--theme dark|light|both`, `--out <dir>` (default
  `/Users/mymac/projects/ade/previews/gpuix/visual`), `--fresh` re-seeds, `--keep`
  leaves the daemon and Vite server running for the next run.
- Output: `<screen>-<theme>-{tauri,gpuix,pair,diff}.png`. Pair is Tauri left,
  GPUIX right; diff paints pixels that differ by more than 24/255 in red.

## How it works

- `fixture.ts` starts `/Applications/kybern.app/Contents/MacOS/kybernd` on a free
  port with a data dir under `ade-gpuix-scratch/visual-pair/data` (never
  `~/.kybern`, never port 4219) and seeds it over RPC only: two projects, nine
  notes (pinned, headings, lists, code, an image asset, task links) and 25 tasks.
  Running and needs-review tasks need a live agent run, so they are not seeded.
- The reference is the desktop web build under `pnpm exec vite` (port 14321),
  opened in Playwright WebKit (the engine Tauri's WKWebView uses) at 1280×820 and
  2×. The Playwright package is imported from `PLAYWRIGHT_CORE`
  (default `/Users/mymac/projects/component-kit/node_modules/playwright-core`);
  nothing is added to this repo. Classic scrollbars are hidden to match macOS
  overlay scrollbars. Each screen gets a fresh browser context (display choices
  persist in `localStorage`).
- GPUIX runs with `GPUIX_BACKGROUND=1 KYBERN_OPAQUE=1 KYBERN_REDUCED_MOTION=1`, a
  fresh app per screen and `gpuix-ui.json` removed first, so persisted UI state
  never leaks between screens.
- `compose.swift` builds the pair and the heatmap, `crop.swift` the stacked zoom.

## Known engine differences

- Tauri-only rows (`isTauri()`: back/forward in the title bar, window material)
  have no web equivalent, so the reference omits them; GPUIX draws back/forward.
- The window is opaque in both captures: headless WebKit has no vibrancy, so
  `KYBERN_OPAQUE=1` keeps the frame colours comparable.
- Glyph anti-aliasing and subpixel advance widths differ (CoreText in WebKit vs
  GPUI's text system), so text edges never diff to zero and long lines can wrap
  one word apart.
- Tracking (`letter-spacing`) is not available in GPUIX styles.
- Always run with `--fresh` after a `--keep` run: a reused daemon is seeded twice.
- Light theme: every pair shows ~13% differing pixels, almost all in the
  window frame. The 88% translucent frame (`--app-frame-surface`) composites over
  the opaque window's clear colour in GPUIX (frame ≈ 216/255 at light) but over
  white in the WebKit reference (≈ 239/255). The real app uses vibrancy, so this
  is a capture artifact of `KYBERN_OPAQUE=1` in the shell (`main.tsx`), not a
  Notes or Tasks difference. Dialog screens hide it under the backdrop.
- Native markdown: no inline-code size metric (inline `code` is body size, Tauri
  0.833em), no list indent or marker-gutter metrics (bullets and numbers sit ~3px
  further left than ProseMirror), no `text-wrap: balance`, no wrapped code lines
  in fenced blocks, no mask fade on truncated list summaries (GPUIX ends in "…").
- Inline task references in a note stay a link plus a chip row below the
  paragraph; the desktop draws the glyph and key inline.
- The editor outline always marks the first heading; the native virtual list
  reports no scroll position (`onScroll` and `onVisibleRange` stay silent when
  every row is already mounted).
- Placeholder colour of native inputs is fixed (brighter than `--n-fg4`).
- New-task and new-note scope defaults come from the Home draft's project; the
  reference shows docs-site, GPUIX shows Global because its draft is empty.
- Keyboard-focused selected rows carry no inset focus ring in GPUIX.

`verify-daemon.ts up|down` starts a second scratch daemon with the
`scratch-project` the Notes and Tasks verify scripts expect.
