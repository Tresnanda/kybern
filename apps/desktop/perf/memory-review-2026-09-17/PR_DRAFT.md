# Bound saved tool results and reduce daemon transcript allocations

Large saved tool outputs previously forced full-history payload retention and repeated projection work. Opening more than twelve results could evict mounted content, and a burst of result requests could exhaust the daemon's RPC lane. This change retains mounted results across panes, queues hydration within existing backpressure, and selects outputs by exact start sequence and snapshot. It also reduces paging, canonical-message, event-kind and notification allocations without changing the event log or graphics behavior.

This is a reviewed manual port of the consolidated `kybern-memory-followup.zip`, including required unmerged #24/#28 changes. It preserves the newer source at `c85f3bf`, including Hugeicons and provider limits. It excludes #29's allocator change. This PR is stacked on `feat/hugeicons-icons` (#27) to avoid mixing that branch's unrelated changes into the review. It does not close or merge those PRs.

Review corrections include stale/deleted/reused-ID and historical-snapshot handling, full-output compatibility for non-UI projection callers, exact activity-pane hydration, queued-load cancellation, and real socket reconnect tests. A native two-pane fixture caught the RPC saturation bug; the corrected fixture verifies 32 mounted views of 16 outputs, exact Unicode text, close/reopen and reconnect while hydration is pending.

On an Apple M1 / 16 GiB / macOS 27.0 native runner, three matched release-daemon runs with 400 synthetic turns / 800 large tools produced:

| Daemon physical footprint | Baseline median | Candidate median |
| --- | --- | --- |
| Sampled workload peak | 221.16 MiB | 25.92 MiB |
| Ten-second post-workload idle | 221.14 MiB | 25.91 MiB |

The measured reduction is about 195.23 MiB / 88.28% for this daemon workload. This includes the prerequisites and is **not whole-app or renderer RAM savings**. Warm-page latency improves substantially because the compact projection fits the existing cache; cold reconstruction still folds all relevant history.

Validation: Rust fmt, protocol/store/daemon tests, workspace Clippy, release daemon, sidecar-aware production Tauri app, 233 desktop tests, typecheck/lint/frontend build, mobile typecheck/110 tests/Android+iOS export, sampler tests, and native production-CSP fixtures. Expo Doctor reports one existing failed check (19 pinned patch-version mismatches), unchanged by this PR.

Keep this PR **draft**. Full Tauri-shell/helper/combined memory, full app workflows and visual accessibility/material acceptance require a dedicated session; the user's active packaged app and production data were preserved. Native responsiveness acceptance is incomplete: an instrumented run failed with a 1,327 ms frame, and later repeats overlapped an unrelated Xcode build (timeout and 28 px anchor-jump failure). Thresholds were not relaxed. Renderer variability and all failed checks are retained in the report. Page-aware/persisted reconstruction is profiled and assessed but remains unimplemented.

Exact revisions, repeated samples, native fixture outcomes, reproduction commands and limitations: [optimization report](https://github.com/Tresnanda/kybern/blob/fix/memory-followup-reviewed/apps/desktop/perf/memory-review-2026-09-17/REPORT.md).
