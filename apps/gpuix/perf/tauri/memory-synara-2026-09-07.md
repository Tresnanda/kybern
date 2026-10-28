# RAM audit and Synara 0.8.2 review

The larger follow-ups below are now implemented and measured in the
[before/after report](memory-before-after-2026-09-07.md). This document preserves
the initial audit and its original measurements.

Reviewed Kybern v0.2.2 (`487d7c9`) on an Apple M1 MacBookPro17,1, 16 GiB RAM,
macOS 27.0 (26A5416b). Work is isolated on `codex/desktop-rendering-windows-memory`.
The installed app, daemon, credentials and production database were not changed,
restarted or driven by tests. Native fixtures use a nonpersistent WKWebView and
synthetic data, the production CSP, and a separate temporary asset build.
The repository's referenced `docs/design.md` and `docs/architecture.md` are absent
from this checkout; the current performance guide, kit and source were used.

## Passive process measurements

`ps` RSS snapshot followed by `vmmap -summary` physical-footprint snapshots at
10:18 local time on 2026-09-07. These describe an existing user session; its
workload was not controlled. Physical footprint includes charged/compressed
memory and is not interchangeable with RSS or JavaScript heap size.

| Process | Initial RSS (MiB) | Physical footprint | Lifetime peak footprint |
| --- | ---: | ---: | ---: |
| Installed daemon, PID 10667 | 17.8 | 15.2 MiB | 21.8 MiB |
| Installed desktop shell, PID 10211 | 127.3 | 53.4 MiB | 54.0 MiB |
| WebContent, PID 10221 | 344.3 | 374.9 MiB | 796.1 MiB |

The WebContent association is inferred from its launch immediately after the
Kybern shell; WebKit XPC processes have launchd as their parent. Other WebKit
processes were not assigned to Kybern or summed. RSS changed during compilation
and normal user activity; this is **not** a before/after optimization comparison.
The lifetime peak is not evidence of a leak. No private transcript was exported.

## Findings and priorities

1. **Renderer data retention is the first follow-up.** `state/store.ts` retains
   every visited environment store. Each holds loaded transcripts, tool outputs,
   diffs and runtime tasks. `state/rpc.ts:onEvent` folds all subscribed thread
   events, including background threads, and loads two diff summaries on turn
   completion. DOM virtualization bounds mounted rows, not this retained data.
   Add byte-aware eviction for inactive transcript/diff data, and compact
   background summaries, with rehydration tests for approvals, cursors, split
   panes and late replies. Preserve composer drafts and queued messages.
2. **Images need a decode budget, beyond CSS.** Full raster files can be large
   even with a small visual preview. This branch defers local image requests
   until within 300 px of the viewport, keeps a 280 × 176 slot to prevent layout
   shifts, and retains abort/revoke cleanup on unmount. A server thumbnail path
   with pixel limits is the next improvement; the viewer should fetch the
   original only when opened. Inline base64 still lives in transcript payloads.
3. **Daemon discovery cache now has a cardinality bound.** It already had a
   60-second TTL and coalesced refreshes, but could retain an arbitrary number
   of project/settings keys inside that period. This branch caps it at 32,
   evicting the oldest refreshed entry. A test verifies eviction, reloading and
   the cap; existing tests preserve forced refresh and concurrent deduplication.
   This is a retention bound, not a measured whole-daemon percentage saving.
4. **Transport budgets merit a stress fixture.** The daemon event bus holds up
   to 8,192 events, and terminal broadcasts up to 4,096 chunks per terminal
   (reads are up to 8 KiB), in addition to 512 KiB scrollback. Slow subscribers
   can retain large payloads despite count bounds. Measure byte occupancy and
   lag recovery before reducing limits; blindly dropping events risks history
   or terminal gaps. Exited terminal retention is already ten minutes, and
   agent/terminal idle release already exists.
5. **Worker caches are bounded but estimates are incomplete.** Markdown caches
   budget source/signature strings, not the full AST or parser allocations.
   Highlighted HTML has a 4 MiB budget; grammar/runtime memory remains until
   worker termination. Measure idle worker release and actual retained heap on
   a corpus with many grammars before choosing an idle timeout.
6. **Each new window owns a renderer and connection.** This is intentional for
   independent environments. It adds memory per window; it is not a RAM
   optimization. Closing one window releases its renderer without stopping
   the daemon or another window's connection. SSH tunnels are shared by profile.

## Synara: what applies

Reviewed the [v0.8.2 release](https://github.com/Emanuele-web04/synara/releases/tag/v0.8.2)
and its [v0.8.1 comparison](https://github.com/Emanuele-web04/synara/compare/v0.8.1...v0.8.2).
The release points to a [concurrent-stream experiment](https://github.com/Emanuele-web04/synara/blob/v0.8.2/docs/performance/2026-09-05-concurrent-threads/report.md)
with roughly 18–19% lower end-of-sample renderer RSS. That is an isolated
Chromium component experiment, not a whole-app or WebKit prediction.

| Synara change | Kybern implication |
| --- | --- |
| Stable Markdown components and settled message identity | Already shipped: `Markdown.tsx`, turn grouping, memoized rows and native identity checks. Preserve these. |
| Fewer streaming updates and narrower subscriptions | Paced reveal is shipped; event ingestion still folds each background event. Profile ingestion separately from the reveal loop. |
| Cached/deduplicated provider discovery | Already present in daemon and renderer. This branch adds a daemon entry cap. Per-key parallel refresh would need provider process concurrency controls. |
| Shared natural collator | No matching repeated numeric locale-option comparator found in Kybern's desktop source. Do not copy without a matching workload. |
| One-pass browser diagnostic byte accounting | The pinned diff confirms removal of repeated stringify/slice loops in Synara's Electron diagnostics. Kybern has no matching Electron diagnostics store; apply byte budgeting to its own transports instead. |
| Native TypeScript checks | Development speed, not runtime RAM; no toolchain migration proposed here. |

No Synara code was copied. Its measurements support testing allocation and
retention separately from mounted UI count, rather than promising the same
percentage reduction for Kybern.

## Verification

- Frontend unit tests, typecheck, lint and production build passed. Build retains
  existing chunk-size and ineffective-dynamic-import advisories.
- Native artifact checks cover delayed portrait/landscape loads, dark/light
  synthetic question-form images, multiple attachments, full viewer routing,
  offscreen deferral including a 40-image response, retry/recovery, unbroken short table cells and local table
  overflow at 320 px. The original issue's two screenshots were not attached;
  synthetic equivalents were used.
- Native streaming checks retain 30/30 code blocks, exact final output, wrap
  state and reading position; sampled frame p95 was 18 ms. One synthetic run,
  not a controlled performance comparison.
- Native interaction checks passed navigation, selection, focus, prepend,
  wrapping, follow, resizing and virtualized tools.
- Environment window configuration tests verify unique permitted labels,
  preserved window styling and correctly encoded profile-only URLs. Window
  selection is stored in each window URL so sibling changes cannot redirect a
  reload. Packaged multiwindow end-to-end testing is not performed against the
  running production app.

Rust checks: 12 desktop unit tests passed (one SSH integration test ignored);
three daemon cache tests passed; Clippy passed for both affected library crates
with warnings denied, and workspace formatting passed.
