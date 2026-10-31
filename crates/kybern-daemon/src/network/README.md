# Machine network transports

Peer sessions keep machine identity, signed membership, short-lived grants and per-machine
policy on one authenticated WebSocket. Port forwarding additionally uses a separate TCP path
when both peers support `ports.direct.v1` and have a direct Tailscale route.

`ports.forward` binds IPv4 loopback locally. With no explicit local port it tries the remote
port and then each higher port. The returned `local_port` is the address the Browser uses.
`--local-port 0` still requests an ephemeral port. No test connection or HTTP page probe runs
before opening a forwarded page. Proxy tickets recognize a bound forward, and each proxied HTTP
request or WebSocket upgrade connects to the upstream once instead of probing and discarding a socket.

`peer.ports.prepare` authorizes the destination without connecting to it. The serving daemon
binds an ephemeral listener exclusively to its Tailscale IP and returns its port and a random
256-bit token. The client derives the IP from the member's recorded Tailscale node. Each TCP
connection sends 64 token bytes, then waits for one success byte before application traffic.
The receiver verifies the token hash, source node with Tailscale whois, live member/session/grant
and current `machine:ports` permission, then connects only to its own IPv4/IPv6 loopback.
Daemon API ports are refused. Direct data listeners bind only to Tailscale, so loopback
forwards cannot reach them (and their port numbers can coexist with unrelated loopback services).

Application bytes use independent TCP sockets and bidirectional copy, preserving upgrades,
half-closes, TLS and non-HTTP protocols. Listener and connection counts are bounded. Stop,
shutdown, membership or policy revocation, session closure and the existing idle timeout
cancel listeners and active sockets. Different clients get independent listeners and tokens.
`peer.ports.release` is scoped to the caller's own forward id, including after ports permission
has been revoked.

Peers lacking the capability or new method, off-tailnet/code-only peers, unavailable Tailscale
listeners and failed direct connections use the existing `peer.ports.open/data/close` transport.
The old stream framing, credit window and authorization are unchanged. No protocol-version
bump is needed. With older peers, destination refusals arrive on the first real connection.

## Reproduce the local benchmark

Use a checkout-local target and scratch data only. The fixture starts real daemon states and
peer sessions on a fake tailnet mapped to loopback; it does not start agent CLIs or use normal
Kybern data. It creates a direct TCP forward and a second forward with a simulated 0.20.x
presence to exercise the original WebSocket transport. `forwards.json` records all three ports
and the elapsed time for opening the direct forward.

```sh
node scripts/bench-port-forward.mjs /tmp/kybern-port-benchmark
pnpm --dir /tmp/kybern-port-benchmark --store-dir /tmp/kybern-port-benchmark/.store install --ignore-scripts
node /tmp/kybern-port-benchmark/server.mjs
```

In another terminal, from the repository root:

```sh
CARGO_TARGET_DIR="$PWD/target" CARGO_INCREMENTAL=0 \
KYBERN_PORT_BENCHMARK_ROOT=/tmp/kybern-port-benchmark \
cargo test -p kybern-daemon port_forward_benchmark_fixture -- --ignored --nocapture
```

After `forwards.json` appears, run in Ego Lite (the ego-browser skill documents its setup):

```sh
ego-browser nodejs -e "await (await import('file://$PWD/scripts/bench-port-forward-browser.mjs')).benchmark('/tmp/kybern-port-benchmark')"
```

The page imports 300 JavaScript modules with 2 KiB payloads. Measurements are medians of
12 cache-disabled browser navigations after a warmup per route, with route order rotated each
round, and 30 HMR updates per route at 100 ms spacing. Vite transformations are warm. HMR
measures the browser's POST that changes a watched source file, the WebSocket update, module
fetch and evaluation. `browser-results.json` retains samples; the fixture exits when `done`
appears. Pass `true` as the second benchmark argument to invalidate Vite's transform cache
before each measured navigation. This excludes Vite process startup and server configuration.

## Measure across machines

Do not compile on a serving machine low on disk. Install the candidate daemon built elsewhere,
and use scratch daemon data on both machines. Join the scratch pair with `machines code` and
`machines join <code> <address>`; enable ports permission on the server. Keep production data
and daemons running normally.

Copy only `scripts/bench-port-forward.mjs` to the serving machine. Reuse its installed Vite
dependencies when disk is below the project budget; install the scratch dependency only after
freeing enough space. Otherwise run the first three commands above there. Vite binds `127.0.0.1:58173`; it needs no `--host` option. On the client:

```sh
kybern --data-dir /absolute/client-scratch --json ports forward instabox 58173
```

Use the returned port in `http://localhost:<local_port>/`. For a direct reference to the same
loopback-only server, use an independent SSH forward to the server (or compare with a separate
Vite instance bound to its Tailscale IP if testing native Tailscale TCP). For the old-transport
baseline, repeat with an otherwise identical scratch 0.20.x serving daemon. Stop the existing
forward before switching serving daemons. Record RTT, direct-vs-DERP Tailscale route, CPU,
server/browser versions, cache boundary, sample counts, first-load and HMR medians and tails.
The raw loopback benchmark does not establish latency or throughput across a real tailnet.

Clean scratch apps, installs, daemon data and task build output after preserving results.
