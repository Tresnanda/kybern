# Sparse native lists

This lane moves stable logical identity and variable heights into the native
list summary while React retains a pixel window plus explicit owners. The
same source can run the preceding dense-slot design with `KYBERN_SPARSE_LIST=0`.
Both controls retain the earlier body-window and layout-cache optimizations.

From `apps/gpuix`, after frozen dependency installation:

```sh
python3 perf/scroll2/build.py
bun perf/scroll2/validate.ts
bun perf/scroll2/quiet.ts bun perf/scroll2/final.ts
python3 perf/scroll2/counts.py
```

`build.py` respects the shared quiet/build reservation files and keeps its
build marker throughout the updater's build **and checks**. It routes the
historical native check screenshots into this lane's evidence folder and
restores those source paths afterward. It compiles the unchanged real AppKit
wheel producers. The native addon must be rebuilt after patch changes.

Validation takes separate UI leases under five minutes and waits outside all
quiet windows. It checks 30,000 variable-height stable rows, prepend and reorder
anchors, a disjoint pinned row, rich and compact transcript rail jumps, row-owned
image dialogs, Unicode and cross-turn selection, transcript regressions, both
themes and reduced motion, and sidebar editor/menu/disclosure/drag/tooltips.
Screenshot runs are separate from measurements.

`metrics.ts` is one ordered build-free window, with individual UI leases. It
pairs dense/sparse 3,000-turn mixed-content transcripts and 30,000-row lists
with identical 1,800-packet 120 Hz precise AppKit input. Each scene warms for ten
seconds, then samples 15 seconds of scrolling, fast flicks or settled idle.
The shared bench adds repeated sidebar, older-history and thread-idle cases;
the original sidebar harness adds the full 300-thread case with normal and
fast input. Native build markers and foreign native fixture processes invalidate
a timed run. Resource samples report process CPU, AGX GPU work and physical
footprint separately; they exclude daemon and WindowServer.

Evidence lives under `/Users/mymac/projects/ade/previews/gpuix/perf/scroll2/`.
Frame intervals describe native scene submissions. Input-to-paint is an
instrumented CPU boundary, not an input-to-photon measurement. This host has a
60 Hz display; these measurements do not certify 120 Hz presentation or energy.
`SCROLL2_PROFILE=1` enables a separate diagnostic sample; never mix its resource
measurements with unprofiled acceptance results.

The final control uses `KYBERN_SPARSE_LIST=0 KYBERN_MOTION_SYNC=0`; the candidate
uses both defaults. `motion-pair.ts` isolates motion reconciliation with row
observers held on, then compares the old row observers against the one native
list-anchor observer. `followup.ts` records the ownership-notification and
buffer experiments; 1,152/1,536 px buffers were rejected for long mount bursts.
The default stays 768 px. `KYBERN_SIDEBAR_ROW_OBSERVERS=1` restores the diagnostic
row-position subscriptions without changing row content or list semantics.

`final.ts` archives the initial measurements, runs the final complete controls,
and writes `summary.json`/`summary.md` and the inclusive native profile summary.
Profiles and screenshots are separate from the unprofiled acceptance windows.

`reproduce-cache.ts` repeats older-history paging and Home/thread navigation.
The pre-fix dense control reproduced a GPUI cached-paint text-range panic.
`SCROLL2_CACHE_FIXED=1` keeps the post-fix diagnostic separate and fails on any
unsuccessful repeat. These one-second diagnostic samples are excluded from
resource acceptance tables. Cached ranges require both prepaint and paint in
the immediately preceding draw and a valid prepaint rollback generation.
