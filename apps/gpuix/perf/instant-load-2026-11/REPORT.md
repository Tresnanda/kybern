# Instant thread and list loading in GPUIX (#248)

## Workload, hardware, runtime
- Windows 11 desktop "SatyaMas" (16 logical cores, RTX 3060, NVMe), Bun 1.4.3, patched native addon built from `native/FORK` (release). The automation harness reports software rendering for its captures off macOS; the window renders through Direct3D 11.
- Fixture (`fixture.ts`): 20 projects × 50 threads (1,000 threads, 32,101 events). Measured threads: short (4 turns), medium (200 turns, 2 KB tool outputs), long (3,000 turns, 15,120 events, 5 KB tool outputs). No agent runs.
- Daemons: "old" = origin/main 0.21.8 (no #248 protocol); "new" = this branch (list cursors, `page_budget`, `as_of_seq`, `gap_snapshot`). Both debug builds.
- "Before" = origin/main's GPUIX. Headless: its call sequence replayed in `flows.ts`. In app: a copy of origin/main's `apps/gpuix` with only the trace marks added. "After" = this branch. Other builds and tests ran on the same machine during some runs, so p95 values are noisy.

## How it was measured
- Headless (`bench.ts`): GPUIX's own `KybernClient`, socket factory and projection code. Click → first drawable content, round trips and WebSocket bytes before it, click → live. 8 fresh daemons per variant (5 for RTT), 5 warm repeats each. `rtt40` = `linkProxy`, 40 ms RTT and 20 Mbit/s each way: a stand-in, not the relay route.
- In app (`app-bench.ts`): real window, scratch daemon, `KYBERN_STARTUP_TRACE=1`, rows clicked through automation. "content" = `thread-click` → `thread-first-content`. "painted" = bench clock from the click call until the newest answer's heading is in the painted text; it includes the click round trip and poll interval. One untimed warm-up launch first; launch 1 has no transcript cache, launch 2 reuses it.

## Results (median / p95)
Headless, loopback:

| Case | Before | After | After, disk cache only | After, old daemon |
|---|---|---|---|---|
| Cold lists | 984 / 1632 ms, 425 KB, 1,000 rows | 796 / 1440 ms, 217 KB, 500 rows | 729 / 1243 | 822 / 1365, 425 KB |
| Restore long, never seen | 2452 ms, 522 KB | 1651 ms, 283 KB | 2022 | 2259 |
| Restore long, relaunch | 2031 / 2862 ms | **0.5 / 19 ms** | 0.5 / 6 | 0.6 / 0.7 |
| Medium first page, never seen | 119 ms, 52 KB | 78 ms, 20 KB | 125 | 101 |
| Small thread never seen | 8.0 / 16 ms | 8.5 / 19 ms | 9.4 / 16 | 6.7 / 7.7 |
| List refresh | 611 / 1513 ms, 428 KB | **3.4 / 5.7 ms, 7 KB** | 3.3 / 10 | 569 / 1069 |
| Reopen short / medium / long | 4.5 / 15 / 33 ms | **0 ms** (session) | 0.3 / 0.4 / 0.4 (disk) | 0.4 / 0.6 / 0.6 |

40 ms RTT, 20 Mbit/s:

| Case | Before | After (disk cache) |
|---|---|---|
| Cold lists | 1242 / 1476 ms, 425 KB | 1104 / 1539 ms, 217 KB |
| Restore long, relaunch | 1894 / 1956 ms | **0.6 / 0.8 ms** |
| Medium first page, never seen | 191 ms | 146 ms |
| Small thread never seen | 54 / 62 ms | 60 / 64 ms |
| List refresh | 1697 / 3705 ms, 479 KB | **49 / 139 ms, 7 KB** |
| Reopen short / medium / long | 51 / 80 / 116 ms | **0.4 ms** (live after 44 ms) |

In app, loopback:

| Case | Before | After |
|---|---|---|
| Click → content, launch 1 (short / medium / long) | 92 / 69 / 58 ms | **3 / 3 / 3 ms** (prefetched or lingering) |
| Click → painted, launch 1 | 318 / 361 / 335 (p95 544 / 767 / 605) | 203 / 223 / 240 (p95 291 / 264 / 252) |
| Click → content, launch 2 | 76 / 62 / 59 ms | **4 / 3 / 3 ms** |
| Click → painted, launch 2 | 258 / 326 / 310 ms | 283 / 246 / 257 ms |
| Spawn → restored long drawn, launch 2 | 4147 ms (daemon) | 3277 ms (cache) |
| Spawn → lists ready, launch 1 / 2 | 5055 / 4578 ms | 4561 / 3526 ms |

Raw data is in `results/*.json`. Generate tables with `bun summary.ts <before> <after>`.

## What changed
1. **List refreshes:** each `threads.changed` or activity change used to read the whole list (1,000 rows, 430 KB, ~400 ms) plus `projects.list` with Git probes (550–900 ms for 20 projects on Windows). Now the first read is `threads.list {settled_limit: 25}`, later reads are `{since_seq}` merged by `threadListCursor` (unchanged rows keep their objects), and Git probes run only once after launch and on `projects.changed`.
2. **Opens draw something first:** in order, a session kept 5 minutes after its pane moved on (the 8 most recently viewed running threads stay subscribed), a prefetched first page (rows on screen, at most 6, two at a time, after launch settles; a hovered row after 120 ms), or the bun:sqlite disk cache (64 threads / 64 MB, whole turns, ≤ 600 rows each). The stream then resumes from the cached cursor: a short replay, or one fresh page (`gap_snapshot`) when the gap is large. Unchanged rows keep their objects.
3. **Unseen threads take one round trip:** `events.subscribe` and `threads.get` go out together. Events are buffered and anything at or below the page is dropped. If `as_of_seq` does not cover the subscription head, `events.range` fills the gap. Daemons known to lack the protocol keep the old order.
4. **Pages sized by turns and bytes** (`page_budget`: 10 turns, 500 rows, 1 MiB): the long thread's first page is 40 rows and 283 KB instead of 120 rows and 522 KB.
5. **No spinner for quick loads:** the loader is the delayed sync indicator (shows after 400 ms, stays ≥ 400 ms) and never shows over a cached copy.

## Targets
- Recently seen thread: content ready in 0–4 ms. In-app paint is now dominated by drawing the transcript (~80–110 ms from content to the next frame here) plus automation latency; the 60–90 ms network share is gone.
- Unseen local thread < 300 ms: 8.5 ms headless; 78 ms for the 200-turn thread.

## Limitations and follow-ups
- Relaunch waits for the daemon connection before drawing the cache (3.3 s from spawn, mostly app start and endpoint resolution).
- Prefetch covers connected machines only. Archive-forget is local only; other machines' records age out by LRU.
- "painted" includes automation latency; compare before vs after only. Paint cost itself was not changed or profiled.
- The RTT stand-in ignores relay hops, TLS and compression; README has the direct and relay steps. Mobile/iPad timings come from the mobile dev timer (`apps/mobile/perf/instant-load-2026-11.md`).
- Only one cold sample per variant for "never seen".
