# Live answer isolation and native document adoption

The live answer now updates its own row, with frame-coalesced text event
publication and an optional native Markdown document. The final paired wheel
workload reduced median process CPU from 79.26% to 61.31%, React commits from
629 to 395, and frames over 33 ms from 85 to 24 per 15-second sample. This does
**not** meet the requested steady 60 fps, zero frames over 33 ms, or sub-8 ms
frame cost. The long tail and GPU work still need attention.

## Findings and changes

- `src/transcript/store.ts`, `streamBlocks.ts`, and `rows.tsx`: the previous
  paced block-array update still caused transcript grouping and ancestors to
  render for text growth. A per-owner topology retains its array and live
  placeholder identities until disclosure/grouping changes; the assistant row
  subscribes to canonical text at the existing 66 ms pace. A reconciler test
  with 3,000 historical blocks proves text growth changes the row without a
  parent render. Terminal/provider replacements publish the exact final block.
- `src/subagents/Page.tsx`: the page motion wrapper subscribed to the entire
  open transcript, undoing row isolation. It now selects thread metadata; a
  subscription refreshes outgoing snapshots without rendering. Frozen outgoing
  panes and split-pane captures remain fixed while the active pane streams.
- `src/state.ts` and `eventFrame.ts`: canonical event folding and event
  observers remain synchronous and ordered. Only external-store notification
  for text/thinking deltas is coalesced to one frame. Terminal/control events
  flush immediately. The single frame subscription parks after publication;
  hiding the window flushes and cancels it. The unit test joins 1,000 burst
  notifications into one publication and verifies cancellation.
- `src/transcript/StreamMarkdown.tsx`, `streamDocument.ts`, and `markdown.tsx`:
  one row owns one native document, one worker request, and the latest pending
  source. Superseded replies cannot paint older text. Disposal releases late
  creation and failed updates. Existing caret/fade themes, source fallback,
  bounded expansion, and exact final rendering are retained. The integration
  uses the sibling perf-markdown lane's append-parser API, which retains stable
  semantic blocks and parses the changing tail. Older addons retain the source
  host automatically. No new parser or native patch was added in this lane.

`KYBERN_STREAM_ISOLATE=0`, `KYBERN_STREAM_EVENT_FRAME=0`, and
`KYBERN_STREAM_DOCUMENT=0` independently restore the three controls for A/B.
Default behavior enables isolation/publication and adopts documents when the
addon exposes the API. No edits were made to `Transcript.tsx` or `Window.tsx`.

**Native dependency:** the tested, frozen signed addon SHA-256 is
`10bf708e7c26df2f7b7e9aeba692a6a0b608a1c9259258b6ad7fca7dd21bbf46`.
Both controls used that same binary; these are JavaScript-path comparisons,
not a comparison of two native builds. The optional document path needs the
perf-markdown native API to ship. Source-only fallback was also exercised.

## Workload and final captures

Apple M1, macOS 27.0.1, Bun 1.4.0, 60 Hz Retina LCD,
`KYBERN_FULL_RATE=1`. Real GPUIX development app and shared benchmark suite;
synthetic providers, 20 projects/300 threads, all 1,000 historical turns
(4,002 blocks including the live turn), mixed Markdown/code/tool history.
Every sample warms for 10 seconds, then records resources and frame submissions
for 15 seconds. Streaming produces approximately 25 deltas/second. Wheel input
uses real AppKit contact/momentum packets at approximately 120/second.
All accepted runs have empty native-build markers and no foreign app/fixture
overlap before, during, or after capture. Screenshots are outside timed windows.

| Scenario/control | Runs | Frame p50/p95/p99 ms | >16.7/>33 ms | Max gap ms | Latency proxy p95 ms | CPU % | GPU ms/window | Footprint MiB |
| --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |
| Stream + wheel, before | 3 | 16.88 / 36.99 / 51.23 | 399 / 85 | 62.01 | 31.30 | 79.26 | 2013.5 | 389 |
| Stream + wheel, after | 3 | 16.68 / 30.23 / 57.96 | 382 / 24 | 69.31 | 25.49 | 61.31 | 2391.8 | 363 |
| Stream, before | 1 | 16.62 / 33.81 / 37.13 | 405 / 49 | 43.75 | — | 68.67 | 2539.2 | 368 |
| Stream, after | 1 | 16.66 / 27.76 / 30.82 | 370 / 5 | 35.94 | — | 47.01 | 3074.1 | 367 |
| Idle thread, before | 1 | 17.89 / 17.89 / 17.89 | 1 / 0 | 17.89 | — | 2.19 | 7.5 | 235 |
| Idle thread, after | 1 | 34.99 / 34.99 / 34.99 | 1 / 1 | 34.99 | — | 3.32 | 5.4 | 238 |

Rows are medians of per-run values, including counts (not pooled percentiles).
Wheel input rates were 119.82–119.86 before and 119.91–119.99 after;
stream rates were 25.06–25.07 before and 25.07–25.13 after. The stream-only
pair produced 25.13 deltas/second in both controls. One stream-only run per
control is directional evidence, not a confidence interval. The latency column
is an offered-input-to-scene-submission receipt proxy, not a physical display
presentation fence. No energy savings or battery-life claim is made.

Both idle controls submitted only **two scenes** and made three React commits;
their interval percentiles therefore describe a single gap and are not an
idle frame-rate estimate. Zero idle submissions are not achieved by the full
app in this capture. The added event publisher has no idle frame listener or
timer, as checked separately by its scheduler test. Idle CPU differs by 1.13
points, below the suite's three-point threshold.

Wheel native render p95 was 9.47 → 10.22 ms; layout p95 was 2.21 → 3.76 ms.
Average whole-process CPU time per submission was 15.53 → 11.03 ms, and GPU
time per submission was 2.66 → 2.92 ms. These are distinct measurements and do
not prove 120 Hz readiness. Wheel p99 and maximum gap worsened despite fewer
long frames; GPU totals increased. Those regressions remain visible in the raw
results and must be considered during integration with perf-scroll2.

## Staged experiments

The same corrected full-history wheel workload was measured after each step
(one accepted 15-second sample per stage, same addon, all full-rate).

| Stage | Frame p50/p95/p99 ms | >16.7/>33 ms | Latency proxy p95 ms | CPU % | GPU ms | MiB | React commits |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| Before | 16.73 / 35.93 / 50.09 | 398 / 77 | 27.56 | 79.67 | 2176.6 | 369 | 633 |
| Isolated row and page | 16.67 / 30.76 / 64.99 | 371 / 34 | 26.28 | 57.32 | 2528.8 | 354 | 392 |
| + Frame publication | 16.68 / 29.71 / 67.44 | 395 / 31 | 28.89 | 59.38 | 2431.5 | 364 | 406 |
| + Document adapter | 16.70 / 27.72 / 52.06 | 430 / 23 | 23.84 | 59.19 | 2483.2 | 370 | 405 |

Most of the CPU reduction comes from isolation. The later stages did not show
a separate CPU saving above the suite's three-point noise threshold. Their
single-run frame differences are not strong causal evidence. The existing live
Markdown cap (32 lines/8,192 characters) is unchanged; its first chunk becomes
stable before most of the resource window, limiting this workload's ability to
measure append-parser reuse. Document correctness and lifecycle are verified,
but a large live-tail parser CPU win is **not** claimed here.

Discarded trials are preserved under the external evidence folder: a rejected
10,000-entry history request (fixed to bounded 500-entry pages), an exploratory
short running thread, earlier producer backpressure that lowered offered
deltas, early AppKit probes that checked the anchor before paint and fell back
to RPC input, and preflights rejected for native-build/foreign-app overlap.
They are excluded from the tables. The corrected AppKit probe waits 100 ms for
paint, and catch-up production preserves offered stream rate under load.

## Appearance and regressions

Evidence root:
`/Users/mymac/projects/ade/previews/gpuix/perf/stream/`.

- `visual/{before,after}-{dark,light}-{0,1}-{live,final}.png` covers both themes
  and reduced motion. `visual/pixels.json` reports **zero changed pixels** for
  each final comparison at 2560×1640, excluding the outer four-pixel window
  border. Live captures retain native caret and fading words; their animation
  phases are not used as a pixel-equality assertion.
- `verify-after-final.log`: all four real Transcript variants paint heading,
  strong/emphasis, link, list, quote, table, highlighted code, and exact Unicode
  final text. The native document count is one while live and zero after
  completion. `verify-before-retry.log` covers the source fallback controls.
- `regressions.log`: transcript reveal verifier, stream9 in four modes, split
  and frozen panes, collapse/unmount/reopen, long-code expansion with restored
  scroll anchor/lightbox, and subagent prompt verifier all pass. Normal-motion
  stream9 captures retain roughly 60 fps; reduced motion intentionally parks
  between content updates. These diagnostics are separate from final timings.
- `typecheck-final.log`, `bench-typecheck-final.log`,
  `harness-typecheck-final.log`: source and both harness typechecks pass.
  `tests-final.log`: **328 tests, 6,850 assertions, zero failures**.
  `bench-tests-final.log`: shared benchmark model tests pass.
  `node --check perf/bench/webkit.mjs` and `git diff --check` pass.

No native patches/builds were made here. Unrelated project/task drag and PR
surfaces were not revalidated; their code was not changed.

## Reproduction and remaining limits

Use `perf/stream/pair.ts` for the four staged controls, or
`bun perf/stream/pair.ts before documents --final --wheel` for three wheel
samples per control. Omit `--wheel` for the one-run stream-only pair. Set the
scratch environment and approved native addon as in the shared bench README.
`quiet.ts` owns the bounded quiet-window reservation; `final.ts` runs the
final controls, and `resume.ts` only repeats unfinished controls after a guard
expires. `with-lease.ts` runs correctness checks under one bounded UI lease.
All wrappers terminate their registered children on interruption.

Committed raw snapshots and source hashes are in `results/`. The initial wheel
launch manifest was written at 08:12Z before the final stale-reply guard at
08:13:24Z; `results/source.json` records the reviewed source used by actual final
app launches after 08:20Z. The 24-minute quiet guard expired after both streaming
pairs completed while idle controls were queued. The orchestrator authorized
one renewal; both idle controls completed in that fresh window, which was
released immediately. `quiet-first.json`, `quiet.json`, `final.log`, and
`final-resume.log` preserve that history in the evidence folder.

Strict acceptance remains open: 24 median wheel frames over 33 ms, 57.96 ms
wheel p99, 61.31% wheel CPU, and native render p95 over 10 ms. Full-window native
work, dense transcript slots, and topology's remaining cheap identity scan
need the parallel scroll2 integration and another combined measurement. No
claim is made that CPU is below half the control or that there are no stalls.
The original historical 56.7 ms / 57% observation uses a different workload;
it is not the denominator for these within-addon comparisons.

## Cleanup

Free space on the shared volume was 85 GiB before this lane's heavy work and
81 GiB after cleanup; concurrent lanes also generated build output, so this is
not a measurement of this lane's net disk consumption. Removed the disposable
GPUIX and desktop dependency installs (188/633 MiB), scratch dataset (130 MiB),
and copied document-capable addon (26 MiB). No Rust target was created. The
pre-existing signed addon/dylib in `native/build` remains (25 MiB), as supplied
with the worktree. Evidence remains in the requested external folder; generated
binaries, dependencies, recordings and scratch data are not committed. All
lane-owned apps, daemons, samplers, lease/quiet markers and queue lines are gone.
