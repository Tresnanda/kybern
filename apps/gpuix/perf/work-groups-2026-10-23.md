# Work runs in the transcript: compact rows, chips, zeron arrivals (ADE-54..58 L5, 2026-10-23)

What changed: a turn's agent work now folds into one compact row per gap between two pieces of narration
(`chunkRuns`, `apps/desktop/src/lib/workChunks.ts`), instead of a row per settled group, per lone call, per failure and per
"Thought". The row is chevron-first, 13 px muted: "Edited 1 file · ran 1 command · read 2 files · searched 1 time"; while
live, its counts swap in place (no blur) and its tail shimmers with the call in flight ("· reading Requests.tsx") or
"· thinking" between calls. Opened, every call is a verb and a chip on the tree (`src/transcript/WorkRun.tsx`). Members
arriving in an open run fade and rise 4 px over 360 ms ease-out-expo, 65 ms apart, connectors drawing over 480 ms; a new run
after narration waits 90 ms. Everything is `paintTransform` (tier 1), fresh rows only, keyed by the run's first block.

## Workload and method

- Fixture: the full app on the glass scratch daemon (`perf/glass/`), Solid dark, 1000×900 on the hidden test display, patched
  addon `L1/gpuix-native.darwin-arm64.patched-backdrop-alpha.node`, `KYBERN_FULL_RATE=1`.
- Turn: `perf/bench/workTurn.ts` through the production `applyEvent`, 25 events/s (one per 40 ms), on top of 44 historical
  ticks. Per 15-tick segment: three reasoning deltas, its end, two narration deltas, the message, four calls (Read, Grep,
  Edit, Bash) started and finished; every seventh call fails. The same generator drives `KYBERN_BENCH_STREAM_WORK=1` in
  the shared bench.
- `src/transcript/work.perf.ts --before 84d44d0dd`: A B B A, `before` = the GPUIX and kybern-client sources of 84d44d0dd
  served by `perf/glass/baseline.ts` (so `apps/desktop/src` is the new one in both: the old rows show the new " · " copy, no
  other effect), `after` = this branch. 8 s warm-up, three 10 s windows per run. Scene-submission intervals, full draws with
  render/layout ms (`KYBERN_FRAME_COSTS`), React commits, app CPU/GPU/footprint (`perf/sample.ts`), mounted host elements and
  components under the transcript (`counters`, a fiber walk after each window), delivered events (`tick`).
- `--open` opens every run as it mounts (worst case for the new rows: every chip mounted).

## Results

**Frame intervals, draw cost, CPU and GPU** (review pass, 2026-10-23, display awake: `locked: 0 displayAsleep: false
testDisplay: ready`). A B B A, three 10 s windows per run after an 8 s warm-up; the table is the mean over the six windows of
each variant (`KYBERN_DATA_DIR=<gpuix-scratch>/l5-work/data NAPI_RS_NATIVE_LIBRARY_PATH=<patched addon> bun src/transcript/work.perf.ts --before 84d44d0dd [--open]`). Raw rows: `.kybern-artifacts/ade-54-58/review2/perf/work-perf-{closed,open}.json` and `.log`. The first L5
attempt and the review's first rerun read no frames at all: `work.perf.ts` sampled with a blocking `execFileSync`, so the
app's `[kybern-submit]`/`[kybern-work]` lines were only parsed after `t.result` had read the window (React commits, counted
later, looked fine). The sampler is asynchronous now; those runs are in `review2/perf/invalid/`.

| Runs | Variant | Frame p50 / p95 / p99 ms | > 33 ms per window | Full draws | Render p50 / p95 ms | Layout p95 ms | React commits | CPU | GPU ms / 10 s | Footprint | Events by the last window |
|---|---|---|---:|---:|---|---:|---:|---:|---:|---:|---:|
| closed | before | 16.8 / 34.6 / 100.3 | 45 | 313 | 18.2 / 22.0 | 9.6 | 610 | 72.3% | 1,545 | 362 MiB | 824 |
| | after | 16.7 / 32.6 / 64.7 | 36 | 202 | 13.5 / 17.1 | 8.8 | 560 | 46.4% | 1,439 | 317 MiB | 940 |
| all open | before | 67.1 / 99.1 / 128.3 | 125 | 139 | 69.9 / 86.1 | 66.7 | 240 | 99.1% | 624 | 392 MiB | 506 |
| | after | 16.5 / 89.0 / 113.1 | 118 | 129 | 62.5 / 72.8 | 44.9 | 334 | 94.1% | 689 | 461 MiB | 587 |

Closed (the default, what a reader sees while an agent works): no regression; app CPU falls by about a third (72% → 46%),
frame p99 from 100 to 65 ms, a third fewer full draws, each about a quarter cheaper, 45 MiB less footprint, and the shared JS
thread keeps up with more of the feed (940 events delivered against 824). Frame p95 is unchanged within noise (both sit on
the 60 Hz test display's 16.7 ms cadence half the time). All open (the opt-in worst case: every chip mounted): both variants
saturate one core; the new rows deliver 16% more events with better frame, render and layout percentiles, at about 14% more
host elements per delivered event (5.8 against 5.1) and ~70 MiB more footprint by the last window. That cost is the chips;
nothing to fix for the stream itself.

**Mounted elements (structural, independent of the display).** Host elements and components under `transcript-surface` after
each window, against events delivered so far (the fixture thread's own history included):

| Runs | Variant | Events | Host elements | Components |
|---|---|---:|---:|---:|
| closed (default) | before | 347 | 1,020 | 1,257 |
| | after | 292 | 554 | 632 |
| | before | 442 | 1,199 | 1,494 |
| | after | 469 | 749 | 879 |
| | before | 789 | 1,873 | 2,454 |
| | after | 756 | 1,019 | 1,228 |
| all open | before | 512 | 2,624 | 3,302 |
| | after | 595 | 3,510 | 4,263 |

Closed (what a reader sees while an agent works): about 40–46% fewer host elements and components at a comparable
number of events, and the gap grows with the turn: the old rows mounted a "Thought" row, a failure row and a group or lone
call row per gap; the new ones mount one run row. Every run held open costs ~15–20% more per event than the old open groups:
each chip is an ink well, an icon well, an icon and a label. That is the opt-in case (a reader opening runs), not the stream.

**Renders per event.** A streamed event re-chunks the turn, but runs whose members did not change keep their chunk object and
skip their render; only the run that grew (or whose call settled) recounts its summary, and only the run ending in streaming
reasoning sees `liveThinkingId` (`rows.tsx` `WorkRows`). The old live rows remounted a `Rise` per call and a blurred
"Thinking" row between calls; a run's group key changed when a second call joined it (a remount). Neither happens now.

An earlier 5-second A B B A probe (display state changing during the run, so diagnostic only) read 56–58% CPU, ~298 MiB and
~375 React commits per 5 s before against 37–39%, ~262 MiB and ~285 after, at the same delivered events (350 vs 358).

**Motion** (`L5/sheets/strip-*`, native clock paused, frames every 50 ms): a call arriving in an open run is invisible at 0,
mostly in by 100 ms (ease-out-expo) and at rest by 150–200 ms, its connector's elbow turning into a tee; a new run after
narration waits 90 ms and is at rest by ~200 ms. No blur pass on any of them (the old live rows blurred in). Reduce Motion:
a 150 ms fade, no rise or draw (`L5/after-reduced/`).

## Limits

- One machine (M-series, macOS 27), one workload, synthetic events; no provider runs. The feed shares the app's JS thread,
  so a slow app delivers fewer events: compare per delivered event as well as per second.
- A display that sleeps stops GPUI's frames and throttles the app's timers; such runs are discarded (the screen state is
  recorded in every row). The shared bench (`bun perf/bench/run.ts streaming` with `KYBERN_BENCH_STREAM_WORK=1`) refuses to
  run on a sleeping display for the same reason.
- No energy or 120 Hz claim.
