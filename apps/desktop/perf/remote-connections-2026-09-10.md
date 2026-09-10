# Remote connections and live work — 2026-09-10

Local source changes for phone → daemon and desktop → daemon. Tested with
scratch data, local sockets, native WebKit, and an iOS simulator. The reported
physical-device/network disconnect cause remains unconfirmed. Nothing deployed.

## Changes

- Both clients reuse loaded session snapshots after event replay completes.
  The daemon now advertises `replay_ready` and emits `events.ready` after every
  replay event, before live delivery. Acknowledgement alone is not sufficient.
  Loaded inactive threads receive events too; existing cache eviction stays in
  place. Interrupted/incomplete loads remain stale. Old daemons refresh snapshots.
  A cursor ahead of restored history resets the subscription and reloads state.
- Desktop initially requests 60 transcript entries and provides **Load earlier
  messages**. Pages freeze `through_seq`, buffer concurrent events, deduplicate
  overlaps, and preserve unchanged row identities. Unfinished older work remains
  included. Refresh preserves the amount of history already browsed; above the
  daemon's 500-entry page limit it uses the legacy full-history response.
- Daemon read projections are cached by thread and exact sequence, with 16 slots,
  a 32 MiB estimated retained-data budget, and at most two concurrent builds.
  Same-head requests share a build. Page reads clone only selected rows. Errors
  and oversized projections are not retained. Approvals and notes remain current
  database reads. Cold/new-head reads still project the full event history;
  this is not an incremental or disk-backed projection.
- Mobile workspace lists publish independently of slow provider discovery.
- Shared skill discovery caches successful results for 60 seconds, shares pending
  requests, and bounds the cache to 24 project/provider keys per verified client.
  Errors evict; close and local settings/integration changes clear the cache.
  Changes from other devices may take up to the TTL to appear; cold discovery
  can still start a provider process.
- Consecutive successful completed tools collapse during running turns on both
  clients. Narration, active tools, failures, approvals, and mobile agent launches
  remain visible. Expanded work uses virtual rows. Desktop closed tool groups now
  unmount through the existing kit Collapsible exit transition.

The replay capability is additive and has schema snapshots. Updated clients and
an updated daemon are required for replay-based cache reuse. Older combinations
retain snapshot fallback and ignore unknown notifications.

## Evidence

Apple M1, macOS 27.0 (26A5416b). Local Rust test-profile daemon and Rust WebSocket
client, temporary SQLite database, 2,000 notice entries (~13.1 MB response).
One sequential sample per row; cache cold/warm refers to the projection cache,
not the filesystem. Timings measure the awaited RPC including transfer and decode.

| Request | Entries | JSON response bytes | RPC ms |
| --- | ---: | ---: | ---: |
| Recent, cold projection | 60 | 393,623 | 310.2 |
| Recent, warm projection | 60 | 393,623 | 16.9 |
| Full, warm projection | 2,000 | 13,098,374 | 547.2 |
| Recent, warm repeat | 60 | 393,623 | 17.5 |

Reproduce with `cargo test -p kybern-daemon measure_remote_history_pages -- --ignored --nocapture`.
This compares request shapes in the updated code, not an old/new release benchmark.
The page is ~97% smaller. CPU, frame intervals, commit time, input latency, and
energy were not measured by this RPC workload. Concurrent build tools were used
elsewhere during the session; these single samples are not stable latency estimates.

Native mobile check: iPhone 17 Pro simulator, iOS 27, Expo Go 57.0.9, production
mode/minified JavaScript, local fixture `apps/mobile/perf/reconnect-server.mjs`.
The fixture delays each `threads.get` by 1.8 seconds. Opening the thread, expanding
and collapsing eight completed steps, forcing a socket disconnect with a missed
assistant delta, and reopening the thread left `threads.get` at **1** while
`events.subscribe` advanced from **1** to **2**. The missed delta appeared exactly,
with the existing heading/table and active tool readable. Screenshot:
`artifacts/remote-connections-20260910/ios-reconnected.jpg` (untracked artifact).

Run the fixture from the mobile folder with `node perf/reconnect-server.mjs`,
start Expo Go on a free local port, and open its `/pair` route using the fixture's
printed address/code. `GET /stats` reports RPC counts; `POST /disconnect` appends
one missed update and closes sockets. It uses synthetic content and binds loopback.
Stop the fixture and Metro afterward; never use normal daemon data for this check.

Regression coverage includes replay ordering (600 events before the ready marker,
then live delivery), filtered empty replay, stale markers, legacy fallback,
restored-history reset, exact sequence-bounded page reconstruction, live changes
during paging, cache bounds/failures, skill request isolation, and cached reconnects
in both actual client runtimes. Desktop 115 tests and mobile 71 tests pass, along
with affected Rust package tests, workspace Clippy, type checks, desktop lint/build,
Expo Doctor (21 checks), and Android/iOS exports.

Native WebKit interaction coverage under the production CSP checks formatted
Markdown, navigation, selection/focus, wrapping, history prepends, reading position,
follow behavior, disclosure persistence, and live grouping of 800 tools. The history
control belongs to the virtual list so removing it at the oldest page participates
in the same reading-position anchoring as prepended messages.

## Remaining limits

Transcript caches are session-local. Switching environments or restarting an app
still needs server hydration; there is no durable offline conversation cache.
Cold/new-head host projection and first skill discovery remain potentially costly.
A production-CSP fixture and an Expo Go simulator are not a packaged desktop or
Android release test. Dynamic Type, VoiceOver, physical-phone sleep/wake, VPN/LAN
changes, packet loss, and sustained remote output remain unverified.

The shared heartbeat permits 10 seconds for daemon-info. Large ordered responses
or a saturated host could delay it, but this is a hypothesis. Before changing
heartbeat thresholds, capture close codes, heartbeat RTT, snapshot sizes,
projection duration and replay completion on the actual failing links. Do not
record tokens or transcript contents. Identity verification, native authorization,
browser tickets, and the rule against resending disconnected mutations are retained.

Referenced `docs/architecture.md` and `docs/design.md` are absent in this checkout;
existing components and current performance reports supplied the conventions.
