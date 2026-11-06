# Instant loading part 2 (#253): measurement gate

Measured on 2026-11-07 against `82e0baa0` (0.22.1, including #280).
This is a measurement-only change. No coalescing, read-table migration, wire
method, client rendering change, or additional list cache ships here.

## Setup and boundaries

- Windows 11 Home 10.0.26300; Ryzen 7 5800H, 16 logical processors, 15 GiB
  usable RAM; RTX 3060 Laptop GPU / Radeon integrated graphics. GPU unused by
  these headless measurements. Rust 1.99.1, workspace release profile (thin LTO,
  one codegen unit), Bun 1.4.3, Node 24.13.0.
- Reused `fixture.ts`: 20 projects, 1,000 threads, 32,101 events; short 4 turns,
  medium 200 turns, long 3,000 turns / 15,120 events. Synthetic content only.
- Reused `scratch.ts`, `meter.ts`, `bench.ts`, and the production `instant`
  flow. Every daemon has a fresh scratch data directory, isolated client
  configuration, and a port in 4420–4429. No normal daemon or app was stopped.
- Read microbenchmark: ten fresh daemon processes per route condition. Each
  thread is read once with an empty daemon projection cache, then immediately
  again with that cache warm. Ten-turn / 500-row / 1 MiB page budget.
  Timing includes socket send, daemon work, serialization, transport and parsed
  response; it excludes React, Markdown, native layout and drawing. It does not
  establish a first-frame result. OS file cache is uncontrolled, so “cold” means
  daemon-cache cold, not cold storage.
- `linkProxy` adds 40 ms RTT and 20 Mbit/s. It is a sensitivity experiment,
  **not** a real Tailscale direct connection or Kybern relay. No remote machine
  was reconfigured to join this scratch network.
- Other tasks used this machine during preparation; distributions are
  descriptive, not a controlled hardware regression threshold. Debug 0.22.0
  results in `REPORT.md` are not a comparable before for this release build.

## Results and decisions

| RPC workload (n = 10 each) | Added RTT | Median / p95 | Response JSON bytes | Dependency depth |
|---|---:|---:|---:|---:|
| long-cold | 0 ms | 120.2 / 134.6 ms | 67269 | 1 |
| long-warm | 0 ms | 1.7 / 2.4 ms | 67269 | 1 |
| medium-cold | 0 ms | 6.1 / 9.1 ms | 20345 | 1 |
| medium-warm | 0 ms | 0.7 / 1.0 ms | 20345 | 1 |
| short-cold | 0 ms | 1.0 / 1.2 ms | 10611 | 1 |
| short-warm | 0 ms | 0.5 / 0.6 ms | 10611 | 1 |
| list-head-parallel | 0 ms | 36.4 / 45.3 ms | 221426 | 1 |
| list-head-serial | 0 ms | 36.1 / 58.6 ms | 221428 | 2 |
| long-cold | 40 ms | 193.5 / 225.3 ms | 67269 | 1 |
| long-warm | 40 ms | 71.5 / 72.3 ms | 67269 | 1 |
| medium-cold | 40 ms | 57.6 / 60.9 ms | 20345 | 1 |
| medium-warm | 40 ms | 51.3 / 51.9 ms | 20345 | 1 |
| short-cold | 40 ms | 47.7 / 48.0 ms | 10611 | 1 |
| short-warm | 40 ms | 46.8 / 47.5 ms | 10611 | 1 |
| list-head-parallel | 40 ms | 168.0 / 195.5 ms | 221426 | 1 |
| list-head-serial | 40 ms | 210.1 / 239.0 ms | 221428 | 2 |

List/head timings end when **both** calls finish; they are not time to the head response alone. These are existing-code baselines. After is not applicable: no optimization was implemented.

The reused production-flow bench (eight fresh daemons, three warm repeats each) gives:

| Headless content boundary | n | Median / p95 |
|---|---:|---:|
| Cold lists, 500 rows | 8 | 44.1 / 53.2 ms |
| Never-seen long restore, alongside lists | 1 | 164.2 ms (single sample) |
| Long restore from disk cache, later launches | 7 | 0.3 / 0.6 ms |
| Unseen small thread | 8 | 1.2 / 1.6 ms |
| Cursor list refresh, 6,925 JSON bytes | 24 | 0.7 / 1.0 ms |
| Reopen from lingering session, each size | 24 | <0.1 / <0.1 ms |

These include projection/cache decoding, but exclude rendering. Disk-cache first content and becoming live are different boundaries: the aggregate long-restore live median is 159.7 ms. The raw file's cold-restore aggregate mixes the initial miss and seven cache hits; the table separates them.

The fixture now normalizes offline edits' list cursors when built with a new-schema daemon. Without that correction its final timestamp edit stamps every row beyond the event head, causing full lists on every refresh; a fixture created with the old daemon and then migrated did not have this artifact. This changes benchmark setup only.

### Streaming deltas: defer implementation

The production subscription path (`ws.rs`) sends each event separately; replay
is bounded, sequence ordered, and completes before live delivery. Shared-client
reconnect uses the last received event sequence. Coalescing must concatenate
compatible deltas, keep the last represented sequence, preserve intervening
non-delta event order, and flush before completion. Dropping earlier delta text
would lose content. No change was made to any of those contracts.

`part-2-stream-model.ts` measures JSON parsing plus `applyEvent` for ten seconds
of synthetic input (one assistant message, no history, 15 characters per delta) delivered synchronously, for 20/50/100/200 deltas per second.
It models batching compatible deltas into groups approximating 50 ms, retaining
the final sequence, and asserts identical final text and cursor. It does **not**
measure actual provider emission rate, socket scheduling, remote delivery or
the paced display. Bytes are UTF-8 application JSON; framing, TLS and relay
envelopes are excluded.

| Synthetic input | Group size | JSON messages/s | JSON bytes/s | Parse + fold median / p95, ms per 10 s input |
|---|---:|---:|---:|---:|
| 20 deltas/s | 1 | 20 | 7649 | 0.195 / 0.314 |
| 50 deltas/s | 1 | 50 | 19139 | 0.236 / 1.491 |
| 50 deltas/s | 2 | 25 | 9945 | 0.095 / 0.130 |
| 100 deltas/s | 1 | 100 | 38289 | 0.419 / 1.404 |
| 100 deltas/s | 5 | 20 | 8858 | 0.090 / 0.140 |
| 200 deltas/s | 1 | 200 | 76689 | 0.820 / 1.727 |
| 200 deltas/s | 10 | 20 | 10369 | 0.078 / 0.129 |

This shows potential bandwidth savings at high input rates, but does not
establish that an actual fast turn reaches those rates or that the client is
frame limited by applying them. Windows process CPU accounting was quantized
to zero for these short batches; zero is not evidence of zero CPU use.
No before/after production number exists because no implementation was made.

**Missing acceptance evidence:** actual fast-turn messages/s and bytes/s on
both direct Tailscale and real relay; client CPU and frame intervals during
those turns; exact final content/resume under disconnect; paced streaming
smoothness. Mac first-frame and iPadOS frame/interaction measurements require
those devices. They cannot be inferred from this Windows headless benchmark.
This item remains unvalidated, rather than disproved.

### Persisted read tables

Do not add persisted read tables on this evidence. A 3,000-turn cold read costs 120.2 ms median / 134.6 ms p95 over loopback versus 1.7 / 2.4 ms warm. The cold cost is visible, but remains below the 300 ms unseen-local target at this RPC boundary. The shaped-link cold read is 193.5 / 225.3 ms; that is not proof of the real relay target. A write-path migration is not justified by the measured local read cost. Mac/iPad first-frame targets remain unmeasured.

### Combined list and transcript head

`openFlow.ts` already sends subscription and uncached transcript reads together.
`state.ts` restores a known thread alongside list loading; prefetched or cached
threads draw before network freshness. The six-row prefetch queue runs with
two requests in flight; list cursors avoid full refreshes. #280's peer-list
observations are already present and were not duplicated.

The list/head experiment compares two independent calls sent concurrently with
the same calls artificially serialized, with the daemon's short-thread cache
warm. Its serial result describes the cost of introducing a dependency; it is
not the shipping flow. A combined RPC cannot recover an extra round trip that
the shipping flow does not wait for. No new RPC is justified by these results.
Discovery of an unknown thread ID can still depend on its list response; a
combined method needs a defined selection rule and a measured user journey
before adding protocol surface for that case.

## Reproduction

Run from the repository root, with `TEMP`, `TMP` and `CARGO_TARGET_DIR` inside
this worktree and a scratch `KYBERN_CLIENT_CONFIG_DIR`. Use an absolute path
for the daemon argument on Windows.

```powershell
cargo build -p kybern --release
bun apps/gpuix/perf/instant-load-2026-11/fixture.ts --daemon <absolute-kybernd>
bun apps/gpuix/perf/instant-load-2026-11/part-2-reads.ts <absolute-kybernd>
bun apps/gpuix/perf/instant-load-2026-11/part-2-stream-model.ts
cd apps/gpuix
bun perf/instant-load-2026-11/bench.ts --daemon <absolute-kybernd> --flow instant --label part-2-current --runs 8 --warm 3
```

Raw samples and summary metadata are in `results/part-2-*.json`.

## Validation and resource accounting

- Release daemon build: passed.
- `cargo fmt --all --check`: passed.
- `cargo clippy --workspace -- -D warnings`: passed.
- Frozen GPUIX dependency install and `pnpm typecheck`: passed.
- Shared-client Node tests: 721 passed.
- GPUIX Bun tests on this Windows baseline: 1,721 passed, 14 skipped, **34 failed**. Failures include Unix executable/permission assumptions, drive-letter URL paths, platform-specific theme defaults and image behavior. No product source was modified; these failures remain unresolved here. PR CI runs the suite on Linux.
- All benchmark runs completed; the streaming model asserts exact text and final cursor. No Rust crate is affected, so nextest and protocol snapshot updates are not applicable.

No product code or wire schema changed; protocol snapshots and mobile changes
are not needed. CPU, React commit time, frame intervals, input latency and
energy were not measured for the application. No energy or visual performance
claim follows from the RPC results. No native addon build was needed.

D: free space was 275.58 GiB before work and 274.35 GiB after validation. No task-owned binary or build remained running at the cleanup check. The execution policy rejected recursive removal of the verified task-owned target directory (blocked by policy), including an explicit absolute-path removal. Consequently target/ (2.14 GiB), apps/gpuix/node_modules/ (0.34 GiB), and .scratch/ (0.11 GiB) remain in this worktree. These generated files are excluded from the commit; cleanup remains outstanding. Other tasks changed free space concurrently, so the free-space delta is not attributed solely to this task.
