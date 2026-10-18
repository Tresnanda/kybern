# Combined native validation — October 18, 2026

The combined addon builds and passes the native suite without changing any
native patch. The original “pressed button did not shrink” assertion did not
establish a transform regression: the preserved failing captures have a black
content area, with only the AppKit titlebar visible.

## What the evidence establishes

All eight retained/full images and the press-down image from the original
failed region trial have the same SHA-256. Comparing those blank captures
therefore gave a vacuous pixel-parity pass before the press assertion failed.
`original-capture-analysis.json` records the nine hashes. The new capture guard
rejects that exact original image and accepts a painted press capture from the
same addon (`capture-regression.log`).

The original combined addon (`7ec2b637…`) subsequently passed all four modes
under an exclusive UI lease. A freshly built all-four-lane addon also passed
`native/update.sh` end to end before any edits. Before fixture isolation, a
scroll2-only control independently produced a black press-down capture; its
new explicit error is preserved in
`repeats-before-isolation/scroll2-idle-region0-01/`. Thus the black incident is
not exclusive to combining Markdown with scroll2.

The original lab ignored physical clicks but still accepted physical mouse
moves. Additional diagnostic repetitions hit the existing no-render/no-island-
wake assertions. The fixture now also disables AppKit mouse-moved delivery,
matching `subtree-translation-lab.tsx`; native automation still dispatches its
mouse down/up, hit-testing and click events directly. No assertion was weakened.

**Limit:** the cause of the original missing Metal presentation remains
unproven. Input isolation removes an identified test-contamination path; the
results do not prove that physical motion caused the historical black surface
or that a production GPU fault was fixed. No speculative native change was made.

## Repeated final check

`python3 perf/combine/repeat.py --repeats 10` runs the complete transform check,
not a press-only replacement. Every check gets its own bounded fair UI lease.
The CPU condition starts four busy SHA-256 worker processes inside that lease
and reaps them afterward. The check and its fixtures run at `nice -n 15`.
`KYBERN_FULL_RATE=1`; region painting is tested both off and on.

| Addon | Idle mode runs | CPU-load mode runs | Failures / black captures |
| --- | ---: | ---: | ---: |
| All four lanes | 80 | 80 | 0 |
| scroll2 control | 80 | 80 | 0 |
| Markdown control | 80 | 80 | 0 |

This is 480 successful fixture runs: ten repetitions of each dark/light ×
normal/reduced × region-off/on combination, separately at idle and under CPU
load, for each addon. All retained/full comparisons, transformed hit tests,
native press/release, fixed layout slots, render/island counters and animation
checks remain enabled. The matrix took 74.13 minutes.
`repeat-results.json` retains every case; `repeat-summary.json` checks all 48
buckets have exactly ten runs. Its cadence numbers are correctness diagnostics,
not a performance or resource comparison.

## Changes

- `native/clip-pixels.ts`: a sampled nonblack-content assertion for fixtures
  with a known nonblack fill; excludes AppKit chrome and rounded window edges.
- `native/subtree-transform-check.ts`: check every OS capture before using it
  for pixel parity or press assertions; retain the original failure image.
- `native/subtree-transform-lab.tsx`: match the translation lab's physical
  pointer isolation. Automation input remains enabled.
- `perf/combine/repeat.py`: reproducible complete-check/control/CPU matrix.

Native patch files: **none changed**. In particular, the cached draw/paint and
rollback-generation guard, sparse lists, motion reconciliation, native Markdown
documents, image/atlas eviction and arena/Taffy trimming are retained.

## Integration checks and evidence

Evidence root: `/Users/mymac/projects/ade/previews/gpuix/perf/combine/`.

- `native-update-initial.log`: the first clean combined build and full suite.
- `native-update-final.log`: the final full updater run with the strengthened
  capture check and isolated fixture (final status recorded in `validation.json`).
  Includes Markdown document/cost checks, transform with region off/on,
  clip/Explorer-motion/scroll8/input checks and standalone Rust tests.
- `combine-cache-fixed-{0,1}.{log,json}`: four older-history paging/navigation
  repetitions in each dense/sparse control, all eight successful without panic.
  These one-second diagnostic samples are not performance acceptance data.
- `ui-lease-check.log`: interruption stops the command and its grandchild;
  normal exit also releases its queue line/lock.
- `bun-tests.log`: 332 source tests, 6,872 assertions, zero failures.
  Application and native TypeScript checks pass.
- `smoke/{home,transcript}-{dark,light}.png`: actual app smoke captures with
  `SETTLE_MS=3000`, own scratch daemon on port 4333, 300 synthetic threads across
  20 projects, and a 1,000-turn mixed-content transcript with the sidebar visible.
  `smoke/manifest.json` records the workload. No provider was executed.

The final addon is the same bytes used in the repeated matrix:
`f7c8af1c2f2558f6c1a5a3ce93b274cfaf5676ebb87ac438d0ad29d45960dc10`.
It is left at `native/build/gpuix-native.darwin-arm64.node`, with its runtime
webview companion. The native build used four Cargo jobs, an empty rustc wrapper,
no incremental compilation, and the lane's own target directory. The build
marker covered the entire updater, including all checks.

Cleanup/free-space receipts and final commit are in the evidence's
`cleanup.json` and `validation.json`. Native targets/upstream, disposable package
installs, intermediate binaries and scratch daemon data are removed after
validation; source/worktree registrations and the final runtime artifacts remain.
The installed daemon, normal user data and other checkouts are preserved.

Free workspace-volume space: **83.64 GiB before → 82.79 GiB after**.
The immediate cleanup reading was 80.74 → 82.79 GiB; directory
sizes are not claimed as reclaimed blocks on this shared APFS volume.
