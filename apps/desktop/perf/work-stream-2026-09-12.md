# OMP lifecycle, thinking traces, and active-work rendering

## Reproductions and changes

[Issue #8](https://github.com/Tresnanda/kybern/issues/8) left an idle OMP
session's background process marked active after its provider had died. The
provider emitted `Exited`, but the orchestrator waited for channel EOF while
the retained session handle still owned a sender. The pump now treats `Exited`
as terminal. Cleanup settles both attached and persisted orphaned tasks behind
the existing resume barrier. Idle interrupts use the same bounded cleanup as
active turns, including broken pipes and missing acknowledgements. Replacement
sessions and new continuation responses remain protected from old cleanup.

Thinking disclosure re-entry had a separate stale cursor: pausing advanced the
animation ref without advancing React's displayed length. Reopening without
another delta could show a short prefix indefinitely. Both cursors now resume
at the received prefix. A virtual row mounting with an already-received live
trace also starts with that full prefix; only subsequent deltas are paced.
Closed disclosure content unmounts after its exit transition.

The read/edit collision was a layout error, not duplicate provider text.
Expanded groups could remount when the work list crossed its virtualization
threshold. Absolute row positions still used estimated heights while the open
group already occupied its actual height. Mounted rows now share normal flow;
gaps represent unmounted intervals. The virtualizer still bounds mounted work
and measures heights. The flow-root boundary prevents the leading gap's margin
from moving the list's origin. The subsequent
[scrolling investigation](scrolling-2026-09-12.md) found that normal-flow rows
also need mount measurements and scroll compensation before paint. It replaces
the initial frame-deferred observer handling, with the delayed-observer overlap
and interaction regressions rechecked.

Streaming used to advance `threads[id].last_seq` by publishing a new thread
metadata table for every token. That invalidated the sidebar, header, and
composer. The exact cursor now stays in the transcript; actual thread metadata
changes still publish immediately. Bootstrap uses the transcript cursor when
rejecting stale snapshots. Sidebar project lists cache their sort against the
metadata table, and project activity subscribes to its displayed status rather
than every task update. Unchanged reasoning rows and tool-output derivations
are memoized.

## Native evidence

Apple M1, 16 GB RAM, macOS 27.0 (26A5416b), system WKWebView. Fixtures build
production frontend bundles at `tauri://localhost` with the production CSP,
without a live provider. Default viewport: 1100 × 720 CSS pixels. Measurements
are warm after the fixture's initial mount and worker initialization.

| Workload | Before | After |
| --- | --- | --- |
| Real OMP replay, 4,703 events and 934 inspected paints, periodically opening disclosures | 7 visible row collisions | 0 collisions |
| 100 thinking deltas through the actual store | 100 thread metadata table publications | 0; transcript sequence remains 100 |
| Full sidebar, header, composer, and transcript; 1,000 threads in 20 projects; 100 deltas per phase | React update p95 6 ms, then 5 ms | 2 ms in both optimized phases |
| Same shell, 100 background activity updates with unchanged working status | Update p95 21 ms | 1 ms |

The shell token test alternates the old sequence-publication behavior and the
current store twice in the same window. A final repeat after the activity and
live-remount fixes measured 5/5 ms baseline versus 3/2 ms optimized, with 18 ms
frame intervals in all four phases. Its baseline retains the other current
rendering changes, so it isolates publication cost rather than comparing two
complete released apps. Frame interval p95 was 19–20 ms in both modes. The
activity pair was collected separately; a build overlapped part of the first
run, so its timing is diagnostic evidence rather than a precise speedup ratio.

The synthetic active-work fixture uses 600 previous thinking/tool pairs with
large closed outputs and a growing live tail. It retained approximately 576
mounted DOM nodes rather than mounting all 1,200 work entries. Final update p95
was 5 ms, frame interval p95 18 ms, and synthetic input-event-to-next-frame p95
16 ms. The 480-pixel layout also passed the exact-text, disclosure, and collision
checks, with 588 nodes and respective p95 timings of 5/18/18 ms.

The private replay forces geometry reads on every inspected paint and replays
events faster than the original conversation. It is an overlap regression,
not a frame-rate benchmark. Private event text and screenshots are excluded
from commits. These measurements do not establish CPU usage, energy savings,
OS key-to-screen latency, or performance for every possible provider workload.

## Regression coverage

`work-stream` exercises first open, hidden deltas, rapid collapse/reopen,
completion, expanded live-row remount, closed-content cleanup, mixed read/edit
insertion, repeated virtualization threshold crossings with an expanded group,
and delayed ResizeObserver delivery. It verifies visible geometry as well as
exact thinking text and bounded mounted work.

`work-shell` uses the real sidebar, thread header, composer, transcript, and
store. It verifies token publication counts, immediate metadata updates, exact
event sequencing, and working/monitoring/idle transitions on a collapsed project.

The daemon regressions retain the sender after successful and failed provider
exits, and cover idle interruption with broken and stalled transports. Existing
tests also cover cancellation, active-turn interruption, continuation races,
background checkpoints, and session release/replacement. The shared pump fix
applies to all drivers that emit `Exited`; this is not a claim that every live
provider failure mode was exercised.

Commands from `apps/desktop`:

```sh
node scripts/check-rendering.mjs work-stream
KYBERN_PERF_WIDTH=480 node scripts/check-rendering.mjs work-stream
node scripts/check-rendering.mjs work-shell
```

For a local, private event replay, set `KYBERN_WORK_REPLAY` to a JSON array of
wire events when running `work-stream`. This input is compiled into the isolated
fixture only and never enters the shipped frontend.

Existing native fixtures passed for interaction, rendering, scaling, earlier
history, continuation, materials, activity, and chat fixes. They cover navigation to first/middle/last
messages, focus and selection, wrapping, retained highlighted code, exact final
formatting, expanded work, reading position, follow behavior, resizing, thread
switches, and light/dark/opaque surfaces. The large-history fixture retained
8 mounted messages; its streaming interval p95 was 18 ms and scroll interval
p95 was 25 ms. Scrolling was not uniformly faster than the prior 23 ms run.
The Activity fixture retained 15 mounted rows for 4,000 tasks, update p95 was
5 ms, and the hidden panel had no active timers.

Rust workspace tests, formatting, and strict Clippy passed. Desktop unit tests,
typecheck, lint, and production frontend build passed. The Tauri wrapper built
and staged the updated daemon, but the complete debug application build failed
with Rust E0463 loading cached proc-macro crates, including `phf_macros` and
`tauri_macros`. The failure also occurred with a fresh isolated target directory,
an explicit host target, stripping disabled, and workspace feature unification.
No Rust toolchain, installed application, or normal daemon was replaced.

## Peer source review

Reviewed the current timeline sources in
[t3code](https://github.com/pingdotgg/t3code/tree/e816064945144957b6eb9b268912a98b0555644b)
and [Synara](https://github.com/Emanuele-web04/synara/tree/a355cf2000b18aeb032e7dac18b74efdb3ab3268).
Both reinforce keeping settled timeline content separate from changing stream
state and memoizing unchanged rows. Their source informed the review; neither
Electron application was benchmarked against Kybern.
