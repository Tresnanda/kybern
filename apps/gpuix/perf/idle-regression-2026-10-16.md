# Idle repaint investigation — October 16, 2026

## Result

The audit did **not establish an idle Home regression**. Its screenshot fixture
contains synthetic running threads, and the visible `Queued follow-ups` row
animates by design. A fresh daemon with only settled threads is quiet at both
`58bd8d25` and `0b0978c5`, using the same current native binary.

The Tasks board acquired a continuously animated Running column header in
`c792f3ca`, first appearing on the tested first-parent history in **`e0fbd6f7`**.
The immediate first-parent predecessor `6842fa46` is quiet on that board. This
is intentional parity: desktop `views/tasks/TaskBoard.tsx:74` also explicitly
passes `animated` to the empty Running header. Do not fix it by removing motion.

No safe, measured production optimization was found within the app-only scope.
Two cache experiments were measured and rejected, then reverted. The existing
small indicators already use cached islands and a parked, shared, throttled
clock. A further improvement needs a native paint-invalidation experiment and
native correctness validation, not another application cache wrapper.

## Method and isolation

- Apple M1, macOS 27 host, Bun 1.4.0, GPUIX 0.10.0.
- Background GPUIX window; 10 seconds warm-up and 15 seconds sampling per scene.
- `/Users/mymac/projects/ade-gpuix-transcript`, detached commits during the test.
- Installed `/Applications/kybern.app/Contents/MacOS/kybernd`, random port,
  task-owned temporary data/config/credentials directories. No agents launched.
- Four global tasks (two inbox, two todo), one settled eight-turn conversation.
  Optional `KYBERN_IDLE_RUNNING_THREAD=1` adds one synthetic running sidebar row.
- Native binary copied from `ade-gpuix/apps/gpuix/native/build/`:
  `a5b2f882a93da1a08cca9038e882128ecfe821c1cdd35d24b5c15fa3463c8f10`.
  Same binary throughout; no Cargo build or new dependencies.
- CPU is process CPU-time delta; GPU is per-PID AGX `accumulatedGPUTime` delta;
  memory is physical footprint. No energy or input-latency claim.
- Other agent/native fixture work and normal host apps could contend. CPU
  varied materially; GPU and the invalidation counters are stronger evidence.
- Original samples use existing `perf/sample.ts`, whose CPU endpoint follows
  the footprint query. Final `idle-measure.ts` captures CPU/GPU endpoints before
  footprint and reports the actual elapsed interval (~15.05 seconds).
- Island render/wake counts are not window frame counts. Debug logging and the
  React DevTools commit hook add instrumentation overhead.

## Reproduction

```sh
cd apps/gpuix
bun scripts/idle-measure.ts
KYBERN_IDLE_RUNNING_THREAD=1 KYBERN_REDUCED_MOTION=0 bun scripts/idle-measure.ts home tasks
bun scripts/idle-fixture.ts -- node scripts/idle-webkit.mjs tasks tasks-still
KYBERN_IDLE_RUNNING_THREAD=1 bun scripts/idle-fixture.ts -- node scripts/idle-webkit.mjs home tasks
```

The measurement entry point owns a fresh daemon via `idle-fixture.ts`; it does
not attach to an inherited normal daemon. The fixture rejects port 4219 and
removes its scratch data after closing its own children. WebKit uses the
existing Playwright installation, configurable with `PLAYWRIGHT_CORE`, and an
existing desktop Vite installation. It does not download a browser.

`idle-app.ts` installs the DevTools hook before the reconciler loads;
`idle-harness.ts` counts commits and `KYBERN_DEBUG_ISLANDS=1` messages.
`idle-metrics.ts` contains the process measurement helpers. Set
`KYBERN_IDLE_LOGS=1` for bounded raw native diagnostic output.

## Commit checks and original-method measurements

| App commit / state | Scene | CPU % | GPU ms / 15 s | Footprint MiB |
| --- | --- | ---: | ---: | ---: |
| `58bd8d25`, settled only | Home | 3.00 | 0.0 | 157 |
| `0b0978c5`, settled only | Home | 3.13 | 0.0 | 160 |
| `0b0978c5`, settled only | Populated thread | 3.13 | 3.7 | 193 |
| `0b0978c5`, settled only | Tasks board | 6.67 | 85.6 | 206 |
| `0b0978c5`, settled only | Settings | 2.60 | 0.0 | 199 |
| `6842fa46`, settled only | Tasks board | 2.93 | 0.0 | 179 |
| `e0fbd6f7`, settled only | Home | 1.33 | 2.1 | 161 |
| `e0fbd6f7`, settled only | Tasks board | 3.13 | 62.1 | 200 |
| `58bd8d25`, one running sidebar row | Home | 4.00 | 81.1 | 192 |
| `0b0978c5`, one running sidebar row | Home | 4.60 | 110.5 | 186 |

The first bad Home commit cannot honestly be supplied: both requested endpoints
are quiet with genuinely settled state. The narrowed Tasks introduction is a
source/measurement boundary, not evidence of a native binary regression.
The endpoint running-row comparison is not a clean CPU speedup/regression
claim: host load, source layout complexity and sample timing differ.

## Why the audit Home was busy

The audit's `visual/fixture.conversation.ts:130` explicitly writes
`status='running'` for `Queued follow-ups` and `Subagent launches`.
`previews/gpuix/audit-2026-10-16/performance.json` includes `Queued follow-ups`
in both Home `paintedAtSample` strings. The audit workload also contained
20 threads and 26 tasks, unlike the minimal settled baseline.

`src/sidebar/rows.tsx` mounts `MatrixLoader` when status is running or activity
is working. Settings replaces that sidebar, so its otherwise quiet result is
consistent with the same loader explanation. No stuck spinner, observer
feedback loop, backdrop filter or composer-height loop was reproduced.

## Actual invalidation mechanism

1. `MatrixLoader.tsx` has one module-level shared interval, default **200 ms
   (5 Hz)**, overridden by `KYBERN_LOADER_TICK_MS`. It runs only with listeners,
   visible windows and normal motion; it parks when those conditions cease.
   The current checked-in README also documents the 5 Hz default. It is not
   a 30/15 Hz clock.
2. `useLoaderStep()` exposes eight steps over 1.6 seconds through
   `useSyncExternalStore`. `RunningGlyph` consumes it and updates SVG opacity.
   `MatrixLoader` consumes the shared timestamp and changes 16 dot fills.
3. Both indicators already have a definite-size cached island: 14×14 for the
   default matrix and task glyph. Ordinary React parent components do not need
   to re-render just because the subscribing indicator did.
4. Native `RetainedTree::mark_changed_detail` propagates `subtree_revision`
   through **all ancestors** for style changes. `notify_changed_islands`
   therefore wakes both the leaf and its enclosing large content/sidebar island.
   `request_invalidate()` then unconditionally calls root `cx.notify()`.
5. Cached unaffected regions can replay, but the affected enclosing region is
   rebuilt/laid out. GPUI still paints a window Metal frame; this is not a
   separate compositor layer that can animate a small glyph independently.

The current README's phrase that a tick renders only the 16 dots is too strong
for nested islands. Observed counts establish ancestor work.

Final instrumented baseline, `0b0978c5`, current binary:

| Scene | CPU % | GPU ms | MiB | React commits | Island renders / wakes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Home, one running sidebar row | 4.12 | 95.85 | 188 | 77 | 151 / 151 |
| Home, settled only (final direct-entry validation) | 1.40 | 1.28 | 161 | 2 | 1 / 1 |
| Tasks board, no running tasks | 6.91 | 77.80 | 193 | 75 | 150 / 150 |

Intervals were 15.02–15.05 seconds. The settled Home sample had one late island
update, not an ongoing 5 Hz loop. The Tasks sample is exactly consistent with
75 ticks, one React commit and two island renders per tick.

## Parity-preserving cache prototypes (rejected)

No loader was frozen, removed or slowed in these experiments.

| Experiment | Scene | CPU % | GPU ms | MiB | Island renders |
| --- | --- | ---: | ---: | ---: | ---: |
| Add row/column/list cache boundaries | Home, one running row | 6.93 | 107.7 | 184 | 305 |
| Add row/column/list cache boundaries | Tasks | 8.27 | 92.1 | 188 | 1216 |
| Inline both enclosing sidebar/content islands | Home, one running row | 12.89 | 95.10 | 171 | 75 |
| Inline both enclosing sidebar/content islands | Tasks | 7.51 | 79.15 | 190 | 75 |
| Inline only animated sidebar island; retain content cache | Home, one running row | 5.85 | 103.84 | 170 | 76 |

Extra nested caches multiplied renders; removing the enclosing cache reduced
render counters but lost useful static-region replay and increased CPU. A lower
render count alone is not an improvement. All temporary app edits were reverted.
Reproducible rejected diffs are `scripts/idle-rejected-islands.patch` and
`scripts/idle-rejected-inline.patch`. The latter scopes the switch to the active
region; the both-parent variant was the same diagnostic without the page guards.
**Neither patch is recommended for production.**

## Desktop WebKit reference

Actual desktop frontend, same scratch daemon and task titles, 1280×820 at 2×,
Vite development build in headless Playwright WebKit. `document.visibilityState`
was `visible`, CSS animations were running, and the React hook counted commits.
The coalition includes the Playwright browser and its newly launched Networking,
GPU and WebContent XPC processes (their parent PID is 1, so child-PID traversal
alone misses them). Initial browser-parent-only samples were discarded.

| Scene | CPU % (coalition) | GPU ms / 15 s | Footprint MiB | React commits | Live CSS animations |
| --- | ---: | ---: | ---: | ---: | ---: |
| Home, one running sidebar row (focus not parked) | 5.33 | 46.3 | 413.4 | 1 | 12 |
| Home, CSS paused but composer focus not reliably parked | 3.53 | 40.6 | 440.4 | 1 | 0 |
| Home, CSS paused after catalog settlement, focus on body | 0.07 | 0.0 | 375.4 | 0 | 0 |
| Home, one running row, catalog settled and focus on body | 8.40 | 42.5 | 423.4 | 0 | 12 |
| Tasks, empty Running column | 18.80 | 967.3 | 443.4 | 0 | 1 |
| Tasks, repeat in fresh browser | 20.20 | 960.5 | 438.4 | 1 | 1 |
| Same Tasks page, CSS animation paused (diagnostic only) | 0.00 | 0.0 | 406.4 | 0 | 0 |

This is a reference, **not a shipped Tauri/WKWebView benchmark**. It includes
browser hosting overhead and excludes WindowServer. GPUIX steps at 5 Hz;
WebKit's CSS animation cadence and smoothness differ. The data does not support
assuming GPUIX is always more expensive: Home's WebKit GPU time is lower, while
this Tasks animation uses considerably more GPU time in WebKit with no React
commits. Home needs an extra focus control: asynchronous provider-catalog completion
can refocus the composer after an early `blur()`. A second probe recorded a
focused DIV at sample start and still used 48.0 ms GPU; the later paused probe
with BODY focus used 0.0 ms. Thus the initial Home figures include a caret/late
setup confound and are not isolated per-loader deltas. `KYBERN_IDLE_SETTLE_MS`
allows a separate startup-settlement control; focus is parked again after warm-up.
The final running-row control used an additional 30 seconds for catalog settlement,
then the normal 10-second warm-up and 15-second sample. BODY focus and zero
React commits were verified. Its 42.5 ms GPU versus GPUIX’s 95.85 ms is a
useful one-row reference; its 8.40% coalition CPU versus GPUIX’s 4.12% prevents
a blanket claim that either runtime is cheaper. Their motion cadences differ.

The frozen-CSS control confirms that animation drives the measured work; it is
not a proposed UI change. Values rounded to zero are not power measurements.

## Proposed next native experiment

There is no verified production patch to recommend from these app experiments.
The next targeted experiment should distinguish paint-only changes inside a
fixed-size island from geometry/text/structural changes:

- retain full ancestor invalidation for geometry, inherited styling, text,
  children, clipping, selection, overlays and motion that affects layout;
- for a proven paint-only leaf update, notify the smallest island without
  artificially marking all ancestors' subtree revisions changed;
- validate whether GPUI's cached-view dependencies still invalidate ancestors
  through `gpuix.update` during `IslandView::render`;
- measure both native CPU and full-window Metal work. CPU isolation alone will
  not turn the glyph into an independent compositor layer;
- run native cache identity, hover, selection, overlay, scroll, virtual-row and
  late-update tests before suggesting integration.

That requires a new native binary and changes outside this research task's
owned paths. It was not compiled or claimed as a verified fix. Do not merge the
rejected app patches as a substitute.

## Validation and cleanup

- Current `0b0978c5` TypeScript check passed with all measurement scripts.
- `node --check scripts/idle-webkit.mjs` and `git diff --check` passed. All tracked app source changes were reverted.
- No commit, push, stash, reset or rebase. Worktree returned to `gpuix/transcript`.
- All task-owned GPUIX windows, scratch daemons, Vite server and Playwright/XPC
  processes were closed; fixture data/config/credentials were removed.
- Free space: **53 GiB before, 53 GiB after**. No Rust targets or browser
  downloads were created. Existing `native/build` is 46 MiB (including the
  copied current addon), GPUIX dependencies about 225 MiB. The desktop's
  68 MiB Vite cache predates this task (October 15 23:28) and was reused.
  These remain to keep the shared worktree usable. A typecheck invocation via
  pnpm refreshed two already-locked local patch packages; no dependency was added.
- The installed daemon, user application, port 4219 and normal `~/.kybern`
  were untouched. No screenshots, recordings or large new artifacts were produced.

Unresolved: no validated native optimization or shipped-WKWebView comparison.
The delivered desktop reference is explicitly the full frontend in Playwright
WebKit, and the delivered patches are negative experimental evidence only.
