# Native package 5: Markdown layout and theme controls

Worktree `/Users/mymac/projects/ade-gpuix-native`, branch `gpuix/native`.
Fast-forwarded `feat/gpuix-mvp` from `9a731d56` to `e0fbd6f7`. No app sources
outside `src/native/` were edited. No commit, push, rebase, reset or stash.

## API and implementation

`src/native/markdown.ts` exports `MarkdownStyle`, `MarkdownTheme`,
`withMarkdownStyle(theme, style)`, `transcriptMarkdownStyle(...)`, and
`notesMarkdownStyle(...)`. The existing `theme` prop carries a new optional
`markdown` object; no new RPC, renderer method, npm dependency or bridge is needed.

- Tables: `tableGrid`, `tableBorder`, `tableBorderWidth`, `tableHeaderRuleWidth`,
  `tableHeaderWeight`, `tableHeaderBackground`, `tablePaddingX/Y`. Shared cell edges
  are painted once. GFM left/center/right alignment also applies to code boxes.
- Quotes: `quoteBorderWidth`, `quoteBorder`, `quoteBackground`, `quoteText`,
  `quotePaddingLeft/Right/Y`, `quoteGap`. Quote text modifies explicit text runs,
  rather than setting an inherited color the runs would ignore.
- Inline code: `inlineCodePaddingX/Y`, `inlineCodeSizeRatio`, plus existing
  `codeText`, `codeWash`, `metrics.mdInlineCodeRadius`. Horizontal padding reserves
  width; no fake spaces enter source or clipboard. Vertical padding paints around
  the glyph band, without inflating every line by the padding itself.
- Lists: `listIndent`, `listMarkerGap`, `listMarkerSize`, `listMarker`,
  `listItemGap`, `listChildGap`, `nestedListMarkers` (disc/circle/square).
- Typography: `strongWeight`, `headingSizes`, `headingLineHeights`, `headingWeights`,
  `headingMarginTop/Bottom`, `headingMarginTops`, `headingFollowingGap`.
  Heading arrays address all six levels, rather than the old shared h4–h6 tier.
- Fences: `codeWrap`, `codeHeader`, `codeBackground`, `codeBorder`, `codeBorderWidth`,
  `codeHeaderBackground`, `codeHeaderBorderWidth`, `codeHeaderLineHeight`.
  Existing code metrics supply font size, line height, radius and padding.
  Unwrapped mode horizontally scrolls/clips; wrapped mode retains syntax runs and
  selectable original text. The app's existing `<code softWrap={wrap}>` continues
  to serve its external Wrap toggle.

Numbers are logical pixels except size ratios, weights and heading margin
multipliers. Invalid/nonfinite/negative numbers use the established fallback;
invalid colors retain their fallback. Omitted layout numbers use upstream
fallbacks; unstyled prose keeps the original single shaped-text path.

Patch seams: `markdown_hooks.py` is called by the atomic `apply_hooks.py` staging
pass. `markdown_style.rs` owns theme deserialization; `markdown_inline.rs` owns
mixed-size flow. No Zed submodule patches. All source reconstruction remains in
`native/update.sh` and the same incremental target directory.

The initial eager implementation allocated one flex node per word and failed the
memory comparison (326/328 MiB versus 242/242 MiB). It was replaced with measured
inline flow: retain source ranges and advances, instantiate selectable fragments
only when they intersect the current content mask. Original byte offsets identify
fragments across reflow; one selection group joins them without newlines. Search
is resolved for the whole paragraph once and sliced over visible fragments.

Parsing/highlighting paths are unchanged. The desktop keeps its bounded worker
parser; native syntax highlighting keeps its existing cache/worker. The pinned
native `<markdown>` parser is synchronous and cached before and after this patch;
this work does not claim to have moved it to a worker. No timer was introduced.

## Exact reference tokens and unapplied integration

Audited `apps/desktop/src/styles/kit.css` (`.chat-markdown`, code blocks and tables),
`styles/notes.css` (`.note-prose`) and the actual `Markdown`/`CodeBlock` components.
`kybern.css` has no overriding rules for these constructs.

| Surface | Reference values used |
| --- | --- |
| Transcript table | 1px `--border` grid; bold header 700, no header fill; 5.6px vertical / 7.2px horizontal padding; GFM alignment |
| Transcript quote | 2px `--border`, 12.8px left padding, muted text, no background or vertical/right padding |
| Transcript inline code | `--app-chat-code-surface`, foreground text, 6.4px radius, 1.6px vertical / 5.6px horizontal padding, configured 13px code / 14px prose |
| Transcript lists | 20px indent, foreground marker, 4px sibling gap; 10.4px gap before a nested list |
| Transcript headings | h1–h6: 1.75/1.55/1.35/1.2/1.1/1 × prose size, 1.25 line-height, weight 600, top 1.1em/bottom .35em; block gaps 10.4px |
| Transcript bold/fences | Bold 500. Fence padding 8px/9.6px, radius 10.4px, code line-height 1.5; label toolbar uses 1.6px vertical padding |
| Notes quote | 2px foreground 22% rail, total 16px inset (14px padding + border), foreground 60% text, no fill; paragraph gap .27 × note-size |
| Notes inline code | foreground 4% light / 5% dark fill, foreground text, 5px radius, .833 × note-size font, .13em/.33em padding measured in that code font |
| Notes list | 1.4 × note-size indent, foreground 42% marker, .27 × note-size sibling/nested gap |
| Notes headings | h1/h2 17/15 × note-size, line-height 1.3; h1 weight 650/h2 600; h3 size 1×/line-height 1.45/weight 600. Top margins 2.25/2/1.6em, following gap .53 × note-size |
| Notes fences | Plain foreground 86% text, n-fill background, no border/header, 14px/16px padding, radius 10px, font 12.5/15 × note-size, line-height 1.68 |

`native/app-integration-5.patch` is **unapplied**, against `e0fbd6f7`. It changes
only `src/transcript/kit.tsx` and `src/notes/NoteBlock.tsx`. Transcript gets the
new tokens and the actual code surface; Notes gets its own tokens and removes
its outer-only quote shim/language-stripping workaround. Nested quotes and
language retention now use native controls. Existing persistence, editors,
reference-chip rendering and bounded transcript composition are unchanged.

```sh
git apply --check apps/gpuix/native/app-integration-5.patch
git apply apps/gpuix/native/app-integration-5.patch
cd apps/gpuix && bun native/check-integration.ts
```

The integration passes clean-apply and in-memory TypeScript checks without
writing app files. App runtime integration remains the parent's step.

## Visual evidence and remaining differences

Artifacts are copied into the original conversation folder:
`/Users/mymac/projects/ade/previews/gpuix/p1e/`.
The main `markdown-{dark,light}-{tauri,gpuix,pair,diff}.png` images show the same
sample; `markdown-wrap-*` shows wrapped code. Tauri is left in every pair.
`capability-{dark,light}.png` shows the focused selection/search/grid/wrap lab.

The WebKit side imports the actual desktop `Markdown` component and stylesheet,
uses a real module parser/highlighter worker, and renders at 728×800 logical pixels,
2×. The GPUIX side uses the same source, colors, typography and dimensions.
This is an isolated WebKit comparison, not a production-CSP Tauri app run.

The patch substantially closes the audited style gaps but is **not a claim of
pixel-identical browser layout**:

- CoreText/font rasterization and GPUI pixel snapping differ. Native table sizing
  remains the existing content-proportional algorithm rather than CSS automatic
  table layout, so column widths can differ.
- The native fence provides a language label, not app-level Copy/Wrap buttons or
  the desktop ScrollArea thumb. Transcript already renders those controls outside
  native Markdown; the standalone comparison makes this difference visible.
- Mixed-direction paragraphs preserve the old whole-paragraph bidi shaping path;
  real padded/smaller inline code is not enabled there. Whitespace-containing code
  spans are one inline box and wrap within it when oversized; WebKit can fragment
  such a span into the remaining line width differently.
- Balanced title wrapping was not implemented. CSS heading letter spacing,
  adjacent-heading special margins and nested ordered alpha/Roman marker styles
  remain outside this patch. Notes table styling has no dedicated `.note-prose`
  grid rule; the helper retains the transcript table defaults for that fallback.

## Validation

The final signed binary passed:

- `native/update.sh`: native release build, LINKEDIT repair, signing/load check,
  all six original scripts, original dark/light capabilities, decoration/atomic
  editing, rounded backgrounds, new Markdown checks, layout/syntax/lifecycle/
  70,003-line checks, scratch combined pointer check, and two spring tests.
- Markdown checks: actual grid pixels; exact `one 😀é two` copy across padding;
  phrase search across prose/code; selection retained through reflow; explicit
  hard breaks; a fitting whitespace-containing code span stays one visual line
  after pixel snapping; code wrapping grows 35.5→133px; final inline code in the
  120KiB document remains reachable after scrolling.
- `pnpm typecheck`, native fixture typecheck, `bun test ./src`: **43 passed,
  402 assertions, zero failures**.
- Unapplied patch clean-apply and in-memory TypeScript check: passed.
- Notification subprocess probe: passed; no authorization request or notification
  was posted. This remains an OS capability probe, not delivery verification.
- `git diff --check`: passed.

Every successful rebuild ran the existing suite and scratch pointer check. Earlier
runs exposed a TypeScript declaration mistake, a stale-click result in an existing
fixture (passed on serial retry), and a test wheel direction mistake. These were
corrected and the required remaining checks completed before rebuilding. Final
image review also caught fractional-width snapping wrapping an otherwise fitting
inline code span; the fix and a regression assertion are in the final full suite.
The final complete run is `native/build/markdown-build-verified.log`.

Reviewed final pair images (Tauri left / GPUIX right):

- `markdown-dark-pair.png`, `markdown-light-pair.png`
- `markdown-wrap-dark-pair.png`, `markdown-wrap-light-pair.png`

The heatmap threshold is 24/255 per RGB channel. Full-image differences are 2.72%,
3.09%, 3.08%, 3.00% respectively; large empty regions are included, so these are
artifact diagnostics, **not** a percentage score for visual parity. The limitations
above remain visible. Physical AppKit dragging, external AX and real IME are not
newly verified by this task.

## Controlled performance

Apple M1, macOS 27.0, Bun 1.4.0, GPUIX 0.10.0. The same fixed source repeats the
sample 200 times: **120,198 UTF-8 bytes / 5,599 lines**, containing headings,
paragraphs, inline code, nested lists, quotes, tables and fenced code. One
background native window per independent run, 10s warm-up then 15s sampling.
Both baseline and final performance runs requested 728×940px; macOS capped the
actual window at **728×868px**, verified by the lab bounds. The visual-pair lab
uses 728×800px separately. The final perf runner explicitly requests the baseline
height, so those viewport dimensions and source match. This is a deliberately
eager large-document native lab, not the app's virtual transcript.

| Sample | Process CPU | Physical footprint | Reported process Metal time / 15s |
| --- | ---: | ---: | ---: |
| Before 1 | 1.60% | 242 MiB | 0.0 ms |
| Before 2 | 1.47% | 242 MiB | 0.0 ms |
| Final 1 | 1.73% | 231 MiB | 0.0 ms |
| Final 2 | 1.67% | 230 MiB | 0.0 ms |

Mean CPU **1.535%→1.70%** (+0.165 percentage points), footprint
**242→230.5 MiB**. No material regression observed in these short settled samples;
the small CPU increase is retained here rather than reported as zero. The sampler's rounded 0.0 ms is not an energy measurement
or proof of zero GPU work. Concurrent system activity, occlusion and launch noise
limit precision. This does not measure streaming/typing latency, frame intervals,
React commit time or energy. Rejected eager-box samples (326/328 MiB) remain in
`markdown-perf-after.log`; accepted exact-binary results are
`markdown-perf-matched.log`. The earlier 800px-height check is retained separately
in `markdown-perf-verified.log` and is not the matched comparison.

```sh
cd apps/gpuix
bun native/markdown-perf.ts Label
```

## Binary and cleanup

Binary:
`/Users/mymac/projects/ade-gpuix-native/apps/gpuix/native/build/gpuix-native.darwin-arm64.node`

SHA-256:
`3cab91e9409a4087d240c50952b787c76d42ec0c6bc4eadd9b53addfd95392be`

Disk free **66 GiB before /63 GiB after**, always above 30 GiB. Other agents were
working on the same volume; the total change is not this task's build footprint.
Retained for integration and incremental rebuilds: native build/target 1.9 GiB,
upstream 185 MiB, existing dependencies 303 MiB. No extra Cargo target or daemon build.
The task-owned Vite server was stopped by its exact PID; its 59 MiB optimizer cache,
transient no-grid screenshots and temporary reference/source files were removed.
Scratch fixtures stopped their own daemons and removed their data. No running lab
from this task remains. Other agents' processes, the user's running app, normal
`~/.kybern` data and port 4219 were untouched. **No commit.**
