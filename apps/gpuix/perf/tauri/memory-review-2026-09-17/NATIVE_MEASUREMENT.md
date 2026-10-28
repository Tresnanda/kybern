# Measurement method and reproduction

Integration update: [PR #31](https://github.com/Tresnanda/kybern/pull/31) includes
this scoped implementation and the separately reviewed allocator/icon/release
changes. The [0.4.3 report](../release-0.4.3-2026-09-17.md#completed-runtime-isolated-tauri-pair)
records the corrected native anchor implementation, passing final CI and native
checks, completed production Tauri workflows, exact binary hashes, and mixed
frontend memory results. The original measurements and blockers below are
historical and must not be presented as the final integration status.
Page-aware reconstruction remains outstanding.

## Isolation and builds

Baseline: `c85f3bfd35c0fa55d3a99eccbaf86ae6de9479b2`. Reviewed daemon: `08162402de19527ec74ea67605fab8010a1c2f67`. Use separate worktrees and explicitly set each checkout's own `CARGO_TARGET_DIR`. Never point tests at `~/.kybern` or overwrite the packaged sidecar.

Build both revisions before comparing:

```sh
export CARGO_TARGET_DIR="$PWD/target"
cargo build --locked --release -p kybern
cd apps/desktop
npx --yes pnpm@11.25.0 install --frozen-lockfile
npx --yes pnpm@11.25.0 tauri build --bundles app
```

Keep the baseline binaries for alternating runs. Wait for all compilers and development servers to exit before measuring. The Tauri wrapper stages the matching sidecar; `pnpm build` alone is insufficient.

## Scratch daemon

From the reviewed worktree:

```sh
python3 apps/desktop/scripts/benchmark-daemon-memory.py "$PWD" candidate-1 /absolute/artifacts
python3 apps/desktop/scripts/benchmark-daemon-memory.py "$PWD" baseline-1 /absolute/artifacts /absolute/baseline/kybernd
cargo build --locked --release -p kybern-store --example profile_transcript
./target/release/examples/profile_transcript .scratch/candidate-1/state.sqlite 20000000-0000-4000-8000-000000000001
```

Each run label must be fresh. The harness initializes the real store schema, then seeds deterministic synthetic data: 400 turns, 800 tools, 6,400 events, Unicode text, four progress deltas per tool and about 70 KB of final stdout per tool. It never reads production conversations. Source is `seed-memory-workload.py`; exact RPC actions and idle durations are in `memory-workload.mjs`.

The workload includes five recent-page reads, twelve earlier pages at a frozen snapshot, three pages with full outputs, ordered event replay, and a real PTY writing 5,000 lines. Initial idle is five seconds; post-workload idle is ten seconds. It does not run an agent or exercise native-shell UI. Background streaming/rendering has separate native fixtures.

`proc_pid_rusage` samples physical footprint and RSS every approximately 100 ms. Attribution uses the newly launched daemon's PID and process-start identity, not process-name matching. No PID is reused between runs. Compiler, client harness, Swift host, production daemon and unrelated WebKit processes are excluded. A failed or restarted daemon fails the workload; it is never treated as zero memory. Sampling can miss very short peaks, especially startup. Candidate history reads finish between samples, so no history-phase RAM comparison is reported.

`baseline-1`, `baseline-2`, `baseline-4` and `candidate-1` through `candidate-3` are the reported runs. `baseline-3` overlapped the separate fold timing probe and is excluded. The initial fold probe overlapped that excluded run; the published probe was repeated alone after the final build completed. Its wall-clock timings are not memory savings.

## Native renderer

Run fixtures serially, from `apps/desktop`, with the same OS/WebKit, display and geometry:

```sh
KYBERN_SCROLL_MEMORY=1 KYBERN_SCROLL_IDLE_MS=10000 \
  KYBERN_PERF_MEMORY_DIR=/absolute/artifacts/scroll-vmmap \
  node scripts/check-rendering.mjs scrolling
node scripts/check-rendering.mjs tool-memory
node scripts/check-rendering.mjs terminal-memory
node scripts/check-rendering.mjs tool-leases
KYBERN_PERF_WIDTH=480 node scripts/check-rendering.mjs interaction
KYBERN_PERF_WIDTH=480 node scripts/check-rendering.mjs history-retention
```

These build production component bundles and run a native WKWebView under the shipping Tauri asset scheme/CSP. Default geometry is 1100 × 720 CSS pixels, dark and opaque. Vite is the frozen workspace version. The pre-existing fixture wrapper invokes the available `pnpm exec vite`; this machine's global pnpm is 11.27.0, while install/tests/Tauri use the package-pinned 11.25.0. No development server is involved. The original and isolated desktop installed lockfiles have identical SHA-256 (`cd8759a29794e3fe1694848e8f8a77833984b5b920d10f6767b3ee6bd5e7821f`).

At each memory checkpoint Swift obtains the current WebContent PID from that fixture's WKWebView, runs `vmmap -summary`, and resumes the workload. This avoids stale PID attribution and captures the WebContent lifetime footprint peak. No GC is forced. vmmap's M values are reported as MiB. Summary memory-region categories are not additive unique memory and do not independently identify decoded image, layer and tile ownership.

The `tool-leases` fixture uses a real isolated release daemon and real runtime/RPC, not a stub transport. Its token exists only in its temporary fixture bundle. Both temporary bundle and scratch database are removed on exit. It verifies 16 unique results mounted in two panes, deduplicated fetches, exact Unicode selection, closing one pane, unmounting all results, reopening, and actual WebSocket reconnect with four real hydration callbacks deliberately held pending.

## Whole application: outstanding

The existing packaged application and daemon hosted this session. They remained running and untouched; the one-Kybern-UI rule prevented opening a second production shell, and closing the user's session was not necessary for independent work. Consequently these are **not whole-app measurements**. No Tauri shell, attributable GPU/network helpers, combined footprint, app startup latency, energy, or application CPU comparison is available. Never add the separate daemon and renderer fixture figures to synthesize a total.

For a dedicated native session, close the packaged UI, launch one baseline/candidate app against matching scratch data, and attribute all newly created/restarted frontend, shell, daemon and WebKit helper processes. Use `scripts/profile-memory.py record` with an atomically updated PID manifest; the manifest must explain ownership and missing coverage. Record hardware, display scaling, window geometry, theme/material/accessibility states and workload actions. `summarize` rejects incomplete logs, and `compare` rejects sampling errors or mismatched scope/coverage. Summed RSS includes shared pages; report that explicitly. macOS physical footprint sums are process-accounted attribution, not an independently measured unique whole-system RAM delta.

## Excluded late repeats

An unrelated Xcode/Clang build started during `final-scrolling-no-memory` and continued through the `accepted-*` native fixtures. Those late repeats are excluded from memory/latency comparisons, including successful ones. The earlier instrumented 1,327 ms frame stall remains a real failed check with no established cause. A quiet runner is needed to complete responsiveness acceptance; this report does not override the fixture thresholds.
