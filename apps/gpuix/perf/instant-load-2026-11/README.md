# Instant thread and list loading (#248): GPUIX bench

Scratch-only. Everything lives under `<worktree>/.scratch/gpuix` (git-ignored by
nothing: never commit it) and uses ports 4420-4429. The scripts refuse any other
folder and `~/.kybern`. No agent is ever launched.

| File | What |
| --- | --- |
| `scratch.ts` | Scratch daemon start/stop, fresh fixture copies, the folder and port guards |
| `fixture.ts` | 20 projects × 50 threads (1,000), a short (4 turns), medium (200) and long (3,000 turns, 15k events, ~5 KB tool outputs) thread |
| `meter.ts` | GPUIX's own socket factory and `KybernClient`, every frame and call counted; `linkProxy` adds round-trip time and bandwidth |
| `flows.ts` | `current`: origin/main's GPUIX call sequence, replayed |
| `instant.ts` | `instant`: this branch's code, imported (`src/transcript/openFlow.ts`, `diskCache.ts`, `threadListCursor`) |
| `bench.ts` | Headless click → first content, round trips, bytes; median / p95 |
| `app-bench.ts` | The real window with `KYBERN_STARTUP_TRACE=1`; rows clicked through the automation client |
| `results/` | JSON of every run (raw samples and timelines) |

## Commands

From `apps/gpuix` after `pnpm install --frozen-lockfile` (and `native/update.sh`
for `app-bench.ts`). `<old>` is a daemon without the #248 protocol (any
0.21.6–0.21.8 `kybernd`), `<new>` this branch's `target/debug/kybernd`.

```sh
bun perf/instant-load-2026-11/fixture.ts --daemon <old>            # once; --force rebuilds
# Headless, loopback:
bun perf/instant-load-2026-11/bench.ts --daemon <old> --flow current --label baseline
bun perf/instant-load-2026-11/bench.ts --daemon <new> --flow instant --label after
bun perf/instant-load-2026-11/bench.ts --daemon <new> --flow instant --label after-nolinger --linger 0
bun perf/instant-load-2026-11/bench.ts --daemon <old> --flow instant --label after-olddaemon --linger 0
# A remote stand-in: 40 ms round trip, 20 Mbit/s each way, through linkProxy:
bun perf/instant-load-2026-11/bench.ts --daemon <old> --flow current --label baseline --rtt 40 --mbps 20 --runs 5 --warm 3
bun perf/instant-load-2026-11/bench.ts --daemon <new> --flow instant --label after --rtt 40 --mbps 20 --runs 5 --warm 3
# In the app (window in the background, KYBERN_NO_ACTIVATE=1). The baseline runs origin/main's apps/gpuix from a
# copy (git archive of apps/gpuix, packages, scripts, assets and Cargo.toml, with this checkout's node_modules and
# native/build linked in, <old> copied to the copy's target/debug, and the three trace-mark edits of src/perf/startup.ts,
# nav/history.ts and state.ts applied) through --app:
bun perf/instant-load-2026-11/app-bench.ts --daemon <old> --label baseline --app <copy>/apps/gpuix/src/main.tsx --warmup
bun perf/instant-load-2026-11/app-bench.ts --daemon <new> --label after --warmup
# Before/after table:
bun perf/instant-load-2026-11/summary.ts perf/instant-load-2026-11/results/baseline.json perf/instant-load-2026-11/results/after.json
```

The fixture is written with `<old>` so every variant starts from the same
schema; a newer daemon migrates its own copy. Each bench run copies the pristine
fixture and starts a fresh daemon (projection caches cold). The instant flow's
transcript cache is a scratch SQLite file that persists across the runs of one
invocation (so run 2+ starts with the long thread cached, like a relaunch).

Cases: `cold-lists` / `cold-restore-long` (the lists and the restored long
thread together right after connecting, as on launch), `first-open-*` (first
open of a thread on that daemon), `unseen-open-small` (a thread this client
never opened), `warm-list-refresh` (what a `threads.changed` or activity change
costs), `reopen-*` (a thread opened before). `ms` is click → first drawable
content (`seedFromGet`/cache decode included, React and paint not); `liveMs` is
click → subscribed with replay done. `bytes` are WebSocket text characters
received between the click and the first content (≈ bytes; JSON is ASCII here).

## Real remote machines (to measure on the Mac and the iPad)

`linkProxy` only delays and throttles frames; it is not the relay route. For the
real numbers:

1. **Direct (tailnet / LAN):** start a scratch daemon on another machine with the
   fixture copied over (`--data-dir <copy> --port 4424`, listen on the tailnet
   address per `docs/architecture.md`), pair it from a scratch GPUIX config
   (`KYBERN_CLIENT_CONFIG_DIR=<scratch>`), then run
   `bench.ts --flow current|instant --url ws://<host>:4424/ws --token <its daemon.token> --label remote-direct`
   (the fixture's ids come from the local `fixture-pristine/fixture.json`, so copy
   that same folder over), or open its threads in the app with
   `KYBERN_STARTUP_TRACE=1` and read the `thread-click` → `thread-first-content`
   marks (rows of another machine carry its glyph).
2. **Relay:** two scratch daemons networked (machine A local, machine B remote,
   B reachable only through A): enrol both into one network from the scratch
   client (Settings → Machines), confirm the route says "relay", and repeat 1.
   The `relay` hop adds one more WebSocket; compare `liveMs` with direct.
3. **iPad / mobile:** the mobile stream's own bench (`apps/mobile/perf/`); use
   the same fixture so the rows and pages match.

Record the RTT (`ping`), the route, the daemon versions and the hardware with
every number.
