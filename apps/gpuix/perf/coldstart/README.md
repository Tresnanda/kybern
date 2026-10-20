# Cold startup and long-thread open

Scratch-only port 4336 (recording proxy 4337), data/config/credentials under
`/Users/mymac/projects/ade-gpuix-scratch/perf-coldstart`. The reusable fixture
adapts startup/fixture.ts: deterministic IDs, 20 projects, 300 threads, twelve
1,000–2,500-turn conversations, 32,076 turns and 162,126 mixed events. It never
starts a provider and deletes its own daemon/data on exit.

`build.ts <log-label> <command…>` reserves the next build slot, waits for quiet
windows/other marked builds, uses nice 15, four Cargo jobs, one checkout-local
`target` and no incremental compilation. Its whole child lifetime is marked.
Do not share Cargo targets across checkouts. `package.ts <variant>` compiles the
app against the existing validated addon and this checkout's debug daemon/CLI;
there is no native addon rebuild or full release build. Preserve the baseline
bundle before rebuilding the daemon. Source baseline is b14b10f1.

From apps/gpuix with frozen GPUIX and desktop dependencies installed:

```sh
KYBERN_COLDSTART_QUIET_LANE=perf-coldstart-final \
  bun perf/coldstart/quiet.ts bun perf/coldstart/final.ts
bun perf/coldstart/summary.ts
bun perf/coldstart/pixels.ts
```

The fair quiet-order wrapper holds at most 20 minutes. Each fixture takes a
separate process-group UI lease capped at 295 seconds; interrupted descendants
are stopped before release. Native-build markers and the required GPUIX process
inventory are retained before/after each timing/resource run, with a 50 ms build
watch during it. Never run these measurements alongside another native app.

Timing alternates variant order across five pairs, with a fresh daemon/data set
for every member. Each member launches once projection-cache cold and once warm.
Cold does not mean purged OS filesystem caches, and daemon launch/migration are
outside the app-process clock. `KYBERN_FULL_RATE=1`, opaque 1280×820, the same
addon and default rendering flags are used throughout. The cached older page's
RPC-ready time and demand-to-painted older content are recorded separately.
The subsequent 2,000-turn open is uncached on the first launch and cached on the
second. Startup includes no captures or clock manipulation.

`KYBERN_COLDSTART_PAIRS=1 KYBERN_COLDSTART_LABEL=diagnostic-` selects an isolated
preliminary pair without overwriting final evidence. Profiles are separate from
acceptance timings. `app-profile` samples the app during its first five seconds
for module/native initialization, first layout and font/atlas work. `profile`
samples the scratch daemon while cold long-thread RPCs
contend with list RPCs, record SQL query plans/times, and save deterministic
sequence-bounded response snapshots for exact baseline/candidate comparison.

Resource and active modes wait ten seconds then sample CPU, per-PID GPU time and physical
footprint for fifteen seconds. Active mode uses the same offered 30 Hz indexed wheel/momentum trace (the startup lane found the native automation ACK lane saturates near 50 Hz) in each version. GPUIX and its daemon are separate groups;
WindowServer is excluded. Visuals settle
for twenty seconds and capture both themes in a separate run, blurring the composer first so caret blink phase cannot differ. Only in visual mode, the recording proxy supplies identical representative Codex/Cursor weekly quota values (35% used) in usage responses/notifications, so real account usage changing between captures cannot change the rings. All timing/resource runs keep the daemon’s real responses. Frame timestamps
are post-draw scene submissions, not physical presentation fences. Startup gaps
include intentional waiting and must not be interpreted as animation stutter.
Handshake is automation/window availability; text observations are CPU-paint
upper bounds at the polling frequency. No physical input-to-photon or 120 Hz
hardware claim is made.

All raw evidence goes under
`/Users/mymac/projects/ade/previews/gpuix/perf/coldstart/`, outside commits.
The generated bundles, targets and disposable installs are removed on completion.

Each UI runner holds scoped `caffeinate -d -u -w <runner pid>` (`-u` wakes an already sleeping display). Runs require at least three native submissions; a start that reaches its painted milestones in two submissions gets up to 1.5 seconds of liveness confirmation outside those milestone clocks. Resource runs also reject zero GPU time or fewer than two sampled submissions. No power settings are changed. `display-audit.json` classifies earlier diagnostic evidence after the display-sleep discovery; no suspect capture is used for final acceptance.

Before and after each UI run, `swift /Users/mymac/projects/ade-gpuix-scratch/screen-state.swift` must report `locked: 0` and a false/zero `displayAsleep`. A locked session prevents WindowServer composition even when awake; do not unlock it. Pause UI work and poll about once a minute. Headless store/daemon tests remain usable.
