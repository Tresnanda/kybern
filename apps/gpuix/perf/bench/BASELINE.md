# GPUIX shared benchmark baseline

This suite changes benchmark code only. Product JavaScript is based on `ef2251e2`; the native addon SHA-256 is `33865fdd47dfbcbe6edfbcbc29c3b750bf626ad8cc77f4130922cdbfb62bc5bc`. The later Explorer/startup/transcript optimizations are not in this control. Source and native code were kept matched instead of copying the current integration addon onto old application source.

Measurements use Apple M1 / 16 GiB, macOS 27.0.1, Bun 1.4.0, 60 Hz Retina LCD, 1280 × 820 logical pixels, dark appearance, normal motion, opaque window, `KYBERN_FULL_RATE=1`. Other optimization switches use the application defaults recorded in JSON. This is a development process with pacing diagnostics, not a release-performance claim. The installed daemon binary runs only against the named scratch dataset; daemon and WindowServer resources are excluded.

## Workload and interpretation

300 threads across 20 projects; 1,000/3,000-turn conversations with mixed formatted Markdown, code, tables, tools/diffs and synthetic image parts; 20 notes/tasks; one persisted synthetic running thread; 12,405 project files including 10,000 expanded Explorer children. Preview timings use complete 93,853-byte Markdown / 3,000-line TypeScript files inside the existing preview limits. Approximately 2 MiB Markdown/code files are also seeded; those exercise the product's source/truncation fallbacks rather than complete rendered previews. PR fixtures have a long formatted summary and 2,400-line patches without GitHub calls. Streaming uses production transcript event projection at a requested 25 deltas/sec; actual offered cadence is retained.

Each active/idle scenario warms for 10 seconds, then receives three independent 15-second process resource samples in the same scene. Native scroll uses process-local precise AppKit wheel events with contact/momentum phases when an offset-change preflight passes; bounded native RPC input is the documented fallback. The early baseline batches retain offered packet counts divided by nominal duration, but lack producer wall duration; their 120 packets/nominal-second values are not a verified delivered 120 Hz workload. Later diagnostics record the actual producer duration and rate. Backpressure can prevent matched input across builds. Startup, opening and older-page visibility use real clocks and native painted-text checks. There are no screenshots or manual clock advances in timing windows.

Native frame intervals are **scene submission intervals**. The input latency column is an offered-input-to-next-submission stderr-receipt proxy and may match unrelated animation work. Physical input-to-present remains null. GPU time is accumulated process AGX time, not GPU utilization, energy, or per-frame duration. Process CPU/GPU milliseconds per submission in JSON are averages, not a GPU fence. Startup, sparse streaming and idle gaps cannot be interpreted as continuously missed animation frames. The 60 Hz panel cannot establish 120 Hz presentation readiness.

The UI lease is released between scenarios, with a 250-second batch watchdog. Native build markers are audited before, during and after each timed window; foreign GPUIX process inventories are audited before/after. Contaminated runs are discarded and requeued. No quiet window was created by this resumed lane. **All cancelled-agent timings in 05:16–05:32Z on 2026-10-18 are excluded**, together with unaudited exploratory runs. They remain only under the evidence directory's `invalidated-results/`, clearly marked invalid.

## Measurements

| Scenario | OK/runs | Frame p50/p95/p99 ms | >16.7/>33 | Max gap ms | Latency proxy p95 ms | CPU % | GPU ms/window | MiB | Notes |
|---|---:|---|---|---:|---:|---:|---:|---:|---|
| startup-cold | 3/3 | 16.87 / 143.68 / 143.68 | 8.00 / 2.00 | 143.68 | — | — | — | — |  |
| startup-warm | 3/3 | 16.65 / 136.95 / 136.95 | 7.00 / 2.00 | 136.95 | — | — | — | — |  |
| startup-packaged | 0/3 | — / — / — | — / — | — | — | — | — | — | No packaged GPUIX bundle or checkout-local Rust binaries; a Rust packaging build is outside the quick suite. |
| open-long | 3/3 | 200.00 / 214.61 / 216.63 | 75.00 / 75.00 | 216.63 | — | 3.12 | 109.40 | 340.00 |  |
| older-history | 3/3 | 200.00 / 201.96 / 216.44 | 75.00 / 75.00 | 216.44 | — | 3.66 | 225.40 | 391.00 |  |
| thread-scroll | 3/3 | 166.88 / 1108.98 / 1208.73 | 57.00 / 57.00 | 1208.73 | 657.33 | 69.69 | 164.90 | 284.00 |  |
| thread-fling | 3/3 | 155.16 / 1158.48 / 1198.76 | 56.00 / 56.00 | 1198.76 | 882.97 | 68.95 | 150.90 | 322.00 |  |
| sidebar-scroll | 3/3 | 16.69 / 27.32 / 982.79 | 222.00 / 19.00 | 1038.02 | 853.65 | 74.00 | 514.50 | 293.00 |  |
| explorer-scroll | 3/3 | 201.19 / 1242.70 / 1268.08 | 50.00 / 44.00 | 1268.08 | 202.10 | 52.34 | 125.30 | 669.00 |  |
| markdown-scroll | 3/3 | 200.16 / 1102.59 / 1204.92 | 46.00 / 46.00 | 1204.92 | 546.60 | 45.74 | 130.10 | 454.00 |  |
| code-scroll | 3/3 | 200.05 / 1097.38 / 1171.74 | 46.00 / 46.00 | 1171.74 | 224.86 | 44.94 | 109.20 | 486.00 |  |
| pr-summary | 3/3 | 16.66 / 18.51 / 18.90 | 325.00 / 3.00 | 563.43 | 305.44 | 21.58 | 1095.60 | 219.00 |  |
| pr-changes | 3/3 | 16.67 / 16.80 / 16.86 | 246.00 / 0.00 | 16.90 | 10.73 | 38.16 | 2772.40 | 243.00 |  |
| streaming | 3/3 | 16.66 / 23.45 / 27.33 | 411.00 / 0.00 | 32.33 | — | 40.61 | 2502.30 | 298.00 |  |
| idle-home | 3/3 | — / — / — | 0.00 / 0.00 | — | — | 1.20 | 0.00 | 228.00 |  |
| idle-thread | 3/6 | 120.40 / 120.40 / 120.40 | 0.00 / 0.00 | 120.40 | — | 3.05 | 2.40 | 406.00 | build overlap: discarded |

Medians use successful repeats only (three each). The three idle-thread discard records remain in JSON; the replacement three runs pass. Frame percentile cells for idle use only runs that submitted two or more scenes, so they do not describe recurring activity. Home submitted 1/0/0 scenes and settled thread 3/0/1 scenes across its three windows; the few updates are not sustained animation. The baseline is therefore low-work idle, but does not satisfy an absolute zero-frames gate in every sample.


| Scenario | Timing median ms | Render p95 ms | Layout p95 ms | CPU ms/submission | GPU ms/submission |
|---|---|---:|---:|---:|---:|
| startup-cold | firstContentMs 1894.62, firstNativeSubmissionMs 1187.13, firstPaintedShellMs 1476.07 | 11.77 | 1.39 | — | — |

CPU/GPU per-submission averages include sparse non-render process work and are not frame CPU/GPU durations. Render p95 includes native rendering work and waits; layout is an included subset. The complete audited scenario execution totals approximately 16.7 minutes, excluding recorded queue/build waiting. This is slightly above the approximate 15-minute suite goal; focused scenario batches remain the recommended A/B loop. No optimization speedup is claimed.

## Five worst continuous-scroll scenarios

Ranked by median scene-submission p95: Explorer (1,242.70 ms), thread fling (1,158.48 ms), thread scroll (1,108.98 ms), Markdown preview (1,102.59 ms), and code preview (1,097.38 ms). All five have approximately 1.2-second maximum gaps. Explorer peaks at 669 MiB median footprint; thread input uses about 69% of one CPU core. Native render p95 is approximately 1,082 ms for Explorer, 149 ms for fling, 136 ms for thread scroll, 174 ms for Markdown and 140 ms for code. Markdown includes about 45 ms p95 Taffy layout; the other four have about 2–3 ms layout, so whole-render time cannot be attributed to Taffy alone. Profiles below distinguish renderer construction, text and drawable waits.

These are baseline-ef2251e2 results. Later integration commits, including current-0e2f0761, are not measured by this table. A matched current checkout/addon suite was optional and was not run to avoid a second source/dependency setup while shared UI lanes were active.

## Desktop frontend in WebKit reference

| Scenario | OK/runs | Frame p50/p95/p99 ms | >16.7/>33 | Max gap ms | Latency proxy p95 ms | CPU % | GPU ms/window | MiB | Notes |
|---|---:|---|---|---:|---:|---:|---:|---:|---|
| thread-scroll | 3/3 | 17.00 / 18.00 / 18.00 | 532.00 / 0.00 | 21.00 | 12.00 | 55.81 | 28.50 | 724.00 |  |
| markdown-scroll | 3/3 | 17.00 / 18.00 / 18.00 | 542.00 / 0.00 | 23.00 | 10.00 | 69.51 | 135.40 | 753.00 |  |
| code-scroll | 3/3 | 17.00 / 18.00 / 19.00 | 593.00 / 0.00 | 20.00 | 13.00 | 53.23 | 5.20 | 667.00 |  |
| pr-summary | 3/3 | 17.00 / 19.00 / 19.00 | 604.00 / 0.00 | 19.00 | 15.00 | 45.45 | 289.80 | 538.00 |  |
| pr-changes | 3/3 | 17.00 / 19.00 / 19.00 | 600.00 / 0.00 | 19.00 | 15.00 | 44.34 | 264.00 | 581.00 |  |

Three successful repeats per scene, ten-second warm-up and independent 15-second resource windows; dark theme, 1280 × 820, device scale two, KYBERN_FULL_RATE=1. This is the actual desktop frontend, using Vite and cached Playwright WebKit. Frame intervals are rAF cadence; latency is DOM-wheel-to-next-rAF. The resource coalition includes WebKit browser, WebContent, GPU and networking processes, excluding Vite, the test controller, and daemon. These values are reference context, not a native Tauri measurement or a matched native-renderer A/B. Different input backends, process coalitions, scheduling fences and runtime code prevent a speedup claim.

The first thread warm-up was interrupted by Vite discovering Shiki dependencies and reloading the page. It contributed no timing row. The three thread/preview scenes were rerun after the cache was primed and all fifteen reference rows pass the build/process audits. A rejected wheel packet now reports a failed window without an unhandled cleanup promise. Original PR rows and the successful cached-dependency batch are combined with provenance in results/desktop-webkit.json.

## Profiles and structural counters

Profiles are separate diagnostic runs because `sample` changes scheduling. Inclusive stack counts overlap and are not summed or represented as wall-time percentages. React mount/host counts are outside timed windows; native built-child, Markdown-parse, text-shaping, mutation and image/Metal byte counters remain explicitly unavailable unless native instrumentation supplies them.

The three worst scenarios were profiled for five seconds each after ten seconds of warm-up, under a separate UI lease per scenario. Build and foreign-process audits pass. Raw profiles are under `previews/gpuix/perf/bench/profiles-ef2251e2/<scenario>-attempt-1/profile-<scenario>-1.txt` in the original conversation workspace; the small extracted record is [profiles-summary.json](results/profiles-summary.json). These runs are diagnostics, excluded from the three-repeat baseline.

| Profile | Main-thread samples | Prepaint inclusive | Motion-state sync inclusive | Element build inclusive | Taffy inclusive | Shaping | GPU submit |
|---|---:|---:|---:|---:|---:|---:|---:|
| Explorer | 2,717 | 1,647 | 899 | 17 | 1 | unavailable | 4 |
| Thread fling | 2,589 | 507 | 241 | 141 | 45 | 1 | 3 |
| Thread scroll | 2,459 | 980 | 510 | 36 | 24 | 1 | 2 |

All three expose repeated native property hashing/JSON comparisons, `MotionState::sample`, and `sync_motion_states` inside the GPUI draw/prepaint path. The collapsed leaf summaries include 496/375/204 string-hash samples and 433/446/253 SipHash-write samples for Explorer/fling/thread respectively. This points to retained-tree property/motion scanning as a substantial CPU cost alongside prepaint; a targeted native profile is warranted before changing it. Explorer's 10,000 retained rows amplify that cost. The structural control below independently establishes that native list paint bounds do not bound React mounts.

These samples do **not** establish Markdown parsing, text shaping, GPU saturation, or Taffy as the primary cause of the three profiled stalls. Markdown parsing and React commit symbols are unresolved/absent in this sampling view; React commit telemetry reports 9/12/14 commits in the five-second Explorer/fling/thread diagnostic windows. `nextDrawable` appears once for fling and is absent in the other two, providing no evidence for a dominant drawable wait in these captures. Worker-thread waits in the all-thread leaf summary must not be mistaken for main-thread CPU work. The Markdown preview's separate 45 ms layout p95 remains direct evidence of an additional layout problem; code preview's render/layout split points elsewhere, but those two were not independently profiled in this audited batch.

The diagnostic input producer records 600 process-local AppKit packets in 4,999/5,001/5,000 ms (approximately 120 Hz). That confirms this later five-second producer schedule, without retroactively validating the early baseline batches' missing producer-duration fields or claiming physical presentation latency.

The headless structural control demonstrates the mount contract of `<virtual-list>`: supplying 300/3,000/10,000 children mounts every supplied React row; supplying a caller window of 32 mounts 32. This does not measure native scrolling, frame rate or footprint.

An additional full-app five-second diagnostic collects bounded fiber counts **after** timing ([mounted-counters-ef2251e2-final.json](results/mounted-counters-ef2251e2-final.json)). It visits 191,059 fibers without truncation. The expanded dock has 109,300 host nodes, 72,065 component fibers and 12,408 direct mounted native list rows; the sidebar has 2,588 host nodes / 222 list rows and the loaded transcript 2,838 / 362. Row-component counts include wrappers; direct native list rows are the useful retained-child count. These are mounted counts, not per-frame built-child counts. The preceding one-second smoke had too few submissions and correctly failed; its record remains in the evidence directory and is excluded from baseline metrics.

## Limitations

Packaged startup is skipped when no checkout-local bundle/Rust binaries exist; the suite does not trigger a separate native packaging build. Cold startup means fresh preferences and process, without purging the OS filesystem cache. Desktop reference measurements are the **desktop frontend in Playwright WebKit**, with DOM-wheel-to-rAF timing, not a native Tauri host or a directly comparable presentation fence. No production UI behavior, styling, or motion was edited, so visual before/after comparisons are inapplicable to this benchmark-only change.

The baseline lacks physical input-to-present fences, energy measurements, a 120 Hz display run, and complete native parse/shaping/mutation/byte counters. No product fix or visual change is included. The current integration tip must be measured separately before claiming these baseline stalls remain in that build.

## Validation and cleanup

- `pnpm typecheck` and `pnpm exec tsc -p perf/bench/tsconfig.json`: pass.
- `bun test ./src`: 297 tests / 5,696 assertions, zero failures.
- `bun test perf/bench/model.test.ts`: eight tests / 28 assertions, zero failures.
- `node --check perf/bench/webkit.mjs`, `git diff --check`, and a self-comparison through `compare.ts`: pass. Self-comparison reports zero deltas, the expected noise flags, and the early producer-duration limitation.
- Aggregation audit: 45 successful native rows and 15 successful WebKit rows have no native-build marker or foreign-process overlap. Three packaged-launch skips and three discarded idle preflights remain explicit. Diagnostic/profile rows are separate.

This lane changes the shared benchmark, runner safety, measurement reporting and result documentation only. No product rendering/style behavior or native patch was added, so there is no product visual before/after pair. Timing captures contain no screenshots or manual-clock advances. Raw logs, profiles, partial-suite provenance and validation logs remain under `/Users/mymac/projects/ade/previews/gpuix/perf/bench/` (about 25 MiB), inside the original conversation workspace. Invalidated earlier runs stay outside the committed results.

At this resume's start and after cleanup the workspace volume reports **85 GiB free** (`df -h`); concurrent lanes share the volume and no reclaimed-space attribution is made. This lane's approximately 188 MiB GPUIX and 701 MiB desktop dependency installs were removed after checking processes/open files. No Rust target or native DerivedData remains. The approximately 25 MiB `native/build` runtime addon/dylib is retained so the measured binary stays available; binaries and evidence are not committed. The owned scratch port-4322 daemon and dataset were removed, and this lane left no application, sampler, Vite/WebKit process, UI queue entry, lock, build marker or quiet reservation. Other lanes' processes and reservations were preserved.

Branch: `gpuix/perf-bench`, product control `ef2251e2`. The final handoff reports the benchmark commit separately; no push, merge or source-branch switch was performed.
