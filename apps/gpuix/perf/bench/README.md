# Shared GPUIX benchmark

Run from `apps/gpuix` with the existing patched native addon and frozen dependencies:

```sh
bun perf/bench/run.ts --runs 3 --label baseline-ef2251e2
bun perf/bench/run.ts markdown-scroll code-scroll explorer-scroll --runs 3 --label after
bun perf/bench/compare.ts perf/bench/results/baseline-ef2251e2.json perf/bench/results/after.json
bun perf/bench/scenario.ts thread-scroll             # one result document on stdout
bun perf/bench/run.ts pr-summary pr-changes thread-scroll markdown-scroll code-scroll --webkit --runs 3 --label desktop-webkit
bun perf/bench/run.ts markdown-scroll --runs 1 --seconds 5 --warmup 10 --profile --label diagnose
bun perf/bench/profiles.ts /path/to/profile-*.txt
bun perf/bench/structural.ts  # headless 300 / 3,000 / 10,000 row mount counts
KYBERN_BENCH_COUNTERS=1 bun perf/bench/run.ts explorer-scroll --runs 1 --label counts
```

`run.ts` starts one scratch daemon on **4322**, seeds once, and uses one native
window at a time. It takes the existing atomic preview lease; each scenario owns a separate lease and releases it before joining the end of
the queue for the next scenario. A 250-second watchdog aborts and cleans up a
stuck batch before it can monopolize the five-minute lease. Partial result
documents have `aborted: true` and the process exits unsuccessfully. Input production is time-bounded; at most eight
RPC packets can remain outstanding on the fallback path. Queue mutations use Python. It records native-build markers before and after every timed/resource run, and
watches the marker directory during the window to catch short builds. The required `pgrep -fl "bun .*ade-gpuix"` inventory is recorded before and after every run; any foreign native app/fixture/lab invalidates it. Process ancestry distinguishes this runner’s children from a cancelled runner’s orphans. Preflight waits for foreign apps to exit; wrappers stop their children, and the native fixture exits on a closed parent pipe or changed parent PID. Quiet
markers are recorded at both endpoints too; quiet reservations never cause a discard.
Each attempt gets a separate evidence directory so a retry cannot overwrite its logs.
The runner creates no quiet reservation. If reserving one separately, keep it
under 25 minutes, permit only one quiet window, and let any
`/tmp/kybern-gpuix-build-next.<lane>` reservation take the next build slot before
creating a new quiet window. Another lane’s `quiet-next` reservation also blocks
a new quiet window: queue a `quiet-next` only when none exists, and open quiet
only on your turn with no active build marker. Existing native builds still
invalidate timing windows. A
marker at either endpoint or during the run records `build overlap: discarded`; that repeat is
queued again after releasing the UI lease. Clean repeats replace the discarded
measurements for comparison, while the discarded records stay in JSON. Queue wait is excluded when reporting suite
execution cost. `--seconds 1 --warmup 0` is a smoke check, never a baseline.
`--keep-data` preserves the deterministic dataset for another run; otherwise
only this runner's daemon/data are stopped/deleted. A per-data-directory lock
prevents concurrent runners sharing the seed. Concurrent lanes must choose their
own unused `KYBERN_BENCH_PORT` and a new `KYBERN_DATA_DIR` containing `scratch`;
the seeder refuses to adopt a different fixture’s existing directory. External real-daemon endpoints
are cleared; UI launch and config paths are explicitly scratch. No model runs,
GitHub writes, global input, screenshots, or clock manipulation occur.

Results are `results/<label>.json` and a median table in `results/<label>.md`.
Raw bounded diagnostic logs and resource samples are in
`/Users/mymac/projects/ade/previews/gpuix/perf/bench/<label>/`; override only with
`KYBERN_BENCH_EVIDENCE`. Retain small baseline JSON, not generated logs, binaries,
or the scratch dataset. `--webkit` labels its host **desktop frontend in WebKit**;
it is not a Tauri binary. It reuses the installed Playwright runtime; no downloads.

## Workload and scenarios

`seed.ts` reuses `visual/fixture.ts`'s RPC connection and gradient PNG generator,
the SQL event technique in `pacing-fixture.ts`, and `harness.ts`'s scratch guard.
Records use real daemon RPCs. Provider events are synthetic SQLite rows because
there is no event-import RPC. Titles, order, event IDs, timestamps and content
are deterministic; daemon-generated project/thread UUIDs differ on a fresh seed.
A cached manifest preserves those UUIDs for matched runs.

- 300 threads in 20 projects, 20 notes and 20 tasks; settled 1,000/3,000-turn
  conversations with Markdown, tables, code fences, diffs, tools and image parts.
- A synthetic running thread; streaming uses production `applyEvent` on this
  process's state at 25 deltas/sec. It does not execute a provider. The stream
  text and requested cadence are deterministic and bounded by the scenario lifetime.
  Delivered deltas/sec are recorded so a throttled producer is not mistaken for
  a matched workload.
- A scratch git repository with 2,400 root source files and an expanded directory
  of **10,000 files**. Explorer timing expands that directory. The stock sidebar
  shows its normal eight threads per project; all 300 remain in its model.
- `long.md`: 93,853 bytes / 1,776 lines, inside the product's rendered Markdown
  preview limit. `long.ts`: 3,000 lines, inside the 256 KiB read limit.
- `huge.md` and `huge.ts`: approximately 2 MiB each. These explicitly exercise
  existing product limits when opened manually: large Markdown becomes source,
  and file reads stop at 256 KiB with the normal truncation notice. They are
  seeded stress inputs; the default preview timings use the complete long files.
- PR scenarios reuse `actionFixture({long:true})`: a long description and
  2,400-line patches, using its in-memory RPC server; no GitHub network access.

The default suite covers fresh-preferences and warm-preferences dev startup,
opening a long thread, one earlier-history page after upward native wheel input,
thread wheel bursts and a fast fling, sidebar, expanded Explorer, Markdown/code
file previews, PR Summary/Changes, a long streaming answer and genuinely settled
Home/thread idle with composer focus parked so a caret does not animate. The synthetic running sidebar row is made idle in process only
for the two settled-idle scenarios. Other scenarios retain it.
Packaged startup is explicitly skipped when checkout-local daemon/CLI artifacts
are missing; obtaining them would require a separate Rust packaging build.

## Measurement contract

All native numbers state **KYBERN_FULL_RATE=1** by default. No other rendering
optimization flags are enabled. `pacing-app.ts` supplies the unchanged full
product, commit counts and a visible, non-activating native window.
`launchFixture` has one optional stderr observer so telemetry does not fork its
process lifetime, startup timeout or scratch safety handling.

The AppKit helper attempts process-local real `NSEvent` input with precise pixel
deltas plus independent contact/momentum phase fields; it never posts global
input. If AppKit cannot associate that event with this window, the suite records
that rejection (or a failed offset-change preflight) and reuses `scroll8.ts`'s 120 Hz pipelined native wheel RPC schedule,
including contact markers, direction reversals and exponential synthetic momentum.
A small harness subclass supplies this process’s window association while the
concrete NSEvent retains its precise delta and phase implementation. An untimed
offset-change preflight must confirm that AppKit actually scrolls the target.
The JSON states the accepted input backend and delivered packet rate. A slow
in-process AppKit callback can throttle the producer; the fallback also bounds
backlog and truncates unoffered packets at the real-time deadline. This limits
matched-input claims across very different renderer speeds. A fast fling uses a larger ramp and
decay. Input-to-physical-present is **null**: neither backend exposes that fence.
The separate offered-input-to-next-native-submission stderr-receipt proxy includes
transport/delivery delay and can include unrelated animation submissions. It is
not an input-to-photon claim. WebKit uses DOM-wheel-to-rAF instead.

Frame p50/p95/p99, >16.7/>33 counts and maximum gap come from native **scene
submission** timestamps, not debug-frame durations. Startup and discontinuous
stream/idle gaps are not evidence of missed continuous-animation frames.
Opening/earlier-history timings use real-clock painted-text/bounds inspection;
inspection is an upper bound on visibility and native painted text may include
clipped runs. Settled-open means loaded state plus 250 ms of unchanged painted text; it does not mean all 3,000 turns were mounted. Older-history visibility
requires a lower first sequence and painted transcript content, not a daemon
response alone. These limits are kept explicit in the baseline.

For active/idle resources a scenario warms for ten seconds, then keeps that
scene active across three consecutive independent 15-second endpoint windows.
The suite reuses `perf/sample.ts`: actual process CPU-time delta, AGX per-PID
accumulated GPU milliseconds and `footprint` physical MiB. Samples include the
app only; daemon and WindowServer are excluded. WebKit includes its browser and
newly launched/adopted WebContent/GPU/Networking processes. GPU ms / submission
is an average of process work, not per-frame GPU duration. Startup transition
resources remain null rather than pretending that a post-startup 15-second
window measures launch cost. No energy or 120 Hz display claim is made.

`KYBERN_FRAME_COSTS` supplies existing render/Taffy durations. Optional
`KYBERN_BENCH_COUNTERS=1` traverses at most 500,000 mounted fibers once after each
window, outside its timing, and reports host/component/row-component counts by surface and mounted direct
native rows for at most 64 virtual lists. Row-component totals include wrappers;
the per-list row count is the useful retained-child measurement.
Unavailable native built-child, Markdown parse/flatten, shaping, host mutation,
image and Metal byte counters remain explicit nulls. Adding native hooks belongs
to a later instrumentation change, not a source-only benchmark pretending to
measure them. `profiles.ts` reports inclusive stack counts; categories overlap.
Profiled runs are separate from the baseline because `sample` perturbs scheduling.

Comparison uses medians of successful runs. Differences below **3 CPU percentage
points** and **1 ms frame p95** are flagged as noise, not wins. A difference above
those thresholds alone does not prove significance. Match input backend, flags,
workload, host and duration when comparing. The comparison flags a >5% offered
packet-rate change or a changed input backend as unmatched input; inspect per-run distributions.

Validation: `pnpm typecheck`, `pnpm exec tsc -p perf/bench/tsconfig.json`,
`bun test ./src`, `bun test perf/bench/model.test.ts`, and
`node --check perf/bench/webkit.mjs`.
