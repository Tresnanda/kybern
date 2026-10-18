# Startup and history workload

These scripts use only `/Users/mymac/projects/ade-gpuix-scratch/perf-startup`
(port 4324; the measurement proxy uses 4325). `fixture.ts` refuses an existing
scratch daemon, creates 20 projects / 300 threads / 32,076 turns / 162,126
events, restores a 2,500-turn thread, and removes its daemon/data on exit.
Twelve threads contain 1,000–2,500 turns of Markdown, code and tool calls.
No provider turns are launched. Never point these scripts at normal user data.

From `apps/gpuix`, after installing frozen dependencies and building the daemon
with the checkout's own `CARGO_TARGET_DIR` and `CARGO_INCREMENTAL=0`:

```sh
KYBERN_TEST_DAEMON="$PWD/../../target/debug/kybernd" \
  bun perf/startup/lease.ts -- bun perf/startup/fixture.ts -- \
  bun perf/startup/measure.ts /absolute/evidence/after-dev.json
```

`lease.ts` uses the shared fair UI queue and limits a batch to 295 seconds.
`measure.ts` waits for native-build markers, checks before/after and every
50 ms during each run, and saves/discards contaminated results before retrying.
All captures explicitly use `KYBERN_FULL_RATE=1`, opaque windows and the same
native renderer. `--packaged` uses the built app; `--open-thread` opens another
2,000-turn thread; `--history` scrolls to the preceding page. `--resources`
warms for 10 s and samples CPU, GPU time and physical footprint for 15 s.
`--active` replays an index-based contact/decay trace at 60 Hz (configurable
with `KYBERN_STARTUP_INPUT_HZ`), with at most 32 unacknowledged packets. It
records actual rate and packets during the resource sample; ACK throughput
does not change the wheel deltas. Earlier 120 Hz/backpressured runs are
retained as unmatched diagnostics, not resource A/B evidence.
`--visuals` is a separate screenshot pass, never used for timing.

Paint visibility is polled from native CPU paint text. These measurements do
not establish physical display presentation or hardware input latency. Native
frame intervals and render/layout CPU costs are separate from GPU time.
`KYBERN_STARTUP_RUNS` selects repeats (normally three; resource/visual one).
`KYBERN_STARTUP_TRACE=1` enables production timeline marks; normal launches
produce no trace output. `KYBERN_HISTORY_PREFETCH=0` disables speculative paging
for an A/B control. `KYBERN_STARTUP_HISTORY_DELAY_MS=120` delays older-page
responses in the test proxy only, to measure settled remote history demand.

`cold.ts` compares three packaged launches per variant with a fresh scratch
daemon for each variant: the first has an empty projection cache; the next two
are warm. This is process/cache cold, not an OS filesystem-cache purge.

`fixed-input.ts` uses a 30 Hz offered trace for the matched resource A/B:
60 Hz still saturated the native automation ACK lane at around 50 Hz, even
with a 32-packet bound. Compare packet counts/rates as well as resources.
`repeat-active.ts` alternates three active samples per version after a provider
catalog/cache warmup. `parity.ts` captures both themes after a 20 s settle so
provider discovery cannot change the compared labels. Native frame logs contain
timestamps: result `frames` / `resourceFrames` / `historyFrames` are derived
intervals in ms; `frameTimestamps` preserves the raw clock. `summary.ts` emits
percentiles from intervals. `repair-frames.ts` converts older timestamp evidence
idempotently while retaining those raw values.

`final.ts` runs the complete before/after batch and requires a preserved
`dist/Kybern GPUIX baseline.app` alongside the candidate package. Its static
import control is generated from the current entrypoint and removed in a
finally block. `index-experiment.ts` requires the pre-migration daemon and
creates the sparse index between otherwise identical RPC runs. `profile.ts`
is a separate daemon diagnostic with `sample`, excluded from UI/resource
captures. `checks.ts` records Rust tests, clippy, formatting, app/package
typechecks and packaging; native builds use nice 15, four jobs and the shared
build marker, waiting for shared quiet-window and reserved-build-slot files before a new
build. Do not reserve a new quiet window while any build-next file exists.
Build/test output is disposable; evidence is external to git.
