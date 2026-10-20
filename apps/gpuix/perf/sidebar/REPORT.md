# Sidebar optimization pass — 2026-10-18

Branch `gpuix/perf-sidebar`, base `564151aa`. Implementation `6a8ee2cd`; initial harness `6ef39b27`. The final follow-up commit contains this report and the measurement corrections.

## Outcome and limits

Cached list geometry removes the severe original input backlog. Bounded rich mounts reduce normal-scroll CPU from about 100% to 76–81%, and reduce CPU, GPU and footprint compared with the cached-layout-only control. They do **not** meet the full smoothness target: ordinary p95 submission intervals remain 22.7–23.8 ms, p99 is 43–47 ms, and the fast-wheel case is 59.95 / 72.05 ms p95/p99. The P1-only control has better tails at higher CPU and memory cost. No universal 60 fps, no-frame-over-33-ms, 120 Hz, lower-total-GPU, energy, or physical-input claim is established.

The cold candidate sidebar median is **1809 ms**, nominally below the historical 1830 ms goal, versus 1841 ms for the current matched control. This 32 ms difference is within the observed daemon variance. The candidate's list-ready-to-sidebar-paint phase is **slower** (119–162 ms versus 96–104 ms). Therefore a causal fix for the earlier 1.83 → 2.32 s cold-sidebar regression is **not proven**. The first-content median is 1944 versus 2746 ms, but varying RPC timings prevent attributing that whole difference to row windowing. Warm medians regress in this small sample; all samples remain visible below.

## Workload and isolation

Apple M1 / 16 GiB, MacBookPro17,1, macOS 27.0.1 (26A434), Bun 1.4.0, GPUIX 0.10.0, 60 Hz Retina LCD. `KYBERN_FULL_RATE=1` for **every** reported result. Active UI: opaque 1440×900 window, same native addon SHA-256 `33865fdd47dfbcbe6edfbcbc29c3b750bf626ad8cc77f4130922cdbfb62bc5bc`. Default experiment flags are recorded in `environment.json`; no global pacing/native default changed.

Synthetic fixture: 300 threads / 20 projects, twelve 1,000–2,500-turn conversations, 32,076 turns / 162,126 events, restored 2,500-turn conversation. Settled, running (20 parents and 40 child rows), and mixed (some collapsed projects) sidebar states. Each active sample warms for 10 seconds and samples for 15 seconds, offering 1,800 precise native AppKit wheel packets at 120 Hz, with contact, exponential momentum and reversal. Normal magnitude 10; fast magnitude 30. Normal scenes have two alternating-order repeats per variant; fast/controls have one each. Frame intervals pool the repeats; CPU/GPU/footprint are means of per-run samples.

Fresh process/cache-cold comparisons use complete compiled app bundles, 1280×820 windows and the **same current debug daemon** built from this worktree, including perf-startup's sparse activity index and batched Git probes. Each variant gets its own fresh daemon and projection cache, alternating pair order three times; each fixture also records a second warm launch. Daemon startup/migrations and OS filesystem-cache purging are excluded. The explicit scratch URL bypasses the bundle's installed sidecar. The build log, daemon SHA and source commit are in `environment.json` / `daemon-build.log`.

All runs use only scratch port 4327 (proxy 4328), data/config/credentials under `/Users/mymac/projects/ade-gpuix-scratch/perf-sidebar`. No agent turns were launched. UI leases enforce one capture at a time; the final quiet window ran 06:36:41–07:00:28Z (under 25 minutes). Every timed run retained before/after GPUIX process listings and before/during/after build-marker checks. No accepted sample overlaps another GPUIX app or native build.

Native scene submission timestamps are not physical presentation fences. `offeredToAppKitHandlerEnd` includes the AppKit queue and handler. `inputToCpuPaint` starts at native dispatch, excludes that queue, and ends CPU scene construction; neither measures input-to-photon. Resources exclude daemon and WindowServer; GPU time is separate from CPU and is not energy.

## Findings and fixes

The old native virtual list bounded paint but React mounted every rich sidebar row. In the mixed interaction fixture, baseline mounted 161 row/list bodies and 2,724 sidebar host nodes. Candidate mounted 40 bodies / 864 nodes initially, 43 / 877 at the distant end and 40 / 873 on return, preserving 190 stable logical slots. In the cold fixture, the candidate initially committed 45 bodies for 222 slots.

The separate diagnostic profiles show native event dispatch repeatedly entering `build_virtual_child`, retained element construction and layout in the baseline. One inclusive `build_virtual_child` branch accounts for 699 of 2,747 main-thread samples, versus 118 of 2,338 in the candidate. These are representative inclusive branches, **not** disjoint totals or matched CPU percentages. Raw files: `baseline-final-profile-sidebar-sample.txt`, `candidate-final-profile-sidebar-sample.txt`; instrumented profile runs are excluded from clean timing/resource comparisons.

- `src/Sidebar.tsx`: height-correct window entries, disclosure-group ownership, finishing-child ownership, and existing row rendering/geometry.
- `src/sidebar/Window.tsx`: stable native slot IDs, nearby rich bodies, cached layout/fill, a single list observation that also survives a jump into empty slots, coalesced anchor reads per native frame, row leases and no recurring timer. Rich buffer 768 px; refill threshold 640 px; native overdraw 128 px.
- `src/sidebar/windowRange.ts`: reads only local height neighborhoods, preserving logical anchors and variable-height exceptions.
- `src/sidebar/rows.tsx`: retain context-menu, inline-editor and completing-child owners; `src/sidebar/reorder.tsx`: retain a hidden dragged source through its existing lifecycle. Offscreen remounts do not replay entry motion.
- `src/sidebar/Window.test.tsx` and `windowRange.test.ts`: 3,000-slot jumps, native IDs, stale-frame rejection, overlay/editor ownership, entry-motion suppression, observer cleanup and 30,000-row local-range work.
- `perf/sidebar/*`: reusable scratch fixture, baseline/P1 source controls, paired packages, native wheel driver integration, before/during/after guards, fair leases, quiet-window wrapper, cold timeline, visuals, profiles and summaries. Corrected the process guard to distinguish real Bun commands from a shell inspecting the same pattern; paired batches share one lease within the five-minute limit; package startup also takes a lease.

**Native patches:** none. No package upgrades, state/navigation hydration changes or environment-switcher behavior changes in this lane. Zed's bounded rich work and geometry reuse informed the implementation; Zeron's cached sidebar entity was correctly treated as an ordinary scroller, not a virtual list (see `perf/zeron-zed-techniques.md`).

## Matched scrolling results

All rows: `KYBERN_FULL_RATE=1`. `baseline` is the original sidebar at `564151aa`; `p1` adds only layout/fill caching with all rich rows mounted; `candidate` adds bounded bodies. Counts are actual submitted frames; low baseline counts show starvation, so fewer long-frame counts there are not a smoothness improvement. Native CPU render p95 includes layout; do not add layout again.

| Scenario/variant | Frames | Interval p50 / p95 / p99 ms | >16.7 / >33 ms | Render p95 ms | CPU % | GPU ms / 15 s | Footprint MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| settled/baseline | 22 | 798.18 / 3972.62 / 3972.62 | 20 / 20 | 10.61 | 100.33 | 44.9 | 262.5 |
| settled/p1 | 1823 | 16.47 / 25.59 / 28.00 | 698 / 1 | 13.05 | 94.79 | 4049.3 | 284.5 |
| settled/candidate | 1769 | 16.60 / 22.74 / 43.04 | 728 / 56 | 7.40 | 76.45 | 3775.9 | 266.0 |
| running/baseline | 19 | 453.43 / 5692.30 / 5692.30 | 17 / 17 | 12.66 | 100.37 | 34.0 | 281.0 |
| running/p1 | 1761 | 13.35 / 29.71 / 39.06 | 554 / 31 | 13.98 | 100.31 | 3900.4 | 308.0 |
| running/candidate | 1766 | 16.65 / 23.76 / 45.25 | 627 / 55 | 7.60 | 80.56 | 3779.2 | 272.0 |
| mixed/baseline | 35 | 592.81 / 2642.61 / 2826.03 | 33 / 31 | 9.58 | 100.49 | 70.1 | 283.0 |
| mixed/p1 | 1784 | 16.58 / 26.21 / 34.10 | 826 / 30 | 11.66 | 94.18 | 3956.8 | 280.0 |
| mixed/candidate | 1761 | 16.63 / 23.35 / 46.52 | 724 / 59 | 7.59 | 80.88 | 3766.6 | 266.5 |
| fast/baseline | 12 | 655.20 / 5135.94 / 5135.94 | 11 / 11 | 11.03 | 100.46 | 45.0 | 277.0 |
| fast/p1 | 914 | 12.56 / 25.78 / 27.03 | 331 / 0 | 12.43 | 99.14 | 4063.3 | 292.0 |
| fast/candidate | 727 | 16.62 / 59.95 / 72.05 | 323 / 97 | 7.34 | 87.75 | 3128.9 | 272.0 |

| Scenario/variant | Offer → handler p95 ms, each run | Native dispatch → CPU paint p95 ms, each run | Delivered at offer end, of 1800 |
| --- | ---: | ---: | ---: |
| settled/baseline | 2550.98 / 2619.24 | 10.74 / 10.45 | 1478 / 1470 |
| settled/p1 | 13.62 / 11.52 | 24.63 / 24.54 | 1800 / 1800 |
| settled/candidate | 7.75 / 8.14 | 22.51 / 22.07 | 1800 / 1800 |
| running/baseline | 4206.76 / 3716.41 | 12.97 / 11.56 | 1267 / 1332 |
| running/p1 | 22.02 / 23.67 | 28.37 / 27.72 | 1799 / 1800 |
| running/candidate | 13.26 / 9.35 | 22.38 / 22.50 | 1800 / 1800 |
| mixed/baseline | 1441.24 / 1410.83 | 9.46 / 9.66 | 1620 / 1619 |
| mixed/p1 | 11.09 / 11.59 | 25.49 / 25.74 | 1800 / 1800 |
| mixed/candidate | 12.15 / 11.46 | 22.49 / 22.30 | 1800 / 1800 |
| fast/baseline | 2654.62 | 11.02 | 1467 |
| fast/p1 | 11.94 | 25.46 | 1800 |
| fast/candidate | 42.51 | 56.76 | 1800 |

Candidate normal CPU render p95 is 7.4–7.6 ms, but this does not establish total per-frame 120 Hz readiness. Candidate mean GPU cost is approximately 4.3 ms per submitted frame in the ordinary scenes. P1 submits many more frames than the starved baseline, so total GPU time rises dramatically. Against the similarly smooth P1 control, candidate GPU is roughly 3–7% lower and footprint roughly 5–12% lower; no GPU reduction against the original is claimed. Settled footprint is slightly above the starved baseline.

## Controls, rejected alternatives and idle

| Scenario/variant | Frames | Interval p50 / p95 / p99 ms | >16.7 / >33 ms | Render p95 ms | CPU % | GPU ms / 15 s | Footprint MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| wide-overdraw/candidate | 887 | 16.63 / 22.78 / 40.40 | 371 / 25 | 7.41 | 77.11 | 3781.9 | 265.0 |
| buffer-1536/candidate-fast | 757 | 17.09 / 22.00 / 174.64 | 467 / 19 | 9.29 | 92.35 | 3277.8 | 281.0 |
| buffer-3072/candidate-fast | 894 | 16.45 / 24.76 / 27.01 | 408 / 2 | 11.80 | 98.79 | 3991.9 | 283.0 |
| idle/baseline | 0 | — / — / — | 0 / 0 | — | 0.80 | 0.0 | 264.0 |
| idle/candidate | 3 | 18.36 / 18.36 / 18.36 | 1 / 0 | 2.17 | 0.80 | 13.5 | 250.0 |
| idle-settled/candidate | 0 | — / — / — | 0 / 0 | — | 2.39 | 0.0 | 243.0 |

The same-overdraw candidate control retains the CPU/render advantage; the main gain is not just 512 → 128 px native overdraw. At fast wheel magnitude 30, 1536 px rich buffer lowers p95 but creates rare ~175 ms stalls and higher CPU. 3072 px largely removes the refill stalls but approaches all-rich-row CPU/render cost for this workload. Both default changes were rejected; the 768 px balance remains. P1 alone is retained as an explicit smoother-tail/high-CPU control. Bounded remount work still needs improvement.

Both initial idle samples use a 10-second warmup. Baseline is quiet. Candidate has three late frames, then the separate 20-second-settle repeat records **zero frames, no render work and zero GPU** over 15 seconds. CPU 0.8 versus 2.39% between those candidate samples is below the three-point noise threshold; the longer-settle footprint is 243 MiB. No recurring animation/observation timer was added.

Initial 05:16–05:32Z runs are excluded under `excluded-overlap-0516-0532/`. Installed-daemon cold samples are diagnostic under `installed-daemon-cold/`, because that daemon lacks current startup fixes. The predecessor was cancelled; its incomplete current-daemon cold batch is excluded under `cancelled-current-daemon-0636/`. The resumed runner initially found a stale port file, refused to reuse it, and was restarted only after confirming no listener/process and removing that scratch data. These failed/incomplete attempts are absent from acceptance summaries.

## Cold and warm startup

Milliseconds, `KYBERN_FULL_RATE=1`, three pairs, same current debug daemon. Values are process spawn to native painted-text observation.

| Variant/temperature | Sidebar median ms | Newest content median ms | Sidebar samples ms | Lists-ready → sidebar samples ms |
| --- | ---: | ---: | ---: | ---: |
| cold/baseline | 1841.17 | 2746.32 | 2536.09 / 1621.36 / 1841.17 | 96.09 / 104.36 / 96.17 |
| warm/baseline | 1355.27 | 721.73 | 697.27 / 1407.31 / 1355.27 | 57.27 / 55.31 / 52.27 |
| cold/candidate | 1809.00 | 1944.24 | 1788.75 / 1809.00 / 2289.24 | 118.75 / 159.00 / 162.24 |
| warm/candidate | 1586.22 | 840.52 | 1973.51 / 1586.22 / 947.96 | 114.51 / 80.22 / 95.96 |

Lists-ready dominates: baseline cold 1517–2440 ms; candidate 1650–2127 ms. Shell medians are essentially identical (~503 ms). Candidate bodies commit 25–37 ms after lists-ready but visible paint follows later. Cold median meets the nominal historical threshold, yet the slower post-list phase and warm regression mean **the cold-paint root cause remains unresolved**; do not present the historical 2.32 → 1.81 s as a controlled causal speedup. The current daemon is an unoptimized dev build, whereas historical installed results used another binary.

## Visual and regression evidence

Evidence root: `/Users/mymac/projects/ade/previews/gpuix/perf/sidebar/`.

All six settled comparisons are **pixel-identical** in the declared sidebar/menu crops (869,688 pixels for sidebar/scrolled, 1,685,232 for menu): `baseline-visual-{dark,light}-{sidebar,sidebar-menu,sidebar-scrolled}.png` versus corresponding `candidate-visual-*`; `settled-pixel-diff.json` records zero changed pixels and zero maximum delta. Screenshots never overlap timing runs. Earlier running interaction captures differ only in independently phased glyphs for ordinary surfaces; context captures were caught during different entrance phases, so settled captures are the visual acceptance evidence.

Both baseline/candidate pass dark/light interaction checks: exact project drag pointer offset, landing/reorder and Escape; large jump/return; show more; disclosure and nested children; marquee, hover/actions/context menus; inline rename ownership while scrolling. Tooltip R4-1 passes 30 trials per variant/theme (120 total). Logs and captures are `*-checks-{dark,light}-*`, including held and landed drag views. These are synthetic native-path tests, not physical trackpad or accessibility-session certification.

Final validation: `pnpm typecheck`; `bun test ./src` (312 pass, 0 fail, 5,767 assertions, 45 files); harness `pnpm exec tsc --noEmit -p perf/sidebar/tsconfig.json`; summary and pixel scripts pass. The current daemon build passed (`cargo build -p kybern -j 4`, low priority, one worktree target). No Rust/native product source changed, so no additional native rebuild was needed.

## Cleanup and integration

Free space was 85 GiB at this resumed lane's start (the preceding resume recorded 84 GiB). Immediately before cleanup free space was 85.07 GiB; afterward it measured 86.41 GiB. Detailed cleanup evidence is in `cleanup.json`; concurrent lanes share this volume, so the delta is not attributed solely to deletion. The temporary 1.3 GiB Rust target, 251 MiB paired exports, 188/633 MiB task dependency installs, wheel dylib, temporary Bun build files, and task scratch data are removed after checking processes/open files. The 25 MiB runtime native addon/webview pair is retained because it is the checked build required to run this branch. Sources, commits and worktree registration remain; no user daemon/data or installed app was changed. All own locks, markers and queue lines are released.

The final follow-up commit is the branch tip; handoff reports its hash and clean git status. Primary remaining gaps: fast-scroll refill stalls, ordinary >33 ms frames, higher GPU use versus starvation, and unproven cold-paint causality. Only a 60 Hz synthetic workload was measured.
