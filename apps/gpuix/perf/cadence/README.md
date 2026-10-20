# Cadence and passive-loop controls

These scripts use the existing combined addon; no native rebuild is needed.
All measurements use `KYBERN_FULL_RATE=1`, a scratch daemon on port 4334, and
separate bounded UI leases inside a queued build-free window. Generated evidence
belongs under `/Users/mymac/projects/ade/previews/gpuix/perf/cadence/`.

```sh
CADENCE_SOURCE=before CADENCE_INTEGER=skip KYBERN_BENCH_DIRECT_VIEW=1 bun perf/cadence/quiet.ts bun perf/cadence/bench-pair.ts
CADENCE_SOURCE=after CADENCE_INTEGER=skip KYBERN_BENCH_DIRECT_VIEW=1 bun perf/cadence/quiet.ts bun perf/cadence/bench-pair.ts
CADENCE_SOURCE=before bun perf/cadence/quiet.ts bun perf/cadence/loops.ts
CADENCE_SOURCE=after bun perf/cadence/quiet.ts bun perf/cadence/loops.ts
CADENCE_SOURCE=after CADENCE_NATIVE=1 CADENCE_LOOPS=matrix,connection,task,shimmer bun perf/cadence/quiet.ts bun perf/cadence/loops.ts
CADENCE_SOURCE=after bun perf/cadence/quiet.ts bun perf/cadence/original-harnesses.ts
```

`control.ts` restores only this lane's changed product modules from `b14b10f1`
(the same product blobs as the capture-time commit `072fdbbf8`)
when `CADENCE_VISIBILITY_CONTROL=1`; benchmark source, instrumentation and the
native addon stay identical. Use `KYBERN_BENCH_DIRECT_VIEW=1 CADENCE_INTEGER=skip` for matched direct-handler
fractional input. Only direct-before versus direct-after is a matched product
comparison. Integer/window versus direct-fractional measures apparatus repairs.
`CADENCE_INTEGER=only KYBERN_BENCH_DIRECT_VIEW=0` reproduces the historical
apparatus; `CADENCE_INTEGER=both` runs both delta controls with distinct labels.
The bench records the actual effective absolute distance and count of nonzero
offers that NSEvent rounded to zero. `KYBERN_BENCH_NO_RUNNING=1` removes the
synthetic running sidebar row for a separate open/settle control; it never
changes the default workload.

The original `perf/scroll2` and `perf/explorer` harnesses use their independent
background-native-thread fractional NSEvent producer. Their scratch data and
evidence overrides keep this lane out of the earlier lanes' folders. They
check real handler delivery as well as CPU paint; the shared bench's producer
runs in process and can itself slow under load. Neither is physical input.

`loops.ts` samples each loop for 15 seconds after ten seconds warm-up, then
checks mounted-but-clipped, restored, minimized, restored, and unmounted states.
It reports native submissions, CPU scene work, React commits, process CPU,
AGX GPU milliseconds and physical footprint independently. WindowServer and
daemon are excluded. `CADENCE_NATIVE=1` explicitly enables the existing native
matrix/task/text paths; the default remains gated by the historical GPU issue.
The opt-in connection arc now uses the existing paint-only native rotation with
the same 1300 ms period rather than JS/display-rate rotate-prop commits.
Elapsed labels remain informational second updates. The caret's half-second
blink is intentionally discrete; offscreen or hidden it owns no blink timer.

For separate before/after frame strips, set `CADENCE_VISUAL=1` and run both
`CADENCE_SOURCE=before/after` with `KYBERN_APPEARANCE=dark/light` and
`KYBERN_REDUCED_MOTION=0/1`. Captures never share a timing/resource run.
The skeleton intentionally retains the desktop's sweep under Reduce Motion.
Each source/native/mode/scene has a separate basename. Phase sequences use the
real clock and are visual evidence, not frame-time measurements.

The unit check exercises clipped/missing/zero/partial bounds, visibility
transitions, active subscriptions and teardown with the real React reconciler.
A post-paint observer schedules no animation clock or polling loop. It only
changes state at a visibility boundary; fixed geometry generates no recurring
callback. The native addon limit remains 256 simultaneous layout observers.

`quiet.ts` owns a separate child process group and an independent supervisor.
It checks this checkout's abandoned tokens before joining, enforces a bounded
deadline, and removes its quiet/order entries even if killed. `lease.ts` stamps
the UI lock with its PID and has its own external guardian for acquired and
queued SIGKILL. Normal signal teardown has a four-second hard bound. The
`checks.ts` controls kill real holders and queued waiters, and exercise quiet
crash/kill/timeout descendant cleanup in an isolated coordination directory.
No cleanup removes another live holder's lock. `CADENCE_COORDINATION_DIR` and
`CADENCE_MAX_SECONDS` are test controls (the latter can only lower the 24-minute
production bound).

Screen validity: runners execute `swift /Users/mymac/projects/ade-gpuix-scratch/screen-state.swift` before app launch and before/after measurement (checkout-local equivalent when the shared file is absent). Both endpoints must be unlocked and the display awake. Quiet windows wait without consuming a window while locked, polling once per minute. Every app lease owns `caffeinate -d -w <runner pid>`; killing the runner releases that assertion. Continuous active samples require at least one submission per four seconds and positive GPU time. Intentional idle, clipped, unmounted, and reduced-motion static controls can legitimately have zero submissions/GPU time. Never unlock a session or change its lock/sleep settings for a run.

`CADENCE_LOOP_EVIDENCE` selects a separate resource output folder for an explicit
repeat without overwriting the primary controls. Spin's repeat is preserved in
`loops-repeat/` because first-pass AGX timings varied strongly across otherwise
matched visible paths. Keep both passes when judging GPU effects.

The final `idle-suite.ts` runs all source checks, then three Home idle windows
after twenty seconds warmup, crossing the first usage-limits minute poll. It
requires zero frames, commits and GPU in every window before `cleanup.py`
removes this lane's disposable dependencies/scratch data under the same quiet
window. `nav/limits.ts` deduplicates whole cached values; real usage or freshness
changes continue to publish. The earlier `idle-settled20` control (0/0/1 frames)
is retained as the failing baseline for this separate final fix.
