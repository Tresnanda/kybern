# Native sparse list follow-up

Workload: Apple M1, macOS 27.0.1, Bun 1.4.0, 60 Hz Retina LCD,
`KYBERN_FULL_RATE=1`. Mixed 3,000-turn transcript, variable-height 30,000-row
list and full 300-thread/20-project sidebar. Each active sample uses ten
seconds of warm-up and fifteen seconds of resources with real AppKit precise
contact/momentum wheel events at 120 offered packets/second. Timing runs have
no screenshots, fake clock or diagnostic profiler. Both variants use the same
local native addon and source; the control restores dense React slots and
per-row motion scans with `KYBERN_SPARSE_LIST=0 KYBERN_MOTION_SYNC=0`.

The prior implementation bounded rich content but retained one host/component
slot per logical row. Headless 3,000-turn hosts fall from 36,227 to 257 while
rich Markdown and code mounts remain five each. The native count, semantic
keys, height estimates and measured-height history represent the whole list;
only the visible window, overscan and explicitly owned rows have React/native
children. Model and identity metadata remain proportional to history.

Separate `sample` diagnostics found repeated `sync_motion_states` underneath
`build_virtual_child`: 170 inclusive samples under a 247-sample deferred-row
branch, including JSON equality and hashing. A draw/tree-revision memo removes
those repeated global scans while preserving the existing motion clock and
completion events. The sidebar also subscribed to every mounted row's geometry
although the native list already publishes its semantic anchor. Its final
sparse mode keeps that one list observer. Dense/diagnostic mode retains the old
row observers.

The isolated fast-sidebar stages demonstrate why sparse slots alone were
insufficient (same 1,800-packet input; diagnostic profiles excluded):

| Stage | p95 / p99 ms | >33 ms | CPU % | GPU ms / 15 s | MiB |
| --- | --- | ---: | ---: | ---: | ---: |
| Sparse before owner-notification fix | 48.28 / 50.87 | 132 | 83.36 | see raw | 264 |
| Skip unchanged owner notifications | 39.70 / 45.38 | 106 | 83.56 | see raw | 253 |
| Native7, repeated motion scans, row observers | 39.47 / 45.89 | 103 | 83.44 | 3178.0 | 248 |
| Motion memo, row observers | 29.02 / 30.17 | 4 | 70.99 | 3725.5 | 260 |
| Motion memo, list anchor observer | 17.90 / 18.81 | 0 | 61.00 | 3894.7 | 252 |

These stages are separate runs, not pooled. GPU work per time window rises as
more frames are submitted; CPU, GPU, footprint and energy are different
measures. Physical input-to-photon latency and energy are not measured.

Buffers of 1,152 and 1,536 px reduced commit frequency but introduced mount
bursts (p99 119 and 168 ms), so the existing 768 px buffer remains. Attempting
same-value state setters during commit-phase row disposal also introduced extra
root commits; the owner ref now prevents those notifications before dispatch.

A repeated older-history navigation probe also reproduced an existing native
cache panic in the dense control: `LineLayoutCache::reuse_layouts` under
`Window::reuse_paint` read a range from a different draw. This invalidated the
first final-suite attempt. Cache prepaint/paint ranges now require the
immediately previous draw and a matching rollback generation. Same-draw List
retries and prepainted-but-unpainted subtrees render again. The crash evidence
is retained in `cache-repro/`; its resource numbers are diagnostic only.

## Files and correctness

- `src/kit/sparseList.tsx`: stable count metadata, bounded logical indices,
  explicit row ownership and visited identity across remounts.
- `src/Transcript.tsx`, `src/transcript/Window.tsx`: sparse logical top/body/end
  slots, retained live/fresh/selected/interaction owners, bounded slot cache.
- `src/sidebar/Window.tsx`: sparse entries, semantic anchor lookup and one
  native list observer. Sidebar content, disclosure and ordering are unchanged.
- `native/ui-lease.ts`: wait outside foreign quiet windows and use parent lease.

Native patches are separate from React changes:

- `sparse_list.rs`, `sparse_list_hooks.py`, `sparse_list_gpui.py`: measured
  heights keyed by stable identity, count-based sum tree, anchor-preserving
  splices, logical-to-physical child/focus mapping and grouped remeasurement.
- `cache_frame_gpui.py`: bind cached prepaint/paint ranges to the correct draw
  and invalidate abandoned prepaint transactions.
- `motion_frame.rs`, `motion_frame_hooks.py`, `motion_frame_gpui.py`: reconcile
  motion once per actual draw and retained-tree revision.

Evidence root: `/Users/mymac/projects/ade/previews/gpuix/perf/scroll2/`.
`visual/pixel-diff.json` contains sixteen exact transcript pixel comparisons;
`sidebar/settled-pixel-diff.json` contains eight exact settled sidebar comparisons.
Both themes, reduced motion, rail jumps, older-history prepend/reorder,
Unicode and cross-turn copy, lightbox ownership, final formatted output,
sidebar inline rename/menu/disclosure, project/task drag, Escape and tooltip
sweeps are covered by the reproducible harnesses in this directory. Native
updater checks additionally cover PR summary/diff/list scrolling, clip geometry,
SVGs, spring endpoints, surfaces and text/link rendering.

## Final same-addon comparison

Capture source `0dc68966`, native updater 8 (whole build/check marker), addon
SHA-256 `5cd4940feefe75db3e9903c1a33ee2fca7462b184d73572e29302c591d0f75f7`.
All paired primary inputs have the same native addon, fixture, wheel producer
and 1,800-packet sequence; the full sidebar offers 1,800 packets in each case
(one packet remained pending at the nominal offer end in the normal candidate,
followed by the common 250 ms drain). `audit.json` verifies the artifacts,
12/12 shared bench cases, eight successful repeated paging/navigation probes,
marker/process guards and exact pixels. `initial-metrics/`, `native7-metrics/`,
`followup.log`, `motion-pair.log` and `cache-repro/` retain the earlier stages
and rejected crash attempt separately. Diagnostic profiles are excluded below.

All intervals/latencies are milliseconds; GPU is accumulated process GPU
milliseconds in approximately fifteen seconds; footprint is physical MiB.
`renderP95` is native draw cost **including** layout. Shared bench rows are
medians of two independent resource windows. Its older-history resource
windows follow loading and mostly idle; their 200 ms polling/settling gaps
are not continuous scroll-frame cadence. Input latency is a CPU paint boundary
for primary cases and a next-scene-submission proxy for the shared bench.

| scenario | variant | p50 | p95 | p99 | over16_7 | over33 | renderP95 | layoutP95 | inputPaintP95 | cpuPercent | gpuMs | footprintMiB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 3000 scroll | dense | 16.67 | 18.72 | 40.98 | 299 | 17 | 9.90 | 0.32 | 17.60 | 32.46 | 745.60 | 664.00 |
| 3000 fling | dense | 16.67 | 28.67 | 51.94 | 302 | 29 | 9.33 | 0.62 | 17.57 | 33.87 | 672.70 | 664.00 |
| 3000 idle | dense | — | — | — | 0 | 0 | — | — | — | 4.31 | 0.00 | 652.00 |
| 30000 scroll | dense | 16.66 | 17.67 | 28.88 | 276 | 6 | 6.18 | 0.38 | 16.61 | 23.03 | 439.00 | 480.00 |
| 30000 fling | dense | 16.67 | 25.06 | 43.30 | 311 | 13 | 5.45 | 0.79 | 16.45 | 31.01 | 453.20 | 481.00 |
| 30000 idle | dense | — | — | — | 0 | 0 | — | — | — | 3.39 | 0.00 | 470.00 |
| 300 sidebar settled | dense | 16.71 | 19.42 | 40.08 | 451 | 21 | 6.47 | 0.46 | 18.41 | 68.33 | 3575.60 | 250.00 |
| 300 sidebar fast | dense | 16.68 | 43.65 | 45.65 | 375 | 108 | 6.29 | 0.53 | 37.62 | 83.29 | 3137.90 | 252.00 |
| bench sidebar-scroll | dense | 16.72 | 19.40 | 22.46 | 459.50 | 3.50 | — | — | 15.65 | 62.56 | 2254.60 | 222.50 |
| bench older-history | dense | 199.65 | 201.38 | 215.04 | 84.00 | 72.50 | — | — | — | 8.36 | 236.75 | 270.50 |
| bench idle-thread | dense | — | — | — | 0.00 | 0.00 | — | — | — | 3.55 | 0.70 | 235.00 |
| 3000 scroll | sparse | 16.67 | 17.68 | 18.85 | 321 | 5 | 5.17 | 0.59 | 14.87 | 22.93 | 640.00 | 368.00 |
| 3000 fling | sparse | 16.68 | 17.69 | 34.37 | 319 | 9 | 5.22 | 0.99 | 17.05 | 22.18 | 555.20 | 364.00 |
| 3000 idle | sparse | — | — | — | 0 | 0 | — | — | — | 3.05 | 0.00 | 356.00 |
| 30000 scroll | sparse | 16.67 | 17.74 | 18.78 | 311 | 5 | 3.43 | 0.57 | 15.27 | 16.19 | 205.30 | 208.00 |
| 30000 fling | sparse | 16.67 | 17.81 | 18.64 | 322 | 5 | 3.63 | 0.74 | 17.30 | 19.06 | 317.40 | 208.00 |
| 30000 idle | sparse | — | — | — | 0 | 0 | — | — | — | 3.05 | 0.00 | 200.00 |
| 300 sidebar settled | sparse | 16.68 | 18.25 | 18.88 | 439 | 0 | 5.62 | 0.53 | 17.92 | 48.90 | 3824.70 | 249.00 |
| 300 sidebar fast | sparse | 16.68 | 17.78 | 18.64 | 427 | 0 | 4.81 | 0.63 | 17.37 | 60.40 | 3841.10 | 256.00 |
| bench sidebar-scroll | sparse | 16.67 | 17.50 | 19.18 | 343.50 | 0.50 | — | — | 12.53 | 45.91 | 2587.45 | 220.00 |
| bench older-history | sparse | 199.76 | 201.42 | 215.72 | 88.00 | 72.00 | — | — | — | 6.84 | 217.45 | 263.00 |
| bench idle-thread | sparse | 13.39 | 13.39 | 13.39 | 0.00 | 0.00 | — | — | — | 3.58 | 3.50 | 239.00 |

Visible-content latency in the synthetic process fixtures: mixed 3,000 turns
1,887 → 1,086 ms; 30,000 rows 1,042 → 646 ms. Shared older-history visibility
was 1,260/1,444 ms in the control and 662/779 ms in the candidate, with lower
sequence numbers and newly older painted text proven in every repeat. These
are local synthetic workloads, not packaged startup or daemon/network claims.

## Draw tails and remaining limits

| Candidate workload | Draw p95 / p99 / max ms | Draws >8 ms | Whole-process CPU / GPU ms per submission |
| --- | --- | ---: | --- |
| 3000 scroll | 5.17 / 6.22 / 6.39 | 0 | 4.83 / 0.90 |
| 3000 fling | 5.22 / 6.66 / 6.96 | 0 | 4.67 / 0.78 |
| 30000 scroll | 3.43 / 3.73 / 4.08 | 0 | 3.42 / 0.29 |
| 30000 fling | 3.63 / 3.84 / 4.57 | 0 | 3.95 / 0.44 |
| 300 sidebar settled | 5.62 / 6.16 / 14.81 | 1 | 8.01 / 4.17 |
| 300 sidebar fast | 4.81 / 5.53 / 14.41 | 1 | 9.89 / 4.18 |

The fast sidebar reaches zero >33 ms intervals in this final run: p95
43.65 → 17.78 ms, p99 45.65 → 18.64 ms and CPU 83.29 → 60.40%. Its footprint
is 252 → 256 MiB (+4 MiB), and GPU work 3,138 → 3,841 ms/window; GPU per
submission is 3.98 → 4.18 ms. Normal sidebar GPU also increases slightly.
These are explicit resource tradeoffs, not an across-the-board resource win.

Mixed transcript footprint falls 664 → 364–368 MiB; the large synthetic list
falls 480–481 → 208 MiB. Both also reduce active CPU/GPU. Every measured candidate native
draw in these two workloads is under 8 ms, but submission gaps over 33 ms remain
(3,000 turns: five normal/nine fling; 30,000 rows: five in each). Decaying
momentum and unchanged pixels can produce gaps; low draw cost alone does not
prove every remaining gap intentional. The absolute zero-gap goal is therefore
not certified. Sidebar has one draw over 8 ms in each case, despite zero
submission intervals over 33 ms, and its whole-process CPU cost remains above
8 ms per submission. This 60 Hz host cannot certify 120 Hz or input-to-photon.

Dedicated transcript/list idle windows submit zero frames and zero GPU work.
The full-app shared idle first window includes one control/two candidate
asynchronous submissions, then zero in the second window; this does not support
a universal zero-frame idle claim. No product timer was added. Metadata/model
updates still scale with logical history on data/layout epochs, and explicit
selection/interaction owners may extend the mounted window. Live streaming
and the other optimization lanes still need an integrated measurement.

## Validation and cleanup

- `pnpm typecheck`, harness TypeScript check: pass. `bun test ./src`: 322 pass,
  zero fail, 5,817 assertions across 50 files (`finish.log`, 7.32 seconds).
- `native/update.sh`: passes end to end, including all checks; sixteen Rust
  tests pass. `native-update-8.log` / `native-passed.json`.
- `revalidate-native8.log`: all product verifiers pass. Its final pixel assertion
  rejected two dark screenshots with different hover positions; the normalized
  pointer retry passes all eight comparisons in `finish.log`. Diagnostic
  images and explanation are retained under `sidebar/pointer-diagnostic/`.
- Sixteen transcript and eight sidebar comparisons have zero changed pixels;
  both themes and both motion preferences are covered where applicable.
  `verification.json` and `audit.json` record the final success gates.
- The old cached-paint crash reproduces in the dense control before the guard;
  the fixed guard passes four paging/navigation repetitions in each variant.
- `cleanup.json`: removed own 1.85 GiB native target, upstream checkout,
  disposable GPUiX/desktop dependencies, test executables/images, wheel dylibs,
  old addons and scratch data. No orphan process needed stopping. No daemon or
  app remains for this lane. The validated addon (24.9 MiB) and webview dylib
  (0.10 MiB) remain as runtime deliverables; source/worktree remain registered.
- Free space: initially 85 GiB; before native updater 8, 82.07 GiB; directly
  before/after cleanup, 81.65 → 83.65 GiB. This is a shared APFS volume, so those
  changes are not attributed solely to this lane's deletions.

Branch: `gpuix/perf-scroll2`, based on `5af3ec58`. Product commits are
`a1c2a851`, `78053b68`, `c1b48812`, `1857c0ff`, `0124e5d3`, `838a28a9`;
subsequent commits contain the reproducible harness and this report. Generated
shared-bench result documents are preserved in evidence and removed from the
worktree before handoff. The final report commit changes documentation and
small aggregates only; capture source stays recorded above.
