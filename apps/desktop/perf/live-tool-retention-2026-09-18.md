# Live tool results and memory retention — 2026-09-18

## Finding and change

This starts from main `2cd0578` after the earlier work in #15, #18, #24, #28,
#30, and #31. The existing virtualization, paint boundaries, worker budgets,
snapshot-safe hydration, and leases are preserved; see the
[prior consolidated review](memory-review-2026-09-17/REPORT.md).

Saved tool results already used lazy hydration and mounted-view leases. Results
arriving through `tool_call_completed` did not enter that cache. A long live
turn could therefore retain every completed result, even with its work closed.
Protecting recent and running turns from history eviction made this especially
visible in ordinary tool-heavy work.

Live completions, replacement snapshots, replay, and earlier pages now enter the
same cache. Inactive canonical outputs are bounded by both 12 results and an
8 MiB estimated-retained-size budget. Metadata holds scalar identities, never
copies of payloads. Mounted consumers keep independent leases; shared views
deduplicate hydration. Exact sequence, turn, revision, and connection generation
checks prevent an old fetch or eviction from replacing newer content.

This is a bound on inactive **canonical tool outputs**, not all transcript data.
Distinct fallback streams remain intact: the existing output RPC cannot recover
those streams, and some carry agent receipts. Tool inputs, visible expanded
results, Markdown trees, graphics tiles, and allocator high-water marks are also
outside this budget. Do not describe the patch as an 8 MiB application cap.

## Reproduction and correctness

`live-tool-memory` starts a real scratch daemon and uses the actual Claude driver
protocol with a deterministic local fake harness. It streams 64 completed Read
results, each roughly 1 MiB of UTF-8 text including non-ASCII characters. The
production Transcript and environment runtime receive them through the real
WebSocket. All work begins closed. The fixture then opens an early result in
two independent panes, compares every character, verifies one hydration RPC,
closes one pane without disrupting the other, closes the remaining result, and
waits three seconds before the final memory sample.

Run from `apps/desktop` with a built daemon:

```sh
KYBERN_PERF_MEMORY_DIR=/tmp/kybern-live-samples \
  node scripts/check-rendering.mjs live-tool-memory
```

`KYBERN_PERF_DAEMON_BINARY` can explicitly select another binary; record its
profile and revision. `VITE_LIVE_TOOLS_BASELINE=1` permits the unchanged baseline
to retain its old payloads while keeping all content and interaction assertions.
The fixture is built separately and never enters the shipped frontend.

The focused cache suite passes 26 tests, including live enrollment, byte-bound
eviction, multi-consumer protection, reused IDs, replay/replacement, reconnect,
and cancellation. The native `tool-leases` fixture separately verifies mounted
results above the inactive budget, exact Unicode text, reopening, and reconnect.

## Related retention fixes

- File indexes belong to each daemon, cap at eight project slots, and release
  cached payloads autonomously after the existing three-second TTL. In-flight
  builds remain coalesced even if they take longer than the TTL.
- Artifact preview bodies leave memory after their existing 60-second expiry,
  without waiting for another request to trigger cleanup.
- Pending pairing invitations cap at 128; their labels cap at 256 UTF-8 bytes.
- Large CLI JSON writes directly to buffered stdout and explicitly flushes,
  avoiding a second full pretty-printed String while reporting write errors.
- Opaque desktop windows release the unused native material; see the
  [native material report](native-window-material-memory-2026-09-18.md).

The daemon's existing replay/PTY benchmark and a 16-project × 20,000-path index
workload are preserved in the workspace's `perf-artifacts/daemon-memory-20260918`.
The index workload removes at least 25.02 MiB of live path/String storage after
TTL relative to main. This is deterministic object retention, not an equivalent
drop in physical footprint: macOS and the allocator can retain released pages.
The exploratory daemon physical-footprint pair was noisy and does not establish
an overall percentage improvement.

Those exploratory daemon binaries preceded review corrections: restoring the
unbounded client handoff, propagating buffered-output flush errors, preserving
slow in-flight index builds, and weakening expiry timers' ownership of evicted
slots. The final index regression verifies that an evicted slot is destroyed
immediately while an active caller can still read its shared file list. Treat
the earlier process samples as diagnostics, not final-binary savings evidence.

The Rust client's notification handoff remains unbounded. An attempted bounded
channel was rejected during review because blocking its socket reader can
deadlock RPC replies behind unread notifications. A safe byte-bounded handoff
needs explicit lag/recovery semantics and is not claimed as fixed here.

## Measurement scope

Native WebKit measurements and full-application measurements are recorded
separately below. Do not combine process lifetime peaks, add overlapping memory
categories, or treat an isolated synthetic run as a promise for every session.
CPU, energy, paid model cache-hit rates, and multi-hour ordinary use were not
measured by this fixture.

A read-only sample of the user's already-running session located approximately
546 MiB in its original WebContent process, 43 MiB in the native shell, and
26 MiB in the daemon. A separate later `vmmap` sample recorded a 961 MiB lifetime
WebContent peak. These uncontrolled observations overlapped development work;
they establish neither the exact cause of the reported 800 MB nor a comparison
with the new code. They did justify prioritizing frontend retention and native
graphics over assuming the daemon alone was responsible.

## Serialized native WebKit comparison

Four runs were serialized baseline → candidate → candidate → baseline with no
compilers or other native fixtures overlapping. Both frontends used the same
release daemon (SHA-256
`2d973c8e3a780f25cc26741382ba170b01844cfb83a927ddd3212c5e70cdf4bb`).
The baseline frontend was `c7c9130`, immediately before live-result enrollment;
the candidate includes `6df5741`. Runtime was system WKWebView on this Apple
Silicon Mac, production CSP at `tauri://localhost`. Raw vmmap summaries,
command output and run metadata are in
`perf-artifacts/live-tool-memory-20260918` in the original workspace.

All four runs preserved all 64 results, exact reopened Unicode content and both
independent mounted consumers. The baseline needed no hydration RPC because it
retained every payload; the candidate issued exactly one shared hydration RPC.

| Measurement | Baseline runs | Candidate runs |
| --- | --- | --- |
| Closed canonical output estimate | 144.01 MiB / 144.01 MiB | 6.75 MiB / 6.75 MiB |
| WebContent lifetime peak | 496.9 / 489.6 MiB | 466.8 / 453.1 MiB |
| Current footprint with results closed | 274.6 / 281.0 MiB | 276.8 / 283.7 MiB |
| Current footprint after closing shared view and 3 s idle | 288.3 / 302.2 MiB | 305.3 / 306.3 MiB |

The retained-payload estimate falls from 151,003,008 to 7,078,754 bytes in each
pair. This estimate is the cache's UTF-16 accounting, not a heap profiler's
measurement of each JavaScript string. Native peak was lower in these repeated
fixture runs, but short-idle physical footprint was **not** lower. Releasing
strong references does not force WebKit to immediately return allocator pages.
This is evidence for fixing retained payloads, not a general RAM percentage.

## Whole desktop application

The separate [release Tauri coalition report](whole-app-ram-2026-09-18/REPORT.md)
includes shell, daemon, WebContent, GPU and networking. Its workload has 400
saved turns and 800 saved tools, followed by the same 64 real live results.
Both databases retained identical ordered output hashes. The candidate had
fewer settled WebKit allocated bytes, but peak coalition footprint did not
improve (836.5 versus 875.2 MiB). The pre-turn baselines were also unequal, so
raw settled differences cannot establish overall physical-footprint savings.

The reported 800 MB concern is therefore only partly addressed. The live
retention defect, daemon cache lifetimes and unused opaque-window material are
fixed. Burst serialization/delivery allocations and allocator high-water remain
measurable follow-up work; this patch does not claim to eliminate those peaks.
