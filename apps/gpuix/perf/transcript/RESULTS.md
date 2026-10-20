# Transcript rendering and scrolling, 2026-10-18

This lane implements bounded rich bodies and per-row geometry reuse. The strict
60/120 Hz acceptance target remains an explicit measurement gate, not a claim
based on lower memory or a smaller native layout number.

## Workload and measurement limits

Apple M1 with 16 GiB RAM, macOS 27.0.1 (26A434), Bun 1.4.0, GPUIX 0.10.0, 1280×820 opaque
window, dark normal motion, 60 Hz Retina LCD. Every timing below uses
`KYBERN_FULL_RATE=1`, `KYBERN_FRAME_TIMES=1`, `KYBERN_FRAME_COSTS=1` and
`KYBERN_INPUT_FRAME_DRAW=0`. Each active sample follows 10 seconds of warm-up
and samples CPU, AGX process GPU time and physical footprint for 15 seconds;
idle follows an additional 10 seconds of settling. Daemon and WindowServer are
excluded. CPU is percentage of one core; AGX time is not GPU utilization or
energy. Differences below roughly three CPU points need repeats.

The fixture loads all 1,000/3,000 turns at once: GFM tables/quotes, Unicode,
TypeScript and diff fences, 160-line expandable fences, tool calls, and images.
The live case adds formatted text every 80 ms. Source before is `9befd131`;
both variants use the same final addon. Before disables transcript layout
reuse/coalescing; after uses bounded bodies, reused slots, buffered mount
windows, row geometry reuse and the existing `pr` coalescer. Transcript cached
islands are disabled in the final default, preserving fresh prepaint/bounds.

Both sources receive the same 1,800 indexed native AppKit wheel packets per
active sample, including contact/momentum phases, smooth bursts and fast
flings. The shared bench lane supplies the small event injector. No screenshot
or synthetic clock step occurs in valid timing samples. Build markers are
watched throughout each run; process inventories before/after each scene reject
foreign app/fixture/lab processes. The quiet-window record and raw per-run
inventories are retained with the evidence. Timings from 05:16–05:32 UTC are
excluded; exploratory wall-time input/RPC tests are not mixed into this table.

120 Hz is the requested delivery schedule, not a guaranteed admitted rate.
Backpressure can extend delivery beyond 15 seconds. Submission intervals and
counts cover that complete delivery/observation window; resource readings cover
the first 15 seconds. Delivery duration is reported separately. No submitted
frames means a stalled workload, not a zero-cost or successful frame result.

Intervals are native scene-submission intervals, not physical presentation
fences. Dispatch→CPU-paint excludes OS/transport queueing and GPU presentation;
it is not input-to-photon latency. First formatted content includes process
startup, fixture construction and the automation observation. This is a
transcript fixture, not whole-app startup or daemon paging latency.

## Findings

The native list bounded paint but retained every rich React body. In the final
headless fixture, 1,000 turns allocate 92,350 hosts before versus 12,227 after;
3,000 turns allocate 277,030 versus 36,227. Markdown/code hosts go from
2,000/2,000 and 6,000/6,000 respectively to five/five in either windowed case.
These are headless structural counts, not native physical-footprint readings.
The unit ownership check independently verifies bounded bodies/observers,
stable slots and selected/overlay owners across large logical jumps.

The matched five-second native samples show retained-tree render scans,
hashing, motion/transform synchronization and element/list work in the
baseline. Syntax parsing is not a leading sampled hotspot. For example, the
1,000-turn baseline's collapsed top-of-stack table records 899 self samples in
`GpuixView::render` and 582 in hashing, versus 13 and 26 in the final sample.
Those are sample counts, not percentages or a normalized speedup. The raw
profiles are `baseline-final-fixed-1000-dark-sample.txt` and
`final-fixed-1000-dark-sample.txt`.

Native geometry reuse formerly keyed every row by the list revision, so a live
sibling invalidated settled geometry. Native visible-range notifications could
also remain unchanged after a programmatic jump. Disposing the old bodies then
left no observation able to reveal the destination. A permanent changed-only
list-anchor observation fixes that gap. The old rail could stay on message zero
after initial follow-tail; its highlight now follows the actual native anchor.

## Implementation

| Files | Change |
|---|---|
| `src/Transcript.tsx` | Stable logical slots with measured heights; cached unchanged turn/slot elements; stable message-ID rail position; reveal destination before centering/restore; existing prepend/follow behavior retained. |
| `src/transcript/Window.tsx`, `windowRange.ts`, `src/kit/windowRange.ts` | Pixel-based buffered rich-body window; one changed-only native list observation; bounded per-mounted-body observations; focus, selection, entrance, resize and overlay leases; finite settling callbacks, no recurring windowing clock. |
| `src/transcript/store.ts`, `rowStateScope.ts` | Additive transcript-owned disclosure retention beyond the existing 2,000-entry fallback. Paging/data logic is untouched. |
| `Turn.tsx`, `bubble.tsx`, `images.tsx`, `MermaidBlock.tsx`, `Visual.tsx`, `markdown.tsx`, `motion.tsx` | Instance refs for rail centering; preserve open overlays and selected/fresh content; do not replay entrances on body remount. Visited interactive HTML owners remain mounted to preserve arbitrary document state. |
| `src/transcript/scroll-layout.ts` | Opt into native per-row layout reuse and coalesced input; cached transcript islands remain an experimental control after a correctness failure. |
| `Window.test.tsx`, `windowRange.test.ts`, `rowStateScope.test.tsx`, `split.verify.ts` | Ownership/large-jump/selection/disclosure tests; split fixture uses its immediate mock endpoint, avoiding real daemon discovery. |
| `perf/transcript/` | Synthetic fixture, baseline loader, process-safe leases/build wrapper, matched AppKit runs, source/pixel comparisons, summary and final orchestration. |

Native changes are separate:

- `native/patches/transcript_scroll_hooks.py`, appended through one hook in
  `apply_hooks.py`: use each retained row's subtree revision in the scroll8
  cache key. Existing inherited style, width/scale, topology and measured-leaf
  validation stays in place; prepaint/paint remain fresh.
- The same patch adds logical list anchors to changed-only post-paint bounds
  observations, including the retained-translation observer path.
  `src/native/layout.ts` mirrors the additive optional payload.
- `native/update.sh` includes stroke checking in its existing UI lease;
  `stroke-draw-lab.tsx` keeps only its own test window visible without
  activation, fixing covered/black OS captures. `native/README.md` documents
  the observer/cache contract and the transcript-island limitation.

The cached-island experiment was removed from the default after the native
large-jump/image-overlay check hid the message rail through stale endpoint
bounds. It remains an explicit comparison control, not a supported performance
default. Wall-time AppKit scheduling and the backpressured RPC experiment are
retained as exploratory evidence only. P4 syntax-document work was not added:
scroll samples point to React/native element and layout work rather than
repeated syntax parsing. No package or version changed.

## Final results

| Turns / scene | Variant | Frames | p50 / p95 / p99 ms | >16.7 / >33 | Dispatch→paint p95 ms | CPU % | GPU ms / 15s | MiB |
|---|---|---:|---|---|---:|---:|---:|---:|
| 1000 / scroll | before | 45 | 19.28 / 87.46 / 2199.24 | 42 / 5 | 23.57 | 95.11 | 37.9 | 739 |
| 1000 / fling | before | 89 | 18.98 / 2217.49 / 2248.24 | 81 / 12 | 18.85 | 100.72 | 80.8 | 740 |
| 1000 / idle | before | 0 | — / — / — | 0 / 0 | — | 4.65 | 0.0 | 721 |
| 1000 / scroll | after | 707 | 16.68 / 18.75 / 26.11 | 335 / 5 | 16.31 | 20.52 | 750.7 | 378 |
| 1000 / fling | after | 717 | 16.68 / 18.69 / 23.19 | 342 / 7 | 16.58 | 25.97 | 688.5 | 373 |
| 1000 / idle | after | 0 | — / — / — | 0 / 0 | — | 3.86 | 0.0 | 363 |
| 3000 / scroll | before | 1 | — / — / — | 0 / 0 | 70.69 | 93.80 | 0.0 | 1743 |
| 3000 / fling | before | 4 | 60.30 / 60.33 / 60.33 | 3 / 3 | 59.58 | 100.12 | 3.6 | 1787 |
| 3000 / idle | before | 0 | — / — / — | 0 / 0 | — | 6.37 | 0.0 | 1712 |
| 3000 / scroll | after | 670 | 16.66 / 22.02 / 51.12 | 269 / 15 | 20.48 | 32.26 | 850.4 | 618 |
| 3000 / fling | after | 694 | 16.67 / 30.82 / 49.91 | 291 / 21 | 17.91 | 32.83 | 722.2 | 616 |
| 3000 / idle | after | 0 | — / — / — | 0 / 0 | — | 3.72 | 0.0 | 607 |
| 1000 / stream | before | 25 | 25.19 / 2129.25 / 7218.01 | 21 / 11 | 22.84 | 96.86 | 18.3 | 967 |
| 1000 / stream | after | 678 | 16.85 / 56.67 / 81.09 | 365 / 111 | 37.57 | 57.31 | 630.9 | 387 |

| Turns / scene | Variant | First formatted content ms | Input delivery s | Native render / layout p95 ms | React p95 ms | Commits |
|---|---|---:|---:|---|---:|---:|
| 1000 / scroll | before | 2079 | 15.04 | 23.47 / 1.13 | 17.79 | 4 |
| 1000 / fling | before | 2079 | 15.06 | 19.07 / 0.93 | 17.48 | 7 |
| 1000 / scroll | after | 1142 | 15.00 | 6.13 / 0.52 | 10.95 | 32 |
| 1000 / fling | after | 1142 | 15.00 | 5.37 / 0.72 | 6.00 | 58 |
| 3000 / scroll | before | 4609 | 41.45 | 70.66 / 0.87 | 49.24 | 1 |
| 3000 / fling | before | 4609 | 41.38 | 59.73 / 0.96 | 61.22 | 2 |
| 3000 / scroll | after | 1889 | 15.00 | 14.00 / 0.51 | 20.96 | 29 |
| 3000 / fling | after | 1889 | 15.00 | 9.33 / 0.60 | 18.66 | 48 |
| 1000 / stream | before | 2556 | 15.17 | 22.83 / 1.51 | 85.60 | 9 |
| 1000 / stream | after | 1228 | 15.00 | 14.64 / 7.83 | 13.10 | 428 |

The requested steady 60 Hz, zero intervals over 33 ms, and sub-8 ms whole-frame
CPU gate is **not met**. The final 1,000-turn scroll/fling p95 is 18.75/18.69 ms,
but still has five/seven intervals over 33 ms. At 3,000 turns it is
22.02/30.82 ms with 15/21 such intervals; native render p95 alone is
14.00/9.33 ms and React p95 is 20.96/18.66 ms. The live tail is the largest
remaining frame-tail problem: p95 56.67 ms and 111 intervals over 33 ms.
Render, layout and React distributions overlap; do not add their percentiles.

The retimed 3,000-turn baseline is severely stalled: one scroll submission in
41.45 seconds and four fling submissions in 41.38 seconds, despite all 1,800
packets being accepted in each. Its zero scroll threshold counts mean there
are no interval pairs to count, not smoothness. The three observed fling
intervals also omit the long period with no submissions. That workload is not
a usable finite-percentile baseline. The final source processes the same
packet sequence in 15 seconds with 670/694 submissions, 32.26/32.83% CPU and
618/616 MiB footprint versus 93.80/100.12% and 1,743/1,787 MiB. The 1,000-turn
scroll footprint falls 739→378 MiB, and live footprint 967→387 MiB.

GPU process time increases because the final source submits far more actual
frames while the baseline stalls. This is not evidence of lower active GPU
cost, energy savings or a per-frame GPU budget. Settled idle remains zero
submissions, zero React commits and zero sampled GPU time in both lengths.
The idle CPU differences are below the repeat/noise threshold.

The first final quiet window lasted 16m52s; its 1,000-turn and live samples are
retained. The first final 3,000-turn candidate accepted input but produced no
native render work and no submissions; it was rejected, preserved under
`rejected-3000/`, and excluded from these tables. Untimed AppKit/RPC anchor
probes moved correctly with coalescing enabled and disabled; they did not
establish the cause of that failed capture. The harness now rejects no-work
captures and records an anchor-movement readiness probe after warm-up, then
normalizes both sources to the tail. The replacement 3,000-turn pair passes
that probe and formatted-output checks, with real native render work. Its
second ordered quiet window lasted 4m47s including UI-queue wait; the actual
UI batch remained below five minutes. The queue reservation is released.

The same native addon and fixture hashes are used throughout. Original
1,000/live harness provenance is in `build-manifest-final.json`; readiness
probe and retime harness provenance is in `build-manifest-retry.json`.
`final-timing-3000-retry.log` is the authoritative 3,000-turn log; the older
`final-timing-3000.log` is explicitly rejected evidence. The 1,000/live runs
precede the readiness addition and have real native work/submissions and
formatted-content checks. This is one paired final sample per workload,
not a repeated statistical confidence claim.


## Correctness and evidence

Evidence root: `/Users/mymac/projects/ade/previews/gpuix/perf/transcript/`.

- `native-update-final.log` / `native-passed.json`: final low-priority four-job
  rebuild and complete native capability suite passed end to end.
- `final-correctness-all.log`: transcript/convo9 long-code, restored anchor,
  image lightbox, subagent prompt, split/frozen panes, disclosure lifecycle,
  exact final Unicode streaming and normal/reduced streaming motion.
- `final-verify-{0,1}.log`, `verify-{dark,light}-{first,middle,tail,pinned-image}.png`
  and `compact/`: first/middle/tail rail jumps, direct large programmatic jumps
  without a wheel nudge, offscreen image owners and selection retention.
- `p1-visual/<theme>-<reduced>-{0,1,window}-<step>.png`: baseline/final source
  and windowed cache-off controls, both themes and normal/reduced motion, four
  wheel positions per mode. `final-pixels.log` records every comparison. The
  baseline's stale rail highlight deliberately differs after its correction;
  content pixels must match exactly. All 16 source content comparisons have zero
  changed pixels; the corrected rail differs by at most 208 device pixels. All
  16 windowed cache comparisons also pass with zero changed pixels. The
  windowed cache-off control requires
  exact pixels including the rail. Only the outer four device pixels and
  bottom corner chrome are omitted from comparisons.
- `comparison-final.json`, `final-timing-{1000,3000,stream}.log`, corresponding
  JSON/raw logs/profiles/process inventories, `quiet-window.json`, and
  `build-manifest-final.json`, `build-manifest-retry.json`, and
  `quiet-window-retry.json`: timing provenance. Use the retry log for 3,000 turns.
- `typecheck.log`, `harness-typecheck.log`, `native-typecheck.log`, `tests.log`:
  TypeScript checks and source suite. Final source suite: 305 passed, zero
  failed, 5,733 assertions across 42 files.

The native suite also covers PR scrolling/coalescing, rounded clipping,
Explorer motion, pointer/selection, springs, cached islands, transforms, syntax,
and text/editor geometry. This lane did not repeat a physical-pointer task or
project drag, real hardware trackpad session, VoiceOver session, or the complete
whole-app tooltips/toasts matrix.

## Remaining limits and handoff

Rich bodies and observers are bounded, but lightweight native slots, React
fibers and the transcript's row/slot arrays remain proportional to loaded
history. Mount-window transitions still reconcile that structure. A sparse
native child range with stable offscreen height/key metadata is the next
structural step; it needs anchor, selection, focus and disclosure semantics
before replacing the dense slots. Active streaming also requires React work
for its changing tail. Cached-island bounds replay needs a separate fix before
the transcript can use it safely.

Visited interactive HTML cards are an explicit exception to the body bound;
retaining their owners preserves arbitrary embedded WebKit state. Disclosure
state is small per-row data, not a byte-budgeted whole-history cache. Native
allocation/graphics high-water behavior is not solved here. No physical
input-to-present or 120 Hz hardware result, per-command GPU timing, energy
measurement, or end-to-end earlier-history paging speedup is claimed.

Product commits: `aa247740` (native), `365052b8` (transcript). Branch:
`gpuix/perf-transcript`, base `9befd131`. The final handoff commit is reported
with the completion message.

## Cleanup and reproducibility

Free workspace space was 84 GiB when this agent resumed and immediately before
cleanup, and 86 GiB afterward (`df -h`). Other lanes share the volume, so this
whole-volume difference is not an exact attribution of reclaimed bytes. Before
removal, process inventories and `lsof +D` found no lane fixture/build/lease or
open file in the build, upstream or disposable dependency directories.

Removed this lane's native target (~1.8 GiB), generated upstream checkout
(~254 MiB), GPUIX/desktop disposable dependency installs (~188/633 MiB), backup
addon, native test executables, redundant captures and scratch controls/injector.
No scratch daemon was launched. The 269 native evidence files (20.7 MiB) were
preserved under `native-update-final/` before their local build copies were
removed. The task evidence root totals about 180 MiB and stays outside commits.

Retained only the validated addon (26,123,344 bytes) and WebKit dylib (103,024
bytes), about 25 MiB total, in ignored `native/build/` for binary provenance and
native integration inspection. No generated Cargo target remains. Reference
research clones remain shared and untouched; the source worktree/branch and
user application/data are intact. Dependency reinstall and a new scratch data
directory are required to rerun fixtures.

No lane app, build, lease or timing process remains. The lane quiet file,
quiet-next reservation and quiet-order entry are absent. `cleanup-final.json`
records the file actions and disk reading. Source/harness/native typechecks,
305 source tests, native update, interaction and pixel checks passed before
cleanup; the final base-to-head whitespace check passes. The only changes
after those checks are result documentation and removal of trailing blank
lines from two files. The final completion message records the final commit
and verified clean source status.
