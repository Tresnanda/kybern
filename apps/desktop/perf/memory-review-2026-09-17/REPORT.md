# Consolidated memory follow-up: reviewed implementation and measurements

## Result and scope

The consolidated archive has been ported, corrected and committed in the isolated `fix/memory-followup-reviewed` worktree. The implementation includes the previously unmerged omitted-output prerequisites and integrates them with the existing projection cache. It does not downgrade to PR #28, include PR #29's allocator change, or alter graphics effects.

The release daemon's sampled peak footprint decreased from **221.16 MiB to 25.92 MiB** (median of three runs, **195.23 MiB / 88.28%**). The same workload's ten-second post-workload idle decreased from **221.14 MiB to 25.91 MiB** (**195.23 MiB / 88.28%**). These are measured daemon-only results, including the prerequisites, and must not be described as whole-app savings or attributed exclusively to the follow-up patch.

**Page-aware/persisted reconstruction remains outstanding. Whole Tauri application memory and workflow acceptance remains outstanding.** The PR is a draft because fixture coverage does not replace the remaining whole-app gates.

## Provenance and repository state

- Baseline: `c85f3bfd35c0fa55d3a99eccbaf86ae6de9479b2`, original branch `feat/hugeicons-icons`.
- Reviewed daemon/source implementation: `08162402de19527ec74ea67605fab8010a1c2f67`.
- Final reviewed source: `b7024bd`; activity-pane correction `d0a649d`, hydration backpressure `8d7e005`, real reconnect fixture `f2a6d5a`, queued deletion/error handling `b7024bd`. Daemon sources/binary are unchanged from `0816240`.
- Archive SHA-256: `9bca10e88c61b64b4f21c7eb2763ba63313ad0c18868514196a2b959acd9578b`. All package manifest checksums passed. README, REPORT, NATIVE_MEASUREMENT, PR_DRAFT and installer were read before integration.
- Read repository instructions, desktop performance guide and affected reports. `docs/architecture.md` and `docs/design.md`, referenced by AGENTS.md, are absent at this repository revision.
- Original untracked notes/screenshots/artifacts and original branch remained untouched. All builds use `/Users/mymac/projects/kybern-memory-review/target`; all daemon workloads use isolated scratch data. No production `~/.kybern` data was used.

PR status inspected before integration:

| PR | State | Included in baseline? | Observation |
| --- | --- | --- | --- |
| [#15](https://github.com/Tresnanda/kybern/pull/15) | Merged | Yes | Checks successful |
| [#18](https://github.com/Tresnanda/kybern/pull/18) | Merged | Yes | Latest recorded macOS desktop check failed; Rust and Ubuntu desktop successful |
| [#24](https://github.com/Tresnanda/kybern/pull/24) | Open, draft | No | Head `1904f8625200bf8b68d1ac96a6d0758d6d064cbd`; checks successful |
| [#28](https://github.com/Tresnanda/kybern/pull/28) | Open | No | Head `19de5debb5abc9660d365604c303b371837e7d7f`; checks successful; based on #24 |
| [#29](https://github.com/Tresnanda/kybern/pull/29) | Open | No | Head `3caabb8236e305836d2606748c916fb70e6b4d55`; checks successful; allocator change excluded |

The installer dry run first rejected the newer `rpc.ts`. After contextually porting the reviewed #24/#28 prerequisite diff, the full dry run still rejected newer sources (`package.json` and store changes). The patch was therefore ported manually with context checks. New Hugeicons dependencies and the newer provider-limits method were preserved. No hash check was disabled; no force patch or whole-file replacement was used to bypass the installer. The supplied earlier standalone implementation archive was not applied.

## Corrections made during review

- **Mounted result lifetime:** each mounted consumer owns an idempotent lease; shared panes share a payload but release independently. The existing twelve-result allowance applies only to inactive hydrated results. Closing a result unmounts its body after exit. In-flight loads retain scalar identity, not an old transcript.
- **Stale responses:** deduplicate by exact row/revision, invalidate pending loads across connections, reject replaced snapshots and deleted rows, and preserve authoritative live completions. A stale request's `finally` cannot remove a newer request. Runtime tasks and activity panes hydrate the exact selected sequence, including reused IDs.
- **Hydration backpressure:** the new real-daemon fixture exposed intermittent RPC saturation when sixteen results opened together alongside normal UI requests. The cache now schedules four concurrent hydration RPCs, preserving room in the existing sixteen-request daemon lane. Queued requests cancel on connection changes/disposal; old completions cannot drain a new connection’s queue. Forty-result saturation, reconnect and failure-slot tests execute the real cache. The server limit is unchanged.
- **Snapshot correctness:** additive optional `start_seq`/`through_seq` fields bind tool hydration to a particular invocation and snapshot. SQL cannot cross an intervening reuse of the ID. A later correction/completion cannot leak into an older snapshot. Exact page hydration decodes before publishing, moves final uses, and clones only genuinely repeated requested rows.
- **Projection compatibility:** the supplied global output omission would also affect non-UI callers. Ordinary `project_transcript` retains full outputs; omission is opt-in for the daemon's saved-transcript fold. No event-log mutation or schema migration was introduced.
- **Borrowed paging:** cached entries are borrowed for selection, only returned entries are cloned; live rows and equal-sequence boundary semantics are preserved. This is not page-aware folding.
- **Event dispatch/filtering:** event kind lookup avoids JSON serialization. SQL filters only the explicit known no-op kinds; unknown/new events still take the existing decode path. Replay continues reading the original event log. Exhaustive event-kind and filtered/full-fold equivalence tests cover this contract.
- **Canonical messages:** borrowed canonical text/thinking reconciliation uses valid Unicode boundaries and preserves final exact content, identifiers and ordering.
- **Notifications and terminal replay:** typed serialization emits the same wire shape without an intermediate JSON tree; borrowed events serialize before queue ownership. Existing queue budgets, cancellation, authorization and timeout/backpressure behavior remain. Terminal replay buffers are released before awaiting readiness.
- **Measurement tooling:** the separate sampler validates explicit process roles, rejects duplicate PID attribution and incomplete logs, never treats sampling errors as zero, and distinguishes RSS from physical footprint/PSS. Native sampler tests execute real process reads. Synthetic harnesses use actual SQLite migrations, a release daemon, WebSocket client and PTY.

## Daemon measurements

macOS 27.0 (26A428), Apple M1, 16 GiB, arm64; WebKit 22625.1.29.11.27. Rust 1.96.0, Node 24.15.0, pinned desktop pnpm 11.25.0; release thin LTO, one codegen unit, stripped binaries. See [methodology](NATIVE_MEASUREMENT.md) and [exact environment](environment.json).

400 sanitized turns / 800 large tool outputs / 6,400 events. Same deterministic data and action sequence for both revisions. Initial idle five seconds; post-workload idle ten seconds. Each run launches a fresh process. Values below use process physical footprint, not JSON byte counts or a Python model.

| Daemon metric | Baseline, three runs | Candidate, three runs |
| --- | --- | --- |
| Observed startup sampled peak | 5.48–5.72 MiB | 5.38–5.69 MiB |
| Initial idle, run medians | 5.70–5.73 MiB | 5.69–5.70 MiB |
| Workload sampled peak | 221.13–221.39 MiB | 25.92–26.00 MiB |
| Post-workload idle, run medians | 221.11–221.38 MiB | 25.91–25.98 MiB |
| First 60-row request | 236.1–246.4 ms | 176.2–181.7 ms |
| Warm 60-row requests, run medians | 193.0–197.8 ms | 0.40–0.51 ms |
| Earlier 120-row requests, run medians | 199.0–201.2 ms | 0.46–0.56 ms |
| 120-row full-output requests, run medians | 198.3–200.3 ms | 20.3–21.2 ms |

The existing projection cache has a 32 MiB budget; omitting large saved outputs allows this fixture’s compact projection to remain cached. That explains the especially large warm-page latency improvement without implying incremental reconstruction. Startup sampling misses sub-100-ms peaks, so no startup-saving claim is made. Candidate earlier-page calls complete between memory samples; their phase RAM is unavailable, not zero. Peak and retained post-workload improvements are both observable here. Intermediate clone/serialization reductions are plausible allocation reductions but were not independently isolated by allocator profiling. No application CPU or energy percentage is claimed. All six reported runs replayed 6,400 events in increasing order and received the final PTY line. [Raw per-run aggregates](daemon-comparison.json) preserve variability.

Baseline daemon SHA-256: `35630337330c614ed0fd220f188957a1732513ed32e31381f03fa7d17438e8e8`. Candidate daemon SHA-256: `5e677dde6824ad26ffeefebbb3dd4b4f038594c7dbc4fff356bb2baebae85fd1`.

## Native renderer and correctness

The fixture WebContent process is measured independently from the daemon. These are production-bundle components in a native WKWebView, **not the WebView hosted by the Tauri application**. The default fixture is 1100 × 720 CSS pixels, dark/opaque. Repeated raw checkpoints and outcomes are in [native-memory.json](native-memory.json).

| Fixture / checkpoint | Baseline footprint, MiB | Final candidate footprint, MiB |
| --- | --- | --- |
| Tool startup | 63.3–65.8 | 64.6 |
| Tool results collapsed | 156.5–159.1 | 161.3 |
| Tool workload lifetime peak | 219.8–220.9 | 204.3 |
| Tool results released | 194.5–195.8 | 185.9 |
| Terminal startup | 42.5–42.7 | 42.6–42.7 |
| Terminal workload lifetime peak | 188.9–217.6 | 216.8–270.8 |
| Terminal released | 86.5–122.4 | 83.5–147.4 |
| Scroll workload lifetime peak | 399.2–404.5 | 390.6 |
| Scroll post-workload idle (10 s) | 179.3–228.7 | 203.9 |

Tool/scroll baseline ranges use two runs; final candidate values use the compiler-free `b7024bd` run. Two earlier candidate iterations are retained separately in the JSON, not pooled into these final values. Terminal ranges use four runs on each side of the identical fixture bundle.

Terminal figures initially looked worse. Inspection showed that this fixture imports only unchanged terminal-renderer/xterm code. Independently rebuilding both revisions produced **identical hashes for every JS, CSS, HTML and public asset**, and both installed dependency lockfiles also match. See [bundle comparison](terminal-bundle-comparison.json). These differing values on an identical workload artifact demonstrate native runtime/measurement variability; they do not establish a patch-induced terminal regression. This is also why no aggregate renderer savings percentage is claimed. Earlier intermediate candidate measurements are retained in the raw evidence and labeled by revision.

The graphics summaries show substantial WebKit allocator and graphics regions (for example, baseline mixed-work WebKitMalloc resident 270.1 MiB / dirty 155.8 MiB and owned-unmapped graphics resident 295.4 MiB / dirty 93.0 MiB). These regions are not additive physical-footprint totals. The available summary does not isolate decoded images from layer/tile backing allocations; no graphics optimization is justified or shipped here.

The native lease fixture found an actual bug before acceptance: sixteen simultaneous result requests plus normal UI traffic could exceed the daemon's sixteen-request lane. Failure logs captured the server's “Too many concurrent requests” response. Four-at-a-time hydration fixed the reproduced failure; three subsequent runs passed 32 mounted results / 16 unique payloads and 20 lifecycle fetches. The extended test also reconnects the actual socket while four hydration callbacks remain pending and verifies exact Unicode output and stable row identity after obsolete callbacks finish. It passes with 28 total requests, including recovery.

Correctness fixtures passed: interaction and history retention at 1100px/480px, tool-memory, terminal-memory, rendering, work-stream, markdown-memory and worker-lifecycle. The real-daemon lease/reconnect fixture passed after the fixes. Interaction covers selection, focus, scroll anchoring, navigation, disclosure persistence and follow behavior; terminal covers exact scrollback, selection, background output and reading position across five renderer switches. Native selection checks verify exact copyable text, not the OS clipboard.

Earlier candidate scrolling runs passed all eight 200-frame scenarios (1,600 frames), with p95 18 ms and no empty frames. The final instrumented run kept p95 18 ms and passed all content/anchoring assertions, but **failed its existing worst-frame criterion with a 1,327 ms mixed-work frame**. This failure is preserved and unexplained; no threshold was relaxed. A separate scaling run passed with 18 ms streaming-frame p95, 14 ms input-frame p95, 27/27 input events and 1 ms final commit. Work-stream reported 2 ms commit p95 and 17 ms frame/input p95. These are fixture metrics, not application CPU or energy measurements.

An attempted final scrolling run without memory instrumentation timed out while an unrelated Xcode build (PID 9730, parent 9724, outside this task) was compiling. The subsequent `accepted-*` native repeats overlap that build and are excluded from performance comparisons regardless of their pass/fail outcome; the late scrolling repeat also failed its anchor-jump criterion (28 px). This is recorded as a failed check, not classified as an unrelated source defect without a matched baseline under that load. The external build was not stopped. This shared runner is no longer suitable for a quiet acceptance repeat. The earlier first scaling attempt also timed out; two subsequent isolated scaling runs passed. **The unexplained instrumented frame stall and clean-run responsiveness acceptance remain open**, alongside full-app native validation.

| Requested process scope | Measurement status |
| --- | --- |
| Rust daemon | Three matched release runs, table above |
| Frontend in native fixture | Fresh attributed WebContent PID at each checkpoint, table above |
| Frontend/WebView serving the actual Tauri app | Not measured; fixture is narrower evidence |
| Tauri native shell | Not measured |
| Attributable WebKit GPU/network helpers | Not measured |
| Combined application footprint | Not available; separate fixture/daemon runs cannot be added |

The screenshot from the native interaction fixture was inspected: readable rows and icons, no overlap. This is limited dark/opaque component evidence, not a complete light/dark/material/accessibility audit.

## Remaining reconstruction cost and maintainable next step

The released candidate still visits all relevant historical events and constructs all transcript rows on a cold cache miss or an older snapshot request. At 1,600 / 3,200 / 6,400 events, the probe folds 600 / 1,200 / 2,400 rows to return just 60. In a separate compiler-free release probe (five folds at each barrier), median fold time was **25.76 / 52.14 / 105.77 ms**, while borrowed page selection was under 0.04 ms. The respective ranges were 25.59–55.96 / 52.12–83.95 / 105.69–166.34 ms, including each first fold. See [all probe samples](fold-profile.jsonl).

A raw-event `LIMIT` would break starts/completions, canonical replacements, reverts, live rows and historical snapshots. A separate versioned projection is the safer direction: persist compact row metadata/output references with validity intervals and a per-thread projection version/head; maintain dependency indexes for call/message identities; update rows and projection head atomically with event append, or atomically catch up from a durable checkpoint. Reverts must invalidate/recompute dependent rows, not just truncate a page. Older snapshots must query the correct validity interval; equal-sequence rows must remain together. Keep large outputs in the event log and hydrate selected references.

Before shipping that design, compare incremental results to the full fold across randomized event streams and every historical barrier/page boundary; test interrupted backfill, version changes, corrupt/missing projection data, rollback/recovery and restart. Preserve an atomic fallback rebuild from the authoritative log. Measure cold/warm small-page latency, append overhead, memory and database growth. This patch adds the reproducible real-store probe but **does not implement or claim persisted/page-aware reconstruction**.

## Verification and remaining gates

- Rust formatting, protocol/store/daemon tests and workspace Clippy with warnings denied pass. Daemon tests: 157 passed, 2 pre-existing ignored; protocol: 1 library, 9 schema and 3 fixture tests; store: 29. Includes native Rust paging/canonical/wire tests and real authenticated RPC/store tests for snapshot hydration, correction, reused IDs, invalid bounds, wrong thread, deletion and reopen.
- Release daemon and sidecar-aware production Tauri app build pass. Desktop: 233 tests, typecheck, lint and production frontend build pass.
- Shared-client mobile checks: typecheck, 110 tests and Android/iOS export pass. Expo Doctor: 20/21 checks pass; 19 existing pinned package patch-version mismatches are reported. Dependencies were not changed to hide this unrelated failure.
- Four sampler tests pass, including a real native process-memory read. Package Python models were not used as correctness or memory evidence.
- Native correctness coverage and repeated-run outcomes are listed above. The final instrumented scrolling run failed its worst-frame gate, and the final uninstrumented repeat was blocked by unrelated compiler activity. Keep the PR draft; do not infer production responsiveness acceptance from p95 alone.
- Full Tauri shell, app-bound WebView/helper attribution and combined footprint were not measured: the user's packaged app/daemon host this session and were preserved. Real OS clipboard contents, visual accessibility/material combinations and full app-level agent workflows still need a dedicated native session. The native component fixture additionally closes the actual WebSocket with four real hydration callbacks held pending, then verifies reconnected rows and exact text survive obsolete completions. Exact selected text, reconnect/deletion and actual RPC boundaries have the narrower automated coverage described above.
- No changes to graphics behavior, artificial memory limits, forced GC or allocator swaps. Native vmmap summaries profile broad WebKit/graphics regions only; decoded image/layer/tile attribution remains incomplete. A late stale-PID diagnostic failed and is excluded. No visual effect was removed to lower a number.

All full local logs, installer dry runs, candidate patches, run samples and successful per-stage vmmap summaries remain under `perf-artifacts/memory-followup-20260917/` in the original checkout. The PR should stay draft until the explicitly outstanding native gates are resolved; passing unit tests does not imply production acceptance.
