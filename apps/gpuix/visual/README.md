# Visual pair tool

> Retired with the Tauri app (after 0.18.0): `scripts/visual-pair.ts` and the
> `*.tauri.mjs` screens are gone. The GPUIX halves (`screens.gpuix.ts`,
> `screens/*.gpuix.ts`, the fixtures and Swift helpers) remain for GPUIX-only
> captures; the rest of this page describes the pair workflow as it was.

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
  port with a data dir under `ade-gpuix-scratch/visual-pair-<hash of the checkout>/data` (`GPUIX_VISUAL_SLOT` overrides the hash; `--down` stops only that checkout's daemon and Vite) (never
  `~/.kybern`, never port 4219) and seeds it over RPC only: two projects, nine
  notes (pinned, headings, lists, code, an image asset, task links) and 25 tasks.
  Running and needs-review tasks need a live agent run, so they are not seeded.
- The reference is the desktop web build under `pnpm exec vite` (a free port per run),
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

## Real Tauri window and per-screen entries

- `--tauri-window` (needs a seeded scratch daemon, i.e. one run without it first): runs `pnpm tauri dev` from this checkout with `CARGO_TARGET_DIR=<checkout>/target`, the scratch data dir and `KYBERN_NO_ACTIVATE=1`, finds the dev process's window by pid (`window-id.swift`; the installed app has the same process name) and captures it with `screencapture -l`. GPUIX launches at the window's size (`KYBERN_WINDOW_SIZE`, default 1440x900). Only screens reachable without driving the window work (accessibility is not granted); the window follows the system appearance. It holds the real material, title bar, traffic lights and Tauri-only rows. The window may carry its own stored sidebar width: pass `KYBERN_SIDEBAR_WIDTH=208` to match. `--down` stops it; delete `target/` afterwards.
- `real-gpuix.sh <out.png> [theme]` captures a real (non-automation) GPUIX window the same way.
- A screen can launch another entry: export `entries: Record<screen, { entry, env? }>` from `screens/<area>.gpuix.ts`.
- GPUIX runs with `KYBERN_CLIENT_CONFIG_DIR`/`KYBERN_GPUIX_CREDENTIALS_DIR` under the scratch dir, reset per screen.
- Light theme: with `KYBERN_OPAQUE=1` the root puts the 88% frame on white (GPUI clears an opaque window dark), which removed the ~13% light-theme offset.

## Shell screens, fixtures and dialog backdrop

- `screens/shell.*`: `shell-home`, `shell-sidebar-*`, `thread-header`, `env-panel`, `split-empty`, `split-two`, `split-drop` (drag a sidebar row over the pane), `banner-reconnecting`, `banner-failed`, `toasts` and `close-guard`.
- Chrome that automation cannot cause is raised by the app itself under `KYBERN_PREVIEW=<banner-reconnecting|banner-failed|toasts>` (`src/shell/preview.ts`) and `KYBERN_PREVIEW_CLOSE_GUARD=1` (`CloseGuard.tsx`); both are `entries` of `shell.gpuix.ts`. The reference fakes the matching state: store `connection`, sonner's toast (found through Vite's prebundled dependency URL) and, for the close guard, a mocked `__TAURI_INTERNALS__` (endpoint, environment registry and the `tauri://close-requested` listener) before a reload.
- GPUIX runs with `KYBERN_ENVIRONMENT_NAME='Development environment'` so the environment label matches the web reference's profile name.
- `VISUAL_OUT=<dir> bun scripts/visual-crop.ts ...` crops from another output dir. `scripts/backdrop-lab-run.ts <out.png> light` renders a scrim over a white page (`BACKDROP_MODE=dialog|new|old|raw|rawBg`, `BACKDROP_DIM`) for pixel sampling.
- `--fresh` now stops the previous run's Vite (its process group and whatever still listens on its port).
- `measure.mjs` reads this checkout's state file, but the Settings fixture's proxy port dies with the pair run, so measure right after `--keep` runs only works for screens that don't need the proxy.
- Light dialogs: GPUI paints an opaque dark backing under every `<anchored>` layer and composites an opacity tween over it ~2x too dark on light pages (0.6 over white gave 61, the web gives 121). A scrim now fills the anchored surface itself (`PopupLayer backing=rgba(0,0,0,dim)`), which gives 121 exactly. Under Reduce Motion only; with motion the headless tween of a layer opacity stalls part-way (also before this change), so a native fix to the anchored layer's opacity composition is still wanted.
- The desktop's real type scale (base 14): ui 14, ui-lg 15, ui-sm 13, ui-xs/meta 12, ui-timestamp 10. The `var(--app-font-size-ui…, 12px)` fallbacks in the CSS are not what renders.

## State-delta checks

The default full-screen score is unchanged. `--threshold 6` lowers its RGB
threshold from 24; it still cannot certify that a state exists. Use:

```sh
bun scripts/visual-pair.ts settings-hover settings-focus pulls-hover --state-delta --theme both --fresh
bun scripts/visual-pair.ts --rescore --theme both --out /path/to/existing/pairs
bun scripts/visual-delta-check.ts
```

`--state-delta` also captures each requested state’s base. Bases are declared in
`state-bases.ts`, with optional per-area `bases: Record<string, string>` exports
from `screens/<area>.gpuix.ts`. A base must use the same fixture and layout,
immediately before the interaction. New states need explicit base declarations;
name guessing cannot distinguish an unrelated page from the correct base.
`--rescore` uses existing captures without launching servers/apps. Missing inputs
are `MISSING`, never passes. Uniform blank UI captures and dimension mismatches
are `INVALID_CAPTURE`. Use captures from one revision and one fixture run;
rescore cannot make historical screenshots current.

For each pixel/channel, let T = Tauri(state) − Tauri(base) and G = GPUIX(state) −
GPUIX(base). The score is `100 × (1 − Σ|T−G| / Σ(|T|+|G|))`.
Unchanged pixels do not inflate it. Matching signed changes score 100; missing,
wrong-sign and disjoint changes score zero. Half-strength changes score 66.7.
Every RGB step counts, including changes below the legacy threshold.

The same calculation runs in 128×128 physical-pixel tiles. A provisional PASS
requires global score ≥85 and every active tile ≥70. Tiles with fewer than 16
changed pixels or less than 96 total RGB energy are reported in the global score
but excluded from the regional verdict to limit isolated caret/raster noise.
A reference with less than 96 RGB energy is INCONCLUSIVE, even if both captures
look identical. These are strict diagnostic gates, not perceptual-equivalence
claims: moving text, timestamps, asynchronous loads and layout offsets can fail
and require inspection. Dimensions must match exactly; the delta metric refuses
resizing because interpolation would invent changes.

Outputs: `<screen>-<theme>-delta.png` (red missing, blue unexpected, orange wrong
magnitude/color, green exact), matching `-delta.json` (tile rectangles, energy,
missing/unexpected counts), and `state-deltas.json` (all results). Console output
is a Markdown table. Pair and ordinary diff images retain their original names.
The regional score keeps a large correct menu from concealing a missing small
focus or hover change elsewhere.

Focus callbacks require an active native window on macOS. Use `--foreground`
for focus-state captures; this explicitly activates each GPUIX window. The
default remains background. A zero background focus score is not proof that
foreground focus styling is absent. `scripts/visual-focus-check.ts --foreground`
(with `KYBERN_DATA_DIR` and `KYBERN_VERIFY_OUTPUT` set to scratch paths) checks
click, renderer focus, Tab navigation and blur using the actual border pixels.
