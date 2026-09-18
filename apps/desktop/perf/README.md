# Desktop performance guide

Use this guide before changing the transcript, Markdown, state updates,
navigation, materials, or animation. Performance and visual quality are a single
review: keep the intended appearance and interactions, then remove unnecessary
rendering, layout, repaint, and background work. Reuse the existing machinery.

## Findings to preserve

| Area | Regression we measured | Fix to retain |
| --- | --- | --- |
| Running indicators | Animating dot background colors repainted continuously; invisible indicators kept running. | Opacity animation with matching painted colors; one shared visibility observer; pause hidden/offscreen/inactive loops without resetting phase. |
| Streaming history | New turn groups and Markdown component types invalidated settled messages, code controls, and highlighted DOM. | Stable identities, memoized rows, stable component types, retained highlighted markup, and subscriptions scoped to the affected state. |
| Closed and expanded work | Closed details stayed mounted; large histories and expanded tool groups created tens of thousands of DOM nodes. | Unmount closed content after exit; virtualize large history, work groups, and agent activity while retaining small lists in normal flow. |
| Rendered-history memory | Fast scrolling reached gigabyte-scale WebKit graphics allocations with a small mounted DOM. | Paint boundaries on large outer virtual rows, with room for gutter controls and focus rings; measure native footprint as well as DOM counts. |
| Scroll tile accumulation | Any content painted by the scroller's tiled layer (or another tiled layer) made WebKit allocate 4 MiB tiles ahead of fast scrolling and release them one cohort per second; dense work reached 140 tiles. | Every painted row is a small `chat-paint-host` layer (virtual rows, messages, headers, work lists, answers); scrollers and large containers paint nothing. Icons promote only while swapping. |
| Earlier-history paging | A retry at the top could reuse old scroll intent and download every remaining page. | Consume intent per request; require further reading input before another automatic page, while preserving the anchor. |
| Markdown and code | Full parsing and highlighting competed with input and scrolling on the renderer thread; serialized equality signatures duplicated retained trees. | Separate module workers, incremental tail parsing, exact structural comparison, bounded queues/caches, cancellation, and source-size limits. Retain prior formatting during updates and readable text on failure. |
| Diagrams | DOM-based diagram engines and image URLs can outlive visible content. | Load Mermaid only for settled diagrams, bound queued work/cache/output, release its rendering document at idle, and revoke replaced/unmounted image URLs. |
| Stream scheduling | Frame-driven reveal and repeated highlighting did more React work than presentation needed. | Reuse the existing reveal cadence and size-aware highlighting interval; allow in-progress prefixes to finish; catch up exactly at completion. |
| Message navigation | Mutation handlers rebuilt historical previews and scrolling scanned every message rectangle. | Data-driven rail entries, bounded cached previews, virtual ticks, and geometry reads coalesced to a frame and limited to visible content. |
| Glass surfaces | An opaque wrapper concealed translucent content; stacked tints and duplicate blur layers added cost or muddy color. | Check the entire surface hierarchy; use shared role tokens, one blur layer per floating surface, and all opaque/accessibility fallbacks. |
| Tall markdown quote layer | Hosted markdown promoted wrapping `blockquote` as one layer past 1024 CSS px because the left bar paints on the quote. | Host quote children; move the bar onto those children with abutting padding. Native A/B: `KYBERN_PERF_LIVE_QUOTE_LAYER=1`. |
| Native integration | A worker dependency selected a DOM-only browser entry; a fallback made the screen look functional while formatting was broken. | Verify the production bundle, worker execution, actual formatted output, and CSP in native WebKit. A browser dev preview alone is insufficient. |

The source owns numeric queue limits, cache budgets, virtualization thresholds,
and motion cadence. Inspect the existing modules before tuning them; justify a
change with the affected workload rather than copying a historical constant.

## Evidence and scope

See [the whole-app follow-up](daily-memory-followup-2026-09-18.md) for the
842 → 434 MiB initial release-workload reduction and the further matched
454 → 385 MiB peak reduction from removing the chat card's stacking context.
It includes repeated-burst observations, paged-history paint boundaries,
bounded settled streams, title metadata checks and hidden dock measurements.
The 200–300 MB target is not a verified ceiling; repeated settled use also
exceeded it.

See [the daily-use memory investigation](daily-memory-2026-09-18.md) for compact
live/replayed result delivery, assistant-settlement allocation reduction,
primary-source research, and the remaining 200–300 MB whole-app acceptance work.

See [tall markdown quote layer](hosted-quote-2026-09-18.md) for why hosted
markdown must not promote wrapping blockquotes, and the native A/B control
(`KYBERN_PERF_LIVE_QUOTE_LAYER`).

See [live tool result retention](live-tool-retention-2026-09-18.md) for the live
completion path that previously bypassed lazy-result budgets, its byte/count
limits and exact-content fixture, and the daemon/CLI retention follow-up.

See [the whole-app live-result memory check](whole-app-ram-2026-09-18/REPORT.md)
for the isolated release Tauri coalition pair, exact 64-result content check,
WebKit allocator evidence, lifecycle review and the explicit distinction between
an unchanged burst peak and lower settled allocated bytes.

See [the consolidated memory review](memory-review-2026-09-17/REPORT.md) for
snapshot-safe tool hydration, mounted result leases, borrowed daemon paging,
matched release-daemon measurements, and the remaining whole-app and page-aware
reconstruction gates. Run `tool-leases` with a release daemon to exercise real
RPC hydration of 16 results shared across two native WebKit panes.

The [native window material experiment](native-window-material-memory-2026-09-18.md)
is superseded: clearing the effect when full translucency is off broke the
normal macOS sidebar in v0.4.8. Preserve native vibrancy in both content modes.
The exploratory memory figures are not accepted savings evidence, and material
checks must include the production ThemeProvider lifecycle and sidebar.

See [scroll tile accumulation](memory-tiles-2026-09-15.md) for the attribution of
the remaining native peak to WebKit's scroll tiles, the paint-host layer rule,
and the diagnostic hooks (`KYBERN_SCROLL_EXTRA_CSS`, `KYBERN_PERF_DEBUG_LAYERS`).

See [further renderer memory work](memory-followup-2026-09-15.md) for redundant
Markdown metadata, streaming allocation reductions, inactive icon cleanup, and
the remaining native WebKit footprint. The focused parsed-data guard is 36 MiB;
Node timing improvements are separate from native memory measurements.

See [long-chat and renderer memory reductions](memory-reductions-2026-09-14.md)
for bounded refreshes, cleanup while following, stable interaction pins, deferred
result formatting, and inactive terminal graphics release. Run `history-retention`
at 1100px/480px plus `tool-memory` and `terminal-memory` for those paths.

See [profile and diagram UI polish](renderer-ui-polish-2026-09-14.md) for explicit
profile controls, responsive grouping, diagram expansion, and motion/focus checks.

See [renderer follow-ups](renderer-followups-2026-09-14.md) for Markdown data
retention, the latest peer-source review, lazy diagram rendering, OMP profiles
and the opaque composer correction.

See [rendered-history memory](rendered-history-memory-2026-09-14.md) for the
fast-scroll graphics spike, its native before/after comparison, and the remaining
limits of the earlier store/worker memory tests.

See [composer panel stacking](composer-stack-2026-09-12.md) for combined activity,
queued prompts, questions, and approvals, including narrow and short panes.

See [scroll position and frame pacing](scrolling-2026-09-12.md) for measured
scroll jumps, cold history, active streaming, expanded work, and long code.

See [OMP lifecycle and active-work rendering](work-stream-2026-09-12.md) for
thinking re-entry, expanded work collisions, and token/task updates in the full
sidebar/composer shell.

See [chat file links and earlier history](chat-files-history-2026-09-10.md) for
connected-workspace previews and bounded automatic history prefetch.

See [connectors and artifact verification](integrations-2026-09-09.md) for native
provider controls, isolated previews, and the iOS simulator check.

See [Notes, prompt controls, and Activity follow-up](notes-activity-scroll-2026-09-09.md)
for the 4,000-task comparison, short/long scroll checks, and the small upward
scroll regression.

See [turn lifecycle and release verification](turn-fixes-2026-09-07.md) for
background-task completion, image previews, environment menu checks, and the
release build changes.

These are recorded results from different workloads, not numbers to combine
into one overall percentage:

- The isolated three-loader fixture below went from 33.78% to 6.48% combined
  Safari/WebContent/GPU-process CPU, with matching geometry and painted colors.
  That is not an 81% whole-app CPU or battery improvement.
- The live-thread replay in [glass and transcript rendering](glass-transcript-2026-09-06.md)
  retained 12/12 unchanged turn groups, reduced mounted DOM from 10,636 to 1,159,
  and brought scroll interval p95 from 35 ms to 18 ms.
- The [streaming code fixture](streaming-rendering-2026-09-06.md) retained 30/30
  code wrappers and wrap state, eliminated repeated historical preview reads,
  and reduced streaming frame-interval p95 from 187 ms to 19 ms.
- The final [M1 scaling comparison](large-transcript-2026-09-06.md) used 400
  historical turns, 800 tools, and 180 streamed GFM tables. Mount commit fell
  from 902 ms to 47 ms; mounted history messages from 802 to 8; streaming frame
  interval p95 from 105 ms to 18–19 ms; input-event-to-next-frame p95 from
  165 ms to 15–16 ms. The input probe is synthetic, not OS key-to-screen latency.
- The [live process sample](live-session-2026-09-06.md) located most observed
  CPU in WebKit rather than the daemon. It was not a controlled before/after
  comparison, proof of a leak, or an energy measurement.

The [peer source review](peer-source-review-2026-09-06.md) informed the direction
but did not benchmark those applications. The older review and streaming report
list virtualization/parsing as follow-ups; those shipped in v0.2.0 and are
covered by the scaling report. Read them as historical snapshots.

## Verification by change

From `apps/desktop`, run the normal `pnpm test`, `pnpm typecheck`, `pnpm lint`,
and `pnpm build` checks. Add the affected native fixtures on macOS:

| Change | Native check |
| --- | --- |
| Settings screen, navigation, and usage reporting | `node scripts/check-rendering.mjs settings` |
| Theme tokens, surfaces, translucency | `node --experimental-strip-types scripts/check-window-material.mjs` |
| Streaming, Markdown, highlighting, message rail | `node scripts/check-rendering.mjs` |
| Thinking disclosure re-entry, mixed work, dynamic row heights | `node scripts/check-rendering.mjs work-stream` |
| Store publication, sidebar, composer, background task status | `node scripts/check-rendering.mjs work-shell` |
| Collaboration group lifecycle, paging, attribution, and context revisions | `node scripts/check-rendering.mjs collaboration` |
| Ordinary-chat delegation, child navigation, earlier-thread references, project coordinator entry, and optional dock panels | `node scripts/check-rendering.mjs chat-collaboration` |
| Release announcement, release details, and sidebar update controls | `node scripts/check-rendering.mjs app-update` |
| Context menus or popup materials | `node scripts/check-rendering.mjs materials` |
| Large histories, worker scheduling, expanded work | `node scripts/check-rendering.mjs scaling` |
| Rendered-history graphics allocations | `node scripts/check-rendering-memory.mjs` |
| Parsed Markdown retention and worker release | `node scripts/check-rendering.mjs markdown-memory` |
| Mermaid rendering, fallbacks and resource cleanup | `node scripts/check-rendering.mjs mermaid` |
| Default/project OMP profile settings | `node scripts/check-rendering.mjs profiles` |
| Virtualization, navigation, row state, scroll anchoring | `node scripts/check-rendering.mjs interaction` |
| Scroll position corrections, cold history, scrolling during work | `node scripts/check-rendering.mjs scrolling` |
| Question forms, multiline input, submission states | `node scripts/check-rendering.mjs questions` |
| Combined composer panels, shared seams, constrained pane height | `node scripts/check-rendering.mjs composer-stack` |
| Attached-image controls, user line breaks, environment menu | `node scripts/check-rendering.mjs chat-fixes` |
| Image previews, local links, image recovery | `node scripts/check-rendering.mjs artifacts` |
| Provider catalogs, sign-in terminals, native artifact preview and publication controls | `node scripts/check-rendering.mjs integrations` |
| Activity task sorting, retained history, hidden timers | `node scripts/check-rendering.mjs activity` |
| Notes, queued prompt editing, and steering controls | `node scripts/check-rendering.mjs prompts` |
| Saved-session picker, search, pagination, keyboard navigation | `node scripts/check-rendering.mjs sessions` |
| Earlier-history prefetch, retry, prepend anchoring | `node scripts/check-rendering.mjs history` |
| Claude background continuation and final-answer grouping | `node scripts/check-rendering.mjs continuation` |

For indicator changes, also run the matrix appearance/visibility comparison
below. The native runner builds fixtures separately at `tauri://localhost`
under the production CSP; fixture transports never enter the shipped app.

A passing optimization preserves exact final text and formatted constructs,
code controls, first/middle/last navigation, selections and focus, expansion,
reading position during output and history prepends, and following new output.
Check narrow layouts, theme states, and reduced motion when affected. Inspect
screenshots for appearance; measure timings for responsiveness. Neither check
substitutes for the other. Save previews inside the conversation's original
folder before viewing or sharing them, including when coding in another worktree.

Record the runtime, hardware, workload, warm/cold state, sample count, and which
stage a number measures. Keep synthetic commit timings separate from later
layout/GPU presentation and input probes. Report background/idle work separately
from active streaming. Use scratch data; keep private replay data out of commits.
Do not replace an app or daemon hosting the development session to benchmark it.

## Matrix loader regression fixture

Run `pnpm dev --port 1439` from `apps/desktop`, then open
`http://localhost:1439/perf/matrix.html` in Safari. No daemon, credentials,
agent requests, or native Kybern instance are needed. This page is not an entry
point in the production build.

The fixture renders the real `MatrixLoader`: two 1.6-second sidebar orbits on a
blurred surface and one 1.2-second working indicator. It has no streaming,
polling, or JavaScript animation loop. `matrix-baseline.css` freezes the old
background-color implementation; Optimized loads the current `motion.css`.
Both buttons report the active animation count and animated property so a failed
stylesheet load cannot be mistaken for an improvement.

**Check appearance** freezes 36 dots at 65 phases across two cycles. It checks
geometry and compares their computed color/opacity composited over dark and
light backgrounds (tolerance: 2/255 per channel). It also checks actual browser
intersection clipping, frozen time while offscreen, phase-preserving resumption,
and the inactive mounted-pane rule. This color check does not compare complete
window screenshots or backdrop rasterization.

For CPU measurements, leave the page visible and alternate Baseline → Optimized
→ Baseline. Identify this Safari tab's WebContent and GPU PIDs plus Safari's PID
using `ps`/Activity Monitor, then measure each mode with:

```sh
top -l 5 -s 2 -pid <webcontent-pid> -pid <gpu-pid> -pid <safari-pid> -stats pid,command,cpu,time
```

Discard the first sample (no measurement interval). Keep other tabs quiet and
do not run builds during sampling. Percent CPU is in units of one core; CPU in
the GPU process is not GPU utilization or a direct power measurement.

### Recorded result

2026-09-06, macOS 27.0 (26A5416b), system Safari/WebKit. Four two-second samples
per mode, same window geometry, same three loaders, confirmed 36 running dot
animations in each mode:

| Mode | WebContent CPU | GPU-process CPU | Safari CPU | Combined |
| --- | ---: | ---: | ---: | ---: |
| Background-color baseline | 9.00% | 18.53% | 6.25% | 33.78% |
| Opacity + visibility handling | 3.70% | 0.20% | 2.58% | 6.48% |
| Baseline repeated | 9.03% | 18.63% | 6.33% | 33.98% |

About 81% less combined CPU in this isolated fixture. The production app was
left running because it hosted the development session. This is not a measured
81% reduction for the whole app: transcript rendering, shimmers, compilation,
native window materials, and agent processes are outside this comparison.

The browser regression checks passed with identical dot dimensions and a
maximum painted channel difference of 1/255 on both backgrounds. Offscreen
animation time froze, resumption preserved the phase, and inactive mounted
panes paused their loaders. The desktop's 70 unit tests, typecheck, lint, and
production frontend build passed. Native packaging was not run.
