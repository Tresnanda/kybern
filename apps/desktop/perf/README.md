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
| Markdown and code | Full parsing and highlighting competed with input and scrolling on the renderer thread. | Separate module workers, incremental tail parsing, bounded queues/caches, cancellation, and source-size limits. Retain prior formatting during updates and readable text on failure. |
| Stream scheduling | Frame-driven reveal and repeated highlighting did more React work than presentation needed. | Reuse the existing reveal cadence and size-aware highlighting interval; allow in-progress prefixes to finish; catch up exactly at completion. |
| Message navigation | Mutation handlers rebuilt historical previews and scrolling scanned every message rectangle. | Data-driven rail entries, bounded cached previews, virtual ticks, and geometry reads coalesced to a frame and limited to visible content. |
| Glass surfaces | An opaque wrapper concealed translucent content; stacked tints and duplicate blur layers added cost or muddy color. | Check the entire surface hierarchy; use shared role tokens, one blur layer per floating surface, and all opaque/accessibility fallbacks. |
| Native integration | A worker dependency selected a DOM-only browser entry; a fallback made the screen look functional while formatting was broken. | Verify the production bundle, worker execution, actual formatted output, and CSP in native WebKit. A browser dev preview alone is insufficient. |

The source owns numeric queue limits, cache budgets, virtualization thresholds,
and motion cadence. Inspect the existing modules before tuning them; justify a
change with the affected workload rather than copying a historical constant.

## Evidence and scope

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
| Theme tokens, surfaces, translucency | `node --experimental-strip-types scripts/check-window-material.mjs` |
| Streaming, Markdown, highlighting, message rail | `node scripts/check-rendering.mjs` |
| Context menus or popup materials | `node scripts/check-rendering.mjs materials` |
| Large histories, worker scheduling, expanded work | `node scripts/check-rendering.mjs scaling` |
| Virtualization, navigation, row state, scroll anchoring | `node scripts/check-rendering.mjs interaction` |
| Question forms, multiline input, submission states | `node scripts/check-rendering.mjs questions` |
| Image previews, local links, image recovery | `node scripts/check-rendering.mjs artifacts` |

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
