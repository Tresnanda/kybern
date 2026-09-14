# Long-chat and renderer memory reductions

Implemented from main `437e09c` (v0.4.0), following PR #15 and issue #14.
The [initial audit](ram-followup-2026-09-14.md) records the unchanged baseline.
The installed application and normal daemon data were not replaced or restarted.

## Changes

- Refreshing a chat with more than 500 loaded blocks no longer requests unlimited
  history. Bounded pages share one snapshot sequence, preserve the previous
  reading cutoff, deduplicate unfinished rows included in multiple pages, and
  replay events received during the complete load. Failures preserve the old
  readable state. This does not limit the size of an individual returned result.
- Chats following the latest output release old completed turns after crossing
  1,500 blocks or an estimated 16 MiB. Cleanup waits for 250 ms of quiet and
  targets roughly 600 blocks or 8 MiB, keeping whole turns, at least the newest
  two turns, and unfinished work. Earlier history remains reloadable through its
  sequence cursor. Reading earlier history, selections, focused message controls,
  disconnected state and in-flight history requests prevent cleanup. Hidden
  windows can clean up while still following. These are data-retention triggers,
  not hard memory caps: pinned or individually large turns can exceed them.
- Virtual rows pin focus and selection by stable keys instead of array positions.
  The new large-history test exposed a focused action being unmounted when rows
  were restored before it; key-based pins preserve its DOM through that change.
- Collapsed tools use a text-availability check instead of creating complete
  display strings. Result formatting mounts inside the existing disclosure and
  is released after its exit. A JSON replacer removes image bytes from displayed
  JSON without first cloning the full result tree. Galleries retain original
  image data. The output's text, selection and existing scroll box are preserved.
- Completed tool calls release an exact duplicate text stream when their final
  result contains that text. Distinct streams, null/primitive fallbacks and
  transport-only agent/task receipts remain available. This shared projection
  also benefits mobile; it does not discard events from storage.
- Inactive terminal tabs and hidden windows release their WebGL addons and stop
  cursor blinking. Terminals, PTYs, scrollback and selections stay alive. Returning
  recreates the graphics renderer; late imports cannot acquire a context for a
  tab that has already become inactive. Context loss keeps the DOM fallback.

## Measurements

Apple M1, 16 GiB, macOS 27.0 (26A5416b), system WKWebView under the production
CSP. Each comparison uses fresh processes, synthetic data, default 1100 × 720
viewport and no forced GC. Normal development activity continued. Measurements
are physical footprint from vmmap, except the explicitly labelled retained-data
estimates. They are separate workloads, not additive savings or confidence intervals.

| Workload / stage | Previous behavior | Updated behavior |
| --- | ---: | ---: |
| 20 collapsed large JSON results, full serializations | 20 | 0 |
| Same collapsed-results stage, physical footprint | 280.5 MiB | 177.7 MiB; repeat 191.9 MiB |
| Six visited inactive terminals, physical footprint | 276.5 MiB | 128.5 MiB |
| Six-terminal stage, lifetime peak | 293.2 MiB | 178.5 MiB |
| Following a 1,000-turn history, retained blocks | 3,000 | 600 |
| Same history, estimated retained transcript data | 2,341,628 bytes | 467,828 bytes |

The terminal baseline uses the same real xterm/WebGL fixture with deactivation
disabled, reproducing the prior retention policy. All six terminal buffers remain
loaded at the compared stage. The later five-switch lifecycle test preserves exact
scrollback, selection and reading position. Its later inactive-stage footprint did
not improve in every run: allocator/graphics collection and recreation vary. This
does not claim a memory reduction for every individual tab switch.

The result fixture retains its synthetic backing data and exercises selecting a
large complete output. Native footprint can rise during selection and cleanup
despite detached DOM. The reported saving is for the comparable collapsed stage;
there is no claim of immediate heap release on closing a disclosure.

The history fixture deliberately keeps a fixture-side history source for reloads,
so its byte figures measure the store's retained data, not total native memory.
At 1100px and 480px it reloads an evicted page with zero measured anchor movement,
preserves the final answer object and formatted DOM, and pins history through text
selection and keyboard focus. Removing cleanup makes it fail with 3,000 blocks;
using positional virtual-row pins makes its focus assertion fail.

The unchanged baseline's full scrolling stress peak was 888.9 MiB. An intermediate
candidate measured 800.4 MiB, with a 416.0 MiB history peak and 18–19 ms frame p95.
That lies within the previously recorded run-to-run range; it does not establish
another substantial graphics-memory reduction. The final native guard passes at
415.4 MiB history peak / 812.5 MiB full-sequence peak, with all 1,600 sampled frames
nonempty and frame-interval p95 of 18–20 ms. The work-stream fixture separately
reports 3 ms commit p95 and 16 ms synthetic input-to-frame p95. No two-hour ordinary-use comparison has been completed,
so issue #14 should remain open.

## Verification

Desktop validation: 175 unit tests, typecheck, lint and production build pass.
The native fixtures preserve complete tool JSON and selection, formatted Markdown,
unchanged code wrappers, first/middle/last navigation, wrapping, focus, disclosure
state, reading anchors, thread switching and follow gestures. The work-stream
fixture also checks input and mixed-work geometry. Screenshots of the narrow
interaction and history-retention surfaces were inspected. macOS CI now runs the
new history-retention, deferred-output and terminal-lifecycle fixtures.

Commands from apps/desktop:

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm build
node scripts/check-rendering.mjs tool-memory
node scripts/check-rendering.mjs terminal-memory
KYBERN_TERMINAL_RETAIN=1 node scripts/check-rendering.mjs terminal-memory
node scripts/check-rendering.mjs history-retention
KYBERN_PERF_WIDTH=480 node scripts/check-rendering.mjs history-retention
node scripts/check-rendering.mjs history
node scripts/check-rendering.mjs rendering
node scripts/check-rendering.mjs interaction
KYBERN_PERF_WIDTH=480 node scripts/check-rendering.mjs interaction
node scripts/check-rendering.mjs work-stream
node scripts/check-rendering-memory.mjs
```

Mobile typecheck, 108 tests and Android/iOS exports pass. Expo Doctor passes 20/21
checks; the existing exact pins lag 19 Expo patch updates. No dependencies or
native configuration changed. Rust/protocol files are unchanged; Rust tests and
native application packaging were not run for this frontend/shared-client change.

## Remaining scope

Large individual visible outputs still require their full text and native layout.
Reading/pinned histories can exceed cleanup budgets. The daemon still builds a
full sequence projection before selecting a page; its independent transient memory
cost was not changed. Further work on on-demand payload transport, large-output
viewers and projection checkpoints requires separate before/after workloads that
preserve full access, copying, navigation and live-event reconciliation. No content
was truncated to meet a memory number. Whole-app CPU and energy were not measured.
