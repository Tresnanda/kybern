# Native package 4: rounded input backgrounds and Tauri token styles

Worktree `/Users/mymac/projects/ade-gpuix-native`, branch `gpuix/native`.
Fast-forwarded `feat/gpuix-mvp` from 435b93db to **6c5541a2**. No commits, branch
switches, stash, rebase, push or app source edits outside `src/native/`.

## Native API and implementation

`InputDecoration.style` now accepts `borderRadius?: number` and
`backgroundOutsetX?: number`, both finite nonnegative logical pixels. `paddingX`
remains zero-only and rejects nonzero values. No dependency changes.

An input-local painter consumes the existing shaped line advances, logical-line
starts and wrap boundaries. Backgrounds are excluded from shared TextRun metadata;
the painter resolves overlapping background styles with last-explicit-property
precedence and preserves each owning decoration's identity. Adjacent same-color
atoms remain separate. A font-only overlay does not split a background. Selection
paints after backgrounds, then glyphs and the caret. No Zed submodule edits.

Each visual fragment rounds only the external ends of its span. Radius clamps to
half the fragment width/line height. Outset clamps to half the adjacent undecorated
whitespace and the input edges. Each neighbour gets at most half a whitespace gap,
so pills do not overlap. Adjacent non-whitespace text/chips allow zero outset.
Newlines/wrap edges do not supply extra space. Radius/outset do not change advances,
wrapping, caret, selection, mouse hit-testing, text storage, undo or IME geometry.
Outset is visual-only, never layout padding. Existing real-IME limitations remain.

## Tauri reference audit and integration

Searched `inline-token|chip|atom|mention` throughout desktop styles, Notes, Tasks
and components; followed Composer's `ComposerEditor` and Notes' `TaskRefView`.
The actual Composer styles live in **styles/kybern.css**, not kit.css. There is no
composer chip background mix in the checked-in reference. The requested prior
GPUIX background was therefore removed rather than used as a parity target.

| Decoration/surface | Exact Tauri style | Integration and remaining limits |
| --- | --- | --- |
| Composer references (`kybern.css:214`, `ComposerEditor.tsx:151`) | `--color-accent-blue` (fallback foreground), weight 500, radius .25em; no background or padding; icon gap .25em, icon .95em | `referenceDecorations` now weight 500, no fill; patch passes `t.accentBlue`. Radius has no visible effect without fill. Source token remains visible; replacement labels/icons are unsupported. |
| Batch task composer (`tasks.css:1795`) | Same colors/fill; inline-block, max-width min(16rem,100%), ellipsis; icon right margin .25em | Same reference decoration. Truncation/icon layout cannot be reproduced by styled source runs. |
| Notes and task-description bold (`notes.css:1180`) | weight 600, `--n-fg` = foreground | Changed from 700 to 600 and foreground. Source delimiters stay visible/muted. |
| Notes/task-description italic (`notes.css:1184`) | font-style italic | Native italic; delimiters remain visible. |
| Notes/task-description inline code (`notes.css:1251`) | radius 5px, `--n-fill` = foreground 4% light / 5% dark over transparent; foreground text; .13em vertical/.33em horizontal padding; code font, .833em font-size | Uses exact fill mix, foreground and radius 5. Zero outset. Per-run font family/size and layout padding are unsupported; this is explicitly partial visual parity. |
| Notes/task-description ordinary links (`notes.css:1234`) | link foreground, underline with 35% link-color, from-font thickness, .18em offset; full-color underline on hover | Link foreground and native underline. Native API lacks separate underline opacity/offset/thickness and hover state. URLs/delimiters remain source text. |
| Notes/task-description task atoms (`notes.css:1474`, `TaskRefView.tsx`) | At rest: no fill, foreground 60%, radius 5, size note-size ×13/15, inline margin .1em; hit target padding 2px 3px with -2px -3px margin, icon gap .36em | No resting fill or extra weight; foreground 60%; atomic range retained. Native full Markdown link remains visible, without status glyph/key replacement, size/margins or live status. |
| Task atom hover/selection (`notes.css:1494`) | Hover foreground 3.5% background + foreground 86% text; selected fill 7% light/7.5% dark; radius 5 | Not simulated as a permanent chip fill. Native selection wash remains native; hover/status UI requires a richer editor/node view. |
| Note thumbnail code (`notes.css:410`) | .33em radius, .07em/.33em padding, same n-fill, code font .87em | Static thumbnail, not an input decoration; unchanged. |
| Note thumbnail task refs (`notes.css:486`) | No fill, foreground 60%, .87em size, .3em gap/.1em margin; missing foreground 42% + strike | Static thumbnail, unchanged. |

Task descriptions use the same Notes `NoteBody` editor (`views/tasks/TaskDetail.tsx:381`).
Other toolbar/menu/filter/status chips found by the broad search are controls,
not inline source decorations, and do not supply styles for these adapters.

`noteInputMarkColors(t)` resolves the Notes mixes from theme foreground and variant.
Only inline code opts into the new background painter in integration. No app uses
nonzero outset in this patch. The dark/light lab shows the composer reference next
to expected text and lists the actual Tauri values; stronger blue backgrounds are
explicitly labelled capability stress colors, not claimed Tauri colors.

**Exact unapplied integration:** `native/app-integration-4.patch`, against 6c5541a2.
Composer already uses DecoratedTextarea on that commit; this patch changes its
accent source. Notes' compact/block editors and TaskDetail's description gain the
existing source-mode adapter plus the new theme mapping. It preserves serialization,
refs, events, persistence and storage. Patch clean-apply and an in-memory TypeScript
compiler host check both pass. Runtime app integration remains the parent's step.

```sh
git apply --check apps/gpuix/native/app-integration-4.patch
git apply apps/gpuix/native/app-integration-4.patch
```

The previous package-3 integration patch is historical and should not be applied
on top of this one. Source-mode formatting is not a replacement for Tauri's rich
node editor; no hidden syntax, replacement labels or inline React nodes were added.

## Verification

- `native/update.sh`: incremental native release build, LINKEDIT repair, ad-hoc
  signing and load check passed. All six core capability scripts, original
  dark/light capabilities, decorations/atomic editing/cached scrolling,
  layout/syntax/lifecycle/70,003-line checks, scratch combined pointer check and
  two spring tests passed. New rounded check was added to update.sh after this
  build and run separately against that exact binary.
- `native/rounded-check.ts`: dark and light actual-pixel comparisons passed for
  radius versus rectangular paint, independent adjacent same-color atom corners,
  zero versus huge outset at neighbours and input edges, whitespace expansion,
  external rounded/continuation square wrapped ends, selection changing an interior
  pill pixel, atomic left/right movement, invalid radius and nonzero padding rejection.
- `pnpm typecheck`, `pnpm exec tsc -p native/tsconfig.json`: passed.
- `bun test ./src`: **37 passed, 392 assertions**, zero failures.
- Notification subprocess capability probe passed; no notification or permission
  request was posted. Temporary probe bundle cleaned by the check.
- Unapplied integration patch: clean apply and in-memory TypeScript checking passed.
- `git diff --check`: passed.

Reviewed preview artifacts in the original conversation workspace:
`/Users/mymac/projects/ade/previews/gpuix/p1d/rounded-dark.png`, `rounded-light.png`,
`selection-dark.png`, `selection-light.png`.
The lab explicitly shows source Markdown and the existing raw token labels.
No user's running app, normal data directory or port 4219 was touched. All full-app
checks/samples use the installed daemon with fresh `gpuix-scratch` data and port 0.
Physical AppKit drag, external AX and real IME checks remain manual, as previously.

## Full-app performance

Apple M1, macOS 27.0, Bun 1.4.0, GPUIX 0.10.0, 1280×820 background full-app
window. Two independent launches per condition, each **10 s warmup + 15 s sample**,
using `src/shell/verify.fixture.ts` and `scripts/native-perf.ts`. Empty settled
scratch thread/composer, no agent turn. One fixture window at a time.

| Sample | Process CPU | Physical footprint | Process Metal time / 15 s |
| --- | ---: | ---: | ---: |
| Before 1 | 2.80% | 173 MiB | 1.7 ms |
| Before 2 | 2.20% | 159 MiB | 0.7 ms |
| After 1 | 1.93% | 172 MiB | 3.0 ms |
| After 2 | 1.93% | 156 MiB | 0.6 ms |

Mean CPU **2.50% → 1.93%**, footprint **166 → 164 MiB**. No meaningful regression
observed in this workload. Mean Metal time **1.2 → 1.8 ms / 15 s** increased by
0.6 ms, too small/noisy to attribute. These are idle full-app samples, not sustained
typing, streaming, latency, frame-time or energy measurements. The integration
patch is unapplied in both conditions. No continuous timer was introduced.

## Binary and cleanup

`/Users/mymac/projects/ade-gpuix-native/apps/gpuix/native/build/gpuix-native.darwin-arm64.node`

SHA-256 `7513726fc0fbfeda98b377cd8f2ea9e2f82bd2d9ed759cd2402726355392e178`.

Disk free **70 GiB before / 69 GiB after** (always above 30 GiB). Reused existing
native build/target **1.9 GiB**, upstream **185 MiB**, dependencies **303 MiB**;
retained for integration and incremental rebuilds. No extra build directory or
Rust daemon build. Scratch daemons/data clean themselves; unrelated scratch daemons
were left alone. Redundant task screenshots and temporary compiler script removed
after preserving the four preview images and small build/test/perf evidence logs.
No commit.
