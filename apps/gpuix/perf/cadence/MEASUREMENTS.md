# Cadence measurements

Synthetic 300-thread/20-project product dataset, mixed 1,000/3,000-turn
conversations, 10,000-entry Explorer and long Markdown/code previews. macOS
Apple M1, macOS 27.0.1, Bun 1.4.0, 60 Hz Retina display, KYBERN_FULL_RATE=1, unchanged combined addon SHA256
f7c8af1c2f2558f6c1a5a3ce93b274cfaf5676ebb87ac438d0ad29d45960dc10.
Each shared-bench source has three successful 15-second windows, ten-second
warmups, no screenshots or clock manipulation. Before is the exact product
modules from b14b10f1 via control.ts; after is the visibility-gated source.
Both use identical fractional direct-handler input. The later usage-limits no-op fix is verified separately across the minute boundary; the active table isolates the visibility change. Values below are medians
across successful repeats, not pooled distributions. GPU is process AGX
accumulated time and footprint is physical MiB; daemon/WindowServer excluded.
Physical presentation latency remains unavailable.

## Apparatus/root cause

The original NSEvent getter truncated fractional points (613/1,800 zero-distance
offers in thread-scroll). Fixing getters alone left the gaps. In the five-second
same-source probe, NSWindow routing delivered 239/600 packets synchronously to
the actual GPUI handler, with or without exact getters. Direct scrollWheel:
delivered 600/600 and exactly the requested absolute distance. Window/fractional
p99 was 199.97 ms and proxy p95 137.67 ms; direct/fractional was 19.59 ms and
17.20 ms. A direct/integer probe delivered 600/600 at p99 19.01 ms while still rounding
205 offers to zero (1,851.76 requested versus 1,665 px delivered). NSWindow
routing causes the cadence suppression; getter precision fixes independent
motion-distance loss. Direct dispatch costs more CPU/GPU because it actually
delivers all events. These numbers are apparatus corrections, not product wins.

The surviving 200 ms submissions are the approved shared MatrixLoader timer.
Every non-idle benchmark keeps a synthetic running sidebar row, including the
open/history resource windows. Raw submission/React-commit correlation and
source timer audit are in diagnostics/trace-correlation.json and AUDIT.md.
Those resource windows are active-loader observations, not a 5 Hz loading poll.

## Matched product comparison

| Scenario | Source | p50 / p95 / p99 ms | >16.7 / >33 | Max gap | Proxy p95 | CPU % | GPU ms/15s | MiB |
|---|---|---|---|---:|---:|---:|---:|---:|
| thread-scroll | before (3) | 16.67 / 16.80 / 16.87 | 268.00 / 0.00 | 17.54 | 16.41 | 41.89 | 2674.90 | 257.00 |
| thread-scroll | after (3) | 16.67 / 16.82 / 16.88 | 269.00 / 0.00 | 18.33 | 16.74 | 44.82 | 2729.90 | 258.00 |
| thread-fling | before (3) | 16.67 / 18.48 / 20.24 | 391.00 / 6.00 | 95.65 | 16.79 | 48.67 | 2526.60 | 262.00 |
| thread-fling | after (3) | 16.67 / 18.45 / 20.48 | 387.00 / 6.00 | 94.07 | 16.21 | 50.14 | 2524.40 | 263.00 |
| sidebar-scroll | before (3) | 16.69 / 18.44 / 19.22 | 429.00 / 0.00 | 21.99 | 16.98 | 45.27 | 2390.40 | 235.00 |
| sidebar-scroll | after (3) | 16.67 / 18.11 / 18.90 | 414.00 / 0.00 | 20.83 | 16.99 | 44.40 | 2391.50 | 246.00 |
| explorer-scroll | before (3) | 16.68 / 17.76 / 18.74 | 418.00 / 0.00 | 24.65 | 13.24 | 58.91 | 2070.20 | 292.00 |
| explorer-scroll | after (3) | 16.67 / 18.30 / 18.89 | 424.00 / 0.00 | 25.01 | 11.17 | 58.78 | 2161.40 | 304.00 |
| markdown-scroll | before (3) | 16.67 / 18.41 / 18.81 | 397.00 / 0.00 | 22.75 | 17.10 | 45.35 | 3043.50 | 262.00 |
| markdown-scroll | after (3) | 16.65 / 18.55 / 18.87 | 402.00 / 0.00 | 22.70 | 17.78 | 45.22 | 3055.50 | 266.00 |
| code-scroll | before (3) | 16.64 / 18.53 / 18.87 | 375.00 / 0.00 | 23.14 | 11.71 | 47.20 | 2836.60 | 266.00 |
| code-scroll | after (3) | 16.64 / 18.51 / 18.81 | 384.00 / 0.00 | 23.12 | 12.91 | 46.41 | 2852.50 | 275.00 |
| open-long | before (3) | 199.99 / 213.07 / 216.91 | 75.00 / 74.00 | 216.91 | — | 5.44 | 135.20 | 251.00 |
| open-long | after (3) | 200.07 / 214.86 / 217.00 | 75.00 / 74.00 | 217.00 | — | 5.85 | 135.10 | 256.00 |
| older-history | before (3) | 199.57 / 201.97 / 216.67 | 83.00 / 73.00 | 216.75 | — | 7.44 | 188.00 | 263.00 |
| older-history | after (3) | 199.58 / 201.99 / 216.59 | 86.00 / 73.00 | 217.31 | — | 7.65 | 191.10 | 267.00 |

No active-scroll speedup is claimed for clipping subscriptions: these scenes
retain their one visible loader. Most differences are within the benchmark's
1 ms p95 / 3 CPU-point noise bands. The fast fling still has larger occasional
gaps; the root-cause fix does not prove all scrolling meets its frame budget.
Native input telemetry separately records GPUI dispatch-to-CPU-scene time.
Neither that boundary nor offered-to-next-submission is physical presentation.

## Passive controls

One resource window per isolated scene after ten seconds warmup. Native on/off
changes display-rate workload and is a gate check, not a matched visual-default
speedup. Parking checks settle one second then count submissions for 1.2 seconds.
Mounted-and-clipped Matrix/connection also have a full 15-second resource sample.
Exact telemetry `windowMs` and resource `sampleSeconds` remain in raw JSON;
submission counts include sampler endpoint collection. Sparse 200/500/1000 ms
passive intervals are intended discrete updates, not delayed input frames.
Passive fixtures offer no input, so their latency proxy is unavailable.

Visible-loop GPU readings varied substantially. Spin's initial before/after
pair was 252.6 / 1282.4 ms, while an explicit same-source repeat was 59.0 / 62.5
ms (CPU 4.45 / 4.06%, 925 / 924 submissions). Both repeats retain valid screen,
build and orphan checks in `loops-repeat/`; none is silently substituted for
the first pair. These single-pass passive resources do not establish a general
visible-loop GPU improvement or regression. The durable clipping result is
zero submissions, commits and AGX work, with CPU returning to the idle range.

The opt-in connection comparison cuts per-display React commits from 924 to
zero, CPU 6.85 to 3.72%, and GPU 76.7 to 53.6 ms in its one matched 15-second
control. Its same-period native rotation is retained under the existing opt-in.
The global native-default gate remains unmet: shimmer's native sample used
67.4 versus 39.6 ms in its legacy sample, GPU controls have the variance above,
and no new full-app native on/off acceptance establishes that the historical
failure is gone. Experimental native defaults remain off.

| Scene | Control | Frames | p50/p95/p99 ms | >16.7/>33 | Max gap | React commits | CPU % | GPU ms/15s | MiB | Clipped / minimized / unmounted frames |
|---|---|---:|---|---|---:|---:|---:|---:|---:|---|
| none | before default | 0 | — / — / — | 0 / 0 | — | 0 | 2.99 | 0.00 | 115.00 | 0 / 0 / 0 |
| matrix | before default | 78 | 200.02 / 200.97 / 215.56 | 77 / 77 | 215.56 | 77 | 7.04 | 14.40 | 128.00 | 6 / 0 / 0 |
| spin | before default | 927 | 16.66 / 17.62 / 17.77 | 369 / 0 | 18.27 | 0 | 11.09 | 252.60 | 121.00 | 0 / 0 / 0 |
| connection | before default | 78 | 200.00 / 201.09 / 216.82 | 77 / 77 | 216.82 | 77 | 4.45 | 124.30 | 123.00 | 6 / 0 / 0 |
| task | before default | 77 | 200.02 / 201.97 / 216.68 | 76 / 76 | 216.68 | 77 | 4.32 | 86.60 | 122.00 | 6 / 0 / 0 |
| shimmer | before default | 77 | 200.02 / 202.15 / 216.48 | 76 / 76 | 216.48 | 77 | 4.71 | 117.10 | 121.00 | 6 / 0 / 0 |
| skeleton | before default | 926 | 16.67 / 18.49 / 18.89 | 398 / 0 | 19.08 | 8 | 9.63 | 993.10 | 121.00 | 72 / 0 / 0 |
| visual | before default | 77 | 200.07 / 213.71 / 216.74 | 76 / 76 | 216.74 | 77 | 4.91 | 63.40 | 124.00 | 6 / 0 / 0 |
| elapsed | before default | 16 | 999.98 / 1002.09 / 1002.09 | 15 / 15 | 1002.09 | 16 | 3.59 | 17.80 | 121.00 | 1 / 0 / 0 |
| caret | before default | 31 | 500.19 / 502.16 / 515.22 | 30 / 30 | 515.22 | 30 | 4.12 | 46.00 | 124.00 | 3 / 0 / 0 |
| none | after default | 0 | — / — / — | 0 / 0 | — | 0 | 2.86 | 0.00 | 117.00 | 0 / 0 / 0 |
| matrix | after default | 77 | 200.05 / 214.06 / 216.62 | 76 / 76 | 216.62 | 77 | 6.24 | 101.40 | 131.00 | 0 / 0 / 0 |
| spin | after default | 927 | 16.67 / 18.64 / 18.84 | 407 / 0 | 19.06 | 0 | 9.03 | 1282.40 | 123.00 | 0 / 0 / 0 |
| connection | after default | 77 | 200.05 / 202.14 / 216.29 | 76 / 76 | 216.29 | 77 | 4.85 | 104.40 | 125.00 | 0 / 0 / 0 |
| task | after default | 77 | 200.02 / 202.04 / 217.18 | 76 / 76 | 217.18 | 77 | 4.58 | 99.50 | 124.00 | 0 / 0 / 0 |
| shimmer | after default | 78 | 199.97 / 201.17 / 216.03 | 77 / 77 | 216.03 | 78 | 4.85 | 39.60 | 127.00 | 0 / 0 / 0 |
| skeleton | after default | 925 | 16.65 / 17.51 / 17.59 | 288 / 0 | 17.67 | 8 | 6.18 | 157.40 | 124.00 | 0 / 0 / 0 |
| visual | after default | 77 | 199.99 / 201.25 / 216.75 | 76 / 76 | 216.75 | 77 | 2.86 | 46.70 | 125.00 | 0 / 0 / 0 |
| elapsed | after default | 16 | 1000.01 / 1000.99 / 1000.99 | 15 / 15 | 1000.99 | 22 | 1.93 | 4.80 | 123.00 | 0 / 0 / 0 |
| caret | after default | 30 | 500.00 / 500.95 / 501.00 | 29 / 29 | 501.00 | 30 | 1.99 | 1.70 | 125.00 | 0 / 0 / 0 |
| matrix | after native | 923 | 16.65 / 17.66 / 17.76 | 370 / 0 | 17.81 | 0 | 4.25 | 80.00 | 124.00 | 0 / 0 / 0 |
| connection | after native | 924 | 16.66 / 17.60 / 17.65 | 320 / 0 | 17.79 | 0 | 3.72 | 53.60 | 123.00 | 0 / 0 / 0 |
| task | after native | 923 | 16.66 / 17.63 / 17.72 | 349 / 0 | 17.83 | 0 | 3.66 | 67.80 | 122.00 | 0 / 0 / 0 |
| shimmer | after native | 923 | 16.65 / 17.54 / 17.65 | 380 / 0 | 17.76 | 0 | 3.86 | 67.40 | 122.00 | 0 / 0 / 0 |
| connection | before native | 923 | 16.67 / 17.63 / 17.69 | 307 / 0 | 17.75 | 924 | 6.85 | 76.70 | 124.00 | 72 / 0 / 0 |

## Settled controls

| Scenario | Repeat | Frames | React commits | CPU % | GPU ms/15s | MiB |
|---|---:|---:|---:|---:|---:|---:|
| open-long (10s warmup) | 1 | 3 | 3 | 4.65 | 4.70 | 238.00 |
| open-long (10s warmup) | 2 | 0 | 0 | 4.11 | 0.00 | 238.00 |
| open-long (10s warmup) | 3 | 1 | 1 | 4.25 | 2.70 | 247.00 |
| older-history (10s warmup) | 1 | 27 | 0 | 5.44 | 29.70 | 262.00 |
| older-history (10s warmup) | 2 | 29 | 1 | 6.97 | 20.70 | 259.00 |
| older-history (10s warmup) | 3 | 30 | 2 | 6.31 | 24.30 | 261.00 |
| idle-home (10s warmup) | 1 | 2 | 2 | 3.85 | 3.40 | 229.00 |
| idle-home (10s warmup) | 2 | 0 | 0 | 3.92 | 0.00 | 229.00 |
| idle-home (10s warmup) | 3 | 0 | 0 | 3.65 | 0.00 | 228.00 |
| idle-thread (10s warmup) | 1 | 0 | 0 | 3.92 | 0.00 | 245.00 |
| idle-thread (10s warmup) | 2 | 0 | 0 | 3.72 | 0.00 | 245.00 |
| idle-thread (10s warmup) | 3 | 0 | 0 | 3.52 | 0.00 | 245.00 |
| idle-home (20s warmup) | 1 | 0 | 0 | 3.12 | 0.00 | 228.00 |
| idle-home (20s warmup) | 2 | 0 | 0 | 3.12 | 0.00 | 227.00 |
| idle-home (20s warmup) | 3 | 1 | 1 | 3.39 | 3.50 | 227.00 |
| idle-home (20s warmup) | 1 | 0 | 0 | 1.53 | 0.00 | 204.00 |
| idle-home (20s warmup) | 2 | 0 | 0 | 1.53 | 0.00 | 204.00 |
| idle-home (20s warmup) | 3 | 0 | 0 | 1.53 | 0.00 | 203.00 |

## Content visibility timings

| Scenario | Source | First visible message ms | Settled text ms | Older turn visible ms |
|---|---|---:|---:|---:|
| open-long | before | 421.92 | 693.41 | — |
| older-history | before | — | — | 1188.82 |
| open-long | after | 418.96 | 690.89 | — |
| older-history | after | — | — | 1201.09 |

Open/history resource samples begin immediately after the visibility check, so
finite scrolling/scrollbar tails remain in those windows. Occasional late data
commits are shown rather than labelled as continuous animation. The first Home
window at ten seconds contained two finite commits; the separate twenty-second
Home control crosses the first minute poll. Its final window exposed one unchanged usage-limits publication; the dedicated idle-limits control verifies its deduplication. All three initial thread-idle windows
were already zero-frame.

## Per-submission active cost

| Scenario | CPU ms/submission | AGX ms/submission | Render p95 ms | Taffy p95 ms |
|---|---:|---:|---:|---:|
| thread-scroll | 7.44 | 3.02 | 6.84 | 0.91 |
| thread-fling | 8.51 | 2.86 | 8.70 | 1.17 |
| sidebar-scroll | 7.39 | 2.65 | 5.45 | 0.59 |
| explorer-scroll | 9.76 | 2.39 | 9.07 | 0.90 |
| markdown-scroll | 7.51 | 3.38 | 6.79 | 1.18 |
| code-scroll | 7.73 | 3.16 | 7.09 | 1.23 |

CPU/AGX averages include all process work in the window and are not per-frame
CPU/GPU duration fences. These controls do not establish 120 Hz readiness.

## Independent native-thread input controls

| Scene | Source | p50/p95/p99 ms | >16.7/>33 | Max gap | Dispatch-to-CPU-paint p95 | CPU % | GPU ms/15s | MiB |
|---|---|---|---|---:|---:|---:|---:|---:|
| sidebar/sidebar | before | 16.69 / 18.19 / 18.84 | 451/0 | 24.64 | 17.59 | 54.36 | 4111.00 | 245.00 |
| explorer/tree | before | 16.69 / 18.55 / 18.87 | 446/0 | 19.04 | 16.45 | 37.94 | 2851.80 | 240.00 |
| explorer/preview.md | before | 16.68 / 18.64 / 19.11 | 425/0 | 22.06 | 18.23 | 38.01 | 3064.60 | 255.00 |
| sidebar/sidebar | after | 16.69 / 18.34 / 18.79 | 436/0 | 19.05 | 15.81 | 53.30 | 4135.90 | 251.00 |
| explorer/tree | after | 16.67 / 18.54 / 18.91 | 423/0 | 20.43 | 18.06 | 37.99 | 2823.40 | 237.00 |
| explorer/preview.md | after | 16.68 / 18.73 / 19.07 | 439/0 | 22.16 | 18.05 | 38.45 | 2976.00 | 253.00 |

These are supplemental single repeats with their earlier synthetic fixtures,
1440×900 windows and independent 120 Hz background native producer; they are
not interchangeable with the shared bench workload.

## Mounted but clipped resources

| Scene | Source / mode | Frames | CPU % | GPU ms/15s | MiB |
|---|---|---:|---:|---:|---:|
| matrix | before default | 75 | 7.37 | 19.80 | 129.00 |
| connection | before default | 76 | 4.44 | 109.00 | 123.00 |
| matrix | after default | 0 | 2.72 | 0.00 | 126.00 |
| connection | after default | 0 | 2.79 | 0.00 | 120.00 |
| matrix | after native | 0 | 1.33 | 0.00 | 122.00 |
| connection | after native | 0 | 1.33 | 0.00 | 120.00 |
| connection | before native | 907 | 6.32 | 61.30 | 124.00 |

## Explicit visible Spin repeat

| Source | Count | p50/p95/p99 ms | >16.7/>33 | Max gap | CPU % | GPU ms/15s | MiB |
|---|---:|---|---|---:|---:|---:|---:|
| before | 925 | 16.66 / 17.62 / 17.68 | 303 / 0 | 17.83 | 4.45 | 59.00 | 118.00 |
| after | 924 | 16.66 / 17.58 / 17.66 | 340 / 0 | 17.73 | 4.06 | 62.50 | 124.00 |

## Evidence integrity

The original integer sidebar repeat 2 overlapped this lane's TypeScript check
at about 15:08:44Z and is excluded; repeats 1/3 plus the explicit clean sidebar
replacement provide three uncontaminated legacy observations. Its raw row stays
preserved. The getter-only fractional suite was intentionally aborted after it
failed to cure routing suppression, and is diagnostic only. No aborted suite
is used as matched product acceptance. Raw trace rows contain cumulative setup,
warmup and earlier repeats; do not sum them as independent timing samples.

## Source changes and visual evidence

- `src/native/loop-visibility.ts` and its reconciler test observe native painted
  bounds without a clock or frame request; null/empty/outside clips unsubscribe.
- `MatrixLoader.tsx`, `tasks/Glyphs.tsx`, `shell/Connection.tsx`,
  `transcript/Visual.tsx` and `transcript/motion.tsx` gate sampled clocks and
  native paint props by actual paint. Connection's explicitly enabled continuous
  arc uses existing native rotate at the same 1300 ms period.
- `kit/Spin.tsx` and `kit/Skeleton.tsx` park native plans and occlusion listeners
  while clipped; Skeleton retains its desktop-compatible reduced-motion sweep.
- `subagents/Elapsed.tsx` / `transcript/Turn.tsx` park informational seconds;
  `transcript/rows.tsx` supplies actual prose visibility to the blink effect.
  `ui.tsx` forwards Label refs without changing its host/style.
- `nav/limits.ts` / `nav/live.ts` preserve equal cached usage arrays, including
  all freshness/retry metadata. The integration test observes the real store:
  repeated cached polls notify nothing, while values, freshness and refreshing
  changes still publish. The prior minute poll generated one unchanged Home
  commit/submission at about 60 seconds despite twenty seconds warmup.
- `perf/bench` repairs input dispatch/precision, retains handler/distance evidence,
  separates native dispatch-to-CPU paint telemetry, and guards leases with
  independent forked sessions plus recoverable root/PID tokens. Queue cleanup
  and stale-lock cleanup serialize through Python. Signal disposal is bounded.
- `perf/scroll2` / `perf/explorer` add scratch/evidence overrides only;
  `perf/cadence` supplies same-addon source controls and independent captures.

No native patch changed. Getter-only dispatch was tested and rejected as a
cadence fix; enabling experimental native defaults remains subject to the
historical GPU gate. AUDIT.md identifies visible legacy clocks and terminal /
platform polling that remain; full P6 GPU conversion is not claimed.

The 936 raw loop PNGs produce 52 before/after strips in `strips/`, covering both
themes and reduced-motion states for default and affected opt-in paths. All 22
static reduced-motion crop comparisons have zero changed pixels. Animated
strips use real-clock phase sequences, not phase-aligned pixel assertions.
Full product Sidebar/thread/menu and Explorer/Markdown screenshots are under
`original-harnesses/{sidebar,explorer}/cadence-{before,after}-visual-*`.
No screenshots were taken during resource samples.

Screen validity was audited after the parent discovered a locked session from
about 16:30Z. All accepted shared-bench, supplementary native-input and visual
runs completed by 16:24:03Z, with positive active submissions/GPU.
The passive resource suite ran after unlock at 17:26–17:46Z, and its screen
endpoints are all unlocked/awake. A later idle-limits suite records its own
screen/build/orphan endpoints. The later
zero-visible-frame smoke was aborted and discarded before resources. Subsequent
runs record unlocked/awake Swift endpoints and use runner-scoped caffeinate;
continuous active zero/near-zero frame or zero GPU samples are rejected.
`diagnostics/screen-validity-audit.json` retains the retrospective audit.
Inactive dock panels unmount through `src/dock/Dock.tsx`'s active-tab conditional;
loop fixtures separately check unmount teardown as well as retained clipping.

See README.md for reproduction, AUDIT.md for passive paths and retained gaps,
and diagnostics/*cleanup.json for real crash/kill/timeout cleanup controls.
No native patch or rebuild was required by this source/injector change.


## Validation and cleanup

Required product/native/bench/cadence TypeScript checks and source/model tests
passed; raw command logs and the complete source hash are in diagnostics/.
No native patch changed or native build was required.
Free disk before this lane was approximately 82 GiB; before cleanup
75.43 GiB and after cleanup 75.65 GiB
(actual volume free space, not the sum of removed directory sizes).
Removed disposable GPUiX/desktop dependencies, scratch data, compiled wheel
helpers and this lane's Swift module cache. No Rust target was created.
The inherited signed addon remains for review; requested evidence remains here.
Branch is gpuix/perf-cadence; FINAL-STATUS.json records final commit/status.
