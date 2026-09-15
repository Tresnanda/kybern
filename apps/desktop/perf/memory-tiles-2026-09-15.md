# Scroll tile accumulation

Third memory pass on PR #18 (`bca8a40`, base main `437e09c` v0.4.0). The two
earlier passes ([bounded retention](memory-reductions-2026-09-14.md),
[renderer follow-up](memory-followup-2026-09-15.md)) reduced JavaScript
retention and streaming churn, but the full scrolling fixture still peaked at
roughly 800 MiB of physical footprint. This pass attributes that peak to
WebKit's graphics allocations and changes the transcript's layer structure so
those allocations are bounded by the mounted rows instead of by scroll speed.

## What the peak was

`vmmap` splits the WebContent footprint into region types. At the mixed-work
stage of the unchanged PR #18 source, the process held:

| Region type | Resident | Regions |
| --- | ---: | ---: |
| `owned unmapped (graphics)` | 788.7 MiB | 324 |
| `WebKit Malloc` | 267.4 MiB | 13 |
| `JS JIT Generated Code` | 10.4 MiB | 3 |

The full region list (`vmmap <pid>` while the fixture held the document)
showed the graphics regions were almost all the same size:

| Region size | Count | What it is |
| ---: | ---: | --- |
| 4144K | 102–140 | 1024 × 1024 device-pixel BGRA scroll tiles (512 CSS px at 2×) |
| 12.4M | 3–8 | viewport-sized buffers for the scroll-fade mask |
| 656K / 1696K | ~36 | partial tiles at tiled-layer edges |
| 16K | ~100 | one compositing layer per resting `IconSwap` glyph |

So the peak is WebKit's tile cache for the transcript's tiled layer, not
retained JavaScript. The resting footprint after eight idle seconds was
131–135 MiB in every mixed-work configuration and 180 MiB for history.

## Why the tiles accumulate

WebKit backs an overflow scroller's contents with a tiled layer whose coverage
extends ahead of scrolling, and tiles that leave coverage go into cohorts that
are released one cohort per second. During continuous fast scrolling new
cohorts form every frame, so tiles accumulate until scrolling stops and drain
slowly afterwards. The synthetic mixed-work stage scrolls about 9,000 CSS px/s
and accumulated 140 tiles (560 MiB). A tiled layer's tiles are bounded only by
its own size, and the scroller's layer is 51,000 px tall in that stage.

Controlled experiments (`KYBERN_SCROLL_EXTRA_CSS`, mixed-work stage, region
histogram after the scroll) established the rule:

| Experiment | Full tiles | Graphics resident |
| --- | ---: | ---: |
| Control | 140 | 640–660 MiB |
| Remove `will-change` / `filter` / `transform` everywhere | 138–140 | 640 MiB |
| Remove the scroll-fade mask | 129 | 672 MiB |
| Promote the whole log content (`will-change: transform`) | 140 | 588 MiB |
| Promote the turn only | 140 | 580 MiB |
| Promote every nested virtual row only | 136 | 655 MiB |
| Promote nested rows, the user message and the working header | 8 | 143 MiB |

Style hints on individual elements did not matter; which layer paints did.
Tiles disappear only when every painted element sits in a compositing layer
smaller than WebKit's tiling threshold (2048 device px, 1024 CSS px at 2×),
so that the scroller and other large containers draw nothing. Small layers
have one backing store bounded by their own box, and virtualization bounds
how many exist. PR #15's history fix worked for the same reason by accident:
`contain: paint` rows became composited because they contained permanently
promoted icons. Removing the icon promotion alone raised history-fast to
486 tiles (2.0 GiB graphics), which matches the earlier rejected experiment.

## Changes

- `VirtualRows` gives every mounted virtualized row `will-change: transform`
  in addition to the outer paint boundary. Short lists that stay in normal
  flow wrap each item in the same paint host: one tall item (an opened tool
  group) otherwise made the enclosing work container a tiled layer that painted
  its siblings, such as the streaming tail, and accumulated scroll tiles. The
  wrapper has no padding or border, so margins collapse through it and spacing
  is unchanged.
- `chat-paint-host` (kit.css) marks the painted transcript leaves: user
  messages, the working header and "Thinking" row, live and settled work
  lists, grouped-tool headers and panels, nested activity lists, the settled
  hairline, and the answer block. Scrollers, turns and virtual list containers
  paint nothing.
- `IconSwap` children are promoted only while `data-swapping` is set. A
  resting icon has no `will-change`, `filter` or `transform`; the cross-blur,
  keyed reversal and geometry checks in the icon fixture are unchanged and the
  fixture now asserts both states.
- Streaming words (`.t-stream-w`) no longer carry a permanent `will-change`;
  their `@starting-style` transition still runs.
- Transcript Markdown (`chat-markdown--hosted`) hosts each top-level block,
  and the answer block hosts its other children (images, footer with copy and
  time, errors, the edited-files card). The footer alone, painted straight into
  a 105,000 px answer, kept a tiled layer alive for the long-code stage.
- Code blocks longer than 40 lines are split into `chat-code-chunk` blocks
  (`lib/codeChunks.ts`), each its own layer, so a 5,000-line block is 125
  small layers whose backing stores WebKit only attaches near the viewport.
  Newlines stay inside the chunks: `textContent`, selection and copied text
  are unchanged, and the fixture checks the block's height against 5,000 line
  boxes. The code surface moved from a background on the tall rounded wrapper
  to a promoted, radius-free pseudo-element, so the wrapper paints nothing.

Long single elements (a 5,000-line code block, a very long answer) still become
tiled layers, but their tiles are bounded by the element's own size rather
than by the scroller's 50,000+ px content height.

## Results

Apple M1, 16 GiB, macOS 27.0 (26A5416b), system WKWebView 22625, 1100 × 720,
production frontend and CSP at `tauri://localhost`, fresh processes, no forced
GC, normal background activity. `node scripts/check-rendering-memory.mjs`,
physical footprint from `vmmap -summary` after each stage:

| Stage | PR #18 `bca8a40` current / peak | This change current / peak |
| --- | ---: | ---: |
| History cold | 325.1 / 342.2 MiB | 269.0 / 294.1 MiB |
| History warm | 261.0 / 344.6 MiB | 233.8 / 294.1 MiB |
| History fast | 355.4 / 393.0 MiB | 323.2 / 341.2 MiB |
| Mixed work | 540.8 / 729.0 MiB | 239.3 / 391.8 MiB |
| Mixed work streaming | 684.2 / 815.2 MiB | 244.5 / 391.8 MiB |
| Expanded thinking | 582.8 / 875.1 MiB | 271.8 / 411.1 MiB |
| Expanded tools | 541.5 / 875.1 MiB | 235.9 / 411.1 MiB |
| Long code | 441.2 / 875.1 MiB | 240.7 / 411.1 MiB |

The full-sequence lifetime peak fell from 875.1 MiB to 411.1 MiB, the history
peak from 393.0 to 341.2 MiB, and the mixed-work peak from 729.0 to 391.8 MiB.
Graphics resident memory after the mixed-work scroll fell from 788.7 MiB
(324 regions) to about 145 MiB when the stage runs alone, and every dense
stage now ends with only the page root's four to six tiles. Frame p95 stayed
at 17–19 ms with zero empty viewports in every stage.

The expanded-tools residual from the first pass was attributed with WebKit's
compositing overlay (`KYBERN_PERF_DEBUG_LAYERS=1`, captured with
`screencapture -l`): each tool row was its own layer, but the work container
around the opened group was still a tiled layer with a live tile grid. Hiding
the turn's children removed it while hiding the panel, trigger, message,
header or tail individually did not, which pointed at the non-virtualized
work list: with two items it rendered them without wrappers, so the streaming
tail painted straight into the 25,000 px container. Wrapping plain-list items
in paint hosts took that stage from 307 MiB / 28 accumulated tiles to
155 MiB / 4 root tiles when run alone.

The long-code stage run alone went from 279 MiB graphics resident with 30
accumulating tiles to 152 MiB with the page root's tiles only, and its
lifetime peak from 295 to 224 MiB. Clean before/after captures of the long
code and history stages are pixel-identical. What remains is the scroll-fade
mask on the transcript scroller (two to four viewport-sized buffers, about
25–50 MiB); a gradient overlay would replace it only on opaque windows, and
translucent windows are the default, so it is left as is.

The footprint peak is a noisy measure of tile memory because the kernel stops
counting tiles once WebKit marks them volatile; identical control runs ranged
from 467 to 818 MiB. The region histogram after the scroll is stable and is
the number to compare when changing layer structure.

## Diagnostics added

- `KYBERN_SCROLL_EXTRA_CSS='<css>'` injects a stylesheet into the scrolling
  fixture only, for attributing native allocations to styles.
- `KYBERN_PERF_DEBUG_LAYERS=1` enables WebKit's compositing borders and tiled
  scrolling indicator in the native runner and prints the window id, and dumps
  the private scrolling tree at each memory sample. Screen recording
  permission is required to capture the overlays.
- Save region summaries with `KYBERN_PERF_MEMORY_DIR`; run `vmmap <pid>` while
  the fixture holds a document (`KYBERN_SCROLL_IDLE_MS`) for the histogram.

## Verification

From `apps/desktop`: `pnpm test` (187), `pnpm typecheck`, `pnpm lint`,
`pnpm build`, then `node scripts/check-rendering-memory.mjs`,
`node scripts/check-rendering.mjs icon-swap`, `work-stream`, `interaction`
(1100 and 480 px), `history-retention`, `scrolling`, `rendering`, `scaling`
and `markdown-memory`. All pass on the final source: interaction keeps first/middle/last navigation,
selection and its release, focus, reading position, prepend anchoring, tool and
group state, resize, thread switching and follow gestures at both widths;
history retention still reloads with zero anchor shift; the scrolling fixture
reports frame p95 of 17–19 ms and no empty viewports; rendering retains 30/30
code blocks with exact final text; scaling mounts the 401-turn history in
50 ms with 8 mounted messages; the parsed Markdown guard stays under 36 MiB.
The production build succeeds.
