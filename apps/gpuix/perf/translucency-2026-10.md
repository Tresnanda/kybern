# Window translucency perf gate (ADE-47, 2026-10-22)

Decides `DEFAULT_SIDEBAR_ONLY` in `src/platform/translucency.ts` (spec §7). **Outcome: both whole-window glass and Sidebar only fail the
gate as specified, so `DEFAULT_SIDEBAR_ONLY = true`.** The numbers below also show that the gate cannot discriminate on this run: the
two untouched-base runs differ from each other by more than the thresholds. Nothing was tuned to pass.

## Workload and apparatus

- Scenarios `streaming`, `thread-scroll`, `sidebar-scroll` (`--runs 3`, 10 s warm-up, three 15 s windows) and `idle-home` (`--warmup 20`,
  `KYBERN_BENCH_PERSISTED_IDLE=1`), as in `perf/bench/README.md`: hidden 2× test display, `GPUIX_BACKGROUND=1`, `KYBERN_FULL_RATE=1`,
  `KYBERN_BENCH_WINDOWSERVER=1`, scratch daemon `/Applications/kybern.app` kybernd 0.10.0 on port 4351, dark theme, AC power.
- Hardware Apple M1, macOS 27.0.1, Bun 1.4.0. Patched addon `/Applications/Kybern GPUIX.app/Contents/Resources/gpuix-native.darwin-arm64.node`,
  SHA-256 `5d12b1815ad57597396f68a1d928d9e79d634abeb244ffaba9f8e8f2f3fe9040` (the same file for every run).
- `before` is a clean checkout of `b225fa0d9`, the base plus only the harness change that samples WindowServer (`perf/sample.ts`,
  `perf/bench/*`); the app code is untouched. The implementation runs are `d7c01275d`.
- Order: before, window, sidebar, solid (reference), sidebar-r, window-r, before-r (about 6 minutes per label), then `window-light`
  (streaming only, reported). Result files: `perf/bench/results/ade47-*.json|md`.
- WindowServer CPU is `ps` time; its GPU time is the AGX per-PID counter and includes every other window on the test display. Intervals
  are scene submissions, not WindowServer presents. No energy claim.
- Other lanes were using the machine (a shared Mac). `run.ts` waits for foreign GPUIX apps and discards a window on overlap; none was
  discarded, but unrelated load cannot be excluded.

## Medians (three windows per row)

| Label | streaming CPU % / p95 ms / >33 | thread-scroll CPU % / p95 | sidebar-scroll CPU % / p95 | idle CPU % / MiB | streaming WS CPU % / WS GPU ms |
|---|---|---|---|---|---|
| before | 25.7 / 22.35 / 0 | 36.3 / 18.20 | 45.7 / 16.82 | 3.1 / 186 | 27.6 / 2958 |
| window | 41.4 / 32.70 / 38 | 48.9 / 17.59 | 42.1 / 17.48 | 4.2 / 211 | 34.1 / 2877 |
| sidebar | 44.7 / 24.64 / 0 | 46.8 / 17.48 | 47.7 / 17.67 | 4.5 / 206 | 27.7 / 2355 |
| solid (reference) | 44.5 / 24.82 / 0 | 49.9 / 16.93 | 48.2 / 17.47 | 4.1 / 192 | 23.8 / 1124 |
| sidebar-r | 45.6 / 24.97 / 0 | 50.5 / 18.78 | 47.4 / 17.45 | 4.3 / 207 | 25.9 / 2356 |
| window-r | 45.3 / 24.98 / 0 | 51.6 / 17.15 | 49.6 / 17.57 | 4.6 / 208 | 26.3 / 1808 |
| before-r | 44.7 / 24.79 / 0 | 46.9 / 17.43 | 47.7 / 17.49 | 5.4 / 206 | 26.7 / 2517 |
| window-light (streaming only) | 44.5 / 25.77 / 0 | | | | 27.5 / 1734 |

## What the data says

- **The control fails.** `before` vs `before-r` (the same code twice) fails 7 of the gate's checks (last block below). The first
  `before` run sits in a quieter regime (streaming 25.7% CPU, 367 submissions per window) than every later run, `solid` and `before-r`
  included (about 44.5%, 450–500 submissions). Forward pairs compare against that quiet run; reverse pairs compare against runs taken
  in the same regime as the implementation.
- **Window, reverse pair:** within noise on every metric except thread-scroll CPU (+4.7 points, limit +3), and `sidebar-r` shows the
  same +3.6. **Window, forward pair:** streaming frame p95 +10.4 ms with 38 intervals over 33 ms (runs: 59, 38, 20 intervals), CPU
  +15.6 points and WindowServer CPU +6.5. None of this reproduces in `window-r` (p95 24.98, 0 intervals), but the rule counts both pairs.
- **GPUIX GPU time:** whole-window glass is lower than vibrancy in all six rows (streaming 3022 → 1511 and 3014 → 1751 ms; thread-scroll
  2300 → 1599 and 3338 → 1620; sidebar-scroll 2211 → 1207 and 2895 → 1241), consistent with GPUI no longer drawing its `BlurredView`.
  Sidebar only and Solid stay at the vibrancy level. WindowServer CPU did not rise in any reverse pair beyond +2.7 points (sidebar-r
  thread-scroll, +14% GPU) and was lower for window-r streaming.
- **Idle:** 0 submissions and 0 GPU ms in every mode. Forward idle CPU +1.1 / +1.3 and +20–25 MiB are the same drift the control
  shows (`before` 186 MiB, `before-r` 206 MiB).
- **Menus (reported, not gating)**, `perf/bench/popup.ts model-picker`, 25 opens: frame p95 before 28.8 / 29.0 ms, window 27.3, sidebar 27.7;
  intervals over 33 ms: 1 / 0 vs 1 and 1; mount draw p95 37.6 / 38.0 vs 36.5 and 36.4 ms; footprint 251 / 245 vs 255 and 254 MiB. No regression
  from the cutout blur on this hardware.

## Decision

The rule in the spec: a mode passes only when both its forward and its reverse pair stay within every threshold. Window fails the forward pair
(streaming frame p95, intervals over 33 ms, CPU, WindowServer CPU, thread-scroll CPU, idle CPU and MiB) and the reverse pair (thread-scroll CPU).
Sidebar only fails both pairs as well (forward: streaming p95 and CPU, thread-scroll CPU and GPU, sidebar-scroll GPU, idle CPU and MiB; reverse:
thread-scroll p95 and CPU). Both fail, so `DEFAULT_SIDEBAR_ONLY = true` and this is reported to the parent. The failures that
the control reproduces (CPU and idle MiB drift) are measurement noise on a shared Mac; the one result that did not appear in the control
is the forward window streaming p95 (+10 ms, 38 intervals over 33 ms).

A rerun on a quiet machine, with `before` taken twice back to back (and not at the start of a session), would settle whether whole-window glass is
free; Settings › Appearance › Window lets the owner switch a variant to Translucent (whole window) without a release.

## Limits

One machine, one wallpaper-free hidden display, three windows per row, concurrent use by other lanes, and no energy claim. The gate numbers are
CPU, GPU and frame-interval counters, not what the user sees; the real blur look still wants one eye check on a real desktop.

## Compare tables

#### compare.ts `ade47-before` → `ade47-window`

| Scenario | Δ p95 ms | Δ >33 ms | Δ CPU points | Δ GPU ms | Δ MiB | Δ WS CPU points | Δ WS GPU ms | Δ WS GPU % | Noise flag |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| streaming | 10.35 | 38.00 | 15.64 | -1511.30 | 7.00 | 6.47 | -81.20 | -2.74 | render flags differ; inspect intended A/B |
| thread-scroll | -0.61 | 0.00 | 12.69 | -701.40 | -10.00 | -24.49 | -1916.70 | -48.26 | render flags differ; inspect intended A/B; frame <1 ms |
| sidebar-scroll | 0.66 | 0.00 | -3.59 | -1003.90 | 0.00 | -3.66 | -435.00 | -17.32 | render flags differ; inspect intended A/B; frame <1 ms |
| idle-home | — | 0.00 | 1.06 | 0.00 | 25.00 | -0.14 | -2.50 | -3.31 | render flags differ; inspect intended A/B; CPU <3 points |

#### compare.ts `ade47-before-r` → `ade47-window-r`

| Scenario | Δ p95 ms | Δ >33 ms | Δ CPU points | Δ GPU ms | Δ MiB | Δ WS CPU points | Δ WS GPU ms | Δ WS GPU % | Noise flag |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| streaming | 0.19 | 0.00 | 0.61 | -1263.30 | 6.00 | -0.39 | -708.90 | -28.16 | render flags differ; inspect intended A/B; frame <1 ms; CPU <3 points |
| thread-scroll | -0.28 | 0.00 | 4.72 | -1717.60 | 5.00 | 1.26 | -224.10 | -10.87 | render flags differ; inspect intended A/B; frame <1 ms |
| sidebar-scroll | 0.08 | 0.00 | 1.87 | -1653.50 | -6.00 | -2.72 | -3.80 | -0.19 | render flags differ; inspect intended A/B; frame <1 ms; CPU <3 points |
| idle-home | — | 0.00 | -0.80 | 0.00 | 2.00 | -0.19 | 0.00 | 0.00 | render flags differ; inspect intended A/B; CPU <3 points |

#### compare.ts `ade47-before` → `ade47-sidebar`

| Scenario | Δ p95 ms | Δ >33 ms | Δ CPU points | Δ GPU ms | Δ MiB | Δ WS CPU points | Δ WS GPU ms | Δ WS GPU % | Noise flag |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| streaming | 2.29 | 0.00 | 19.02 | -12.30 | -4.00 | 0.08 | -603.10 | -20.39 | render flags differ; inspect intended A/B |
| thread-scroll | -0.72 | 0.00 | 10.57 | 995.20 | -5.00 | -21.03 | -2051.20 | -51.65 | render flags differ; inspect intended A/B; frame <1 ms |
| sidebar-scroll | 0.86 | 0.00 | 2.06 | 668.70 | 4.00 | -0.86 | -590.60 | -23.51 | render flags differ; inspect intended A/B; frame <1 ms; CPU <3 points |
| idle-home | — | 0.00 | 1.33 | 0.00 | 20.00 | -0.33 | -3.40 | -4.50 | render flags differ; inspect intended A/B; CPU <3 points |

#### compare.ts `ade47-before-r` → `ade47-sidebar-r`

| Scenario | Δ p95 ms | Δ >33 ms | Δ CPU points | Δ GPU ms | Δ MiB | Δ WS CPU points | Δ WS GPU ms | Δ WS GPU % | Noise flag |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| streaming | 0.18 | 0.00 | 0.95 | 20.30 | 6.00 | -0.79 | -160.90 | -6.39 | render flags differ; inspect intended A/B; frame <1 ms; CPU <3 points |
| thread-scroll | 1.35 | 0.00 | 3.59 | -622.80 | 3.00 | 2.65 | 296.50 | 14.38 | render flags differ; inspect intended A/B |
| sidebar-scroll | -0.05 | 0.00 | -0.33 | -26.60 | -2.00 | -0.13 | -147.10 | -7.27 | render flags differ; inspect intended A/B; frame <1 ms; CPU <3 points |
| idle-home | — | 0.00 | -1.13 | 0.00 | 1.00 | -0.20 | 1.40 | 1.84 | render flags differ; inspect intended A/B; CPU <3 points |


## Gate tables (`perf/bench/gate.ts`)

#### gate.ts `ade47-before` → `ade47-window`

| Scenario | Metric | Before | After | Δ | Limit | Result |
|---|---|---:|---:|---:|---|---|
| streaming | frame p95 ms | 22.35 | 32.70 | 10.35 | Δ ≤ +1.0 | **FAIL** |
| streaming | intervals > 33 ms | 0 | 38 | 38 | Δ ≤ +1 | **FAIL** |
| streaming | GPUIX CPU % | 25.72 | 41.36 | 15.64 | Δ ≤ +3 | **FAIL** |
| streaming | GPUIX GPU ms | 3021.80 | 1510.50 | -1511.30 | Δ ≤ +10% | pass |
| streaming | GPUIX MiB | 249 | 256 | 7 | Δ ≤ +10 | pass |
| streaming | WindowServer CPU % | 27.64 | 34.11 | 6.47 | Δ ≤ +3 | **FAIL** |
| streaming | WindowServer GPU ms | 2958.40 | 2877.20 | -81.20 | Δ ≤ +15% | pass |
| thread-scroll | frame p95 ms | 18.20 | 17.59 | -0.61 | Δ ≤ +1.0 | pass |
| thread-scroll | intervals > 33 ms | 0 | 0 | 0 | Δ ≤ +1 | pass |
| thread-scroll | GPUIX CPU % | 36.25 | 48.94 | 12.69 | Δ ≤ +3 | **FAIL** |
| thread-scroll | GPUIX GPU ms | 2300.30 | 1598.90 | -701.40 | Δ ≤ +10% | pass |
| thread-scroll | GPUIX MiB | 259 | 249 | -10 | Δ ≤ +10 | pass |
| thread-scroll | WindowServer CPU % | 43.64 | 19.15 | -24.49 | Δ ≤ +3 | pass |
| thread-scroll | WindowServer GPU ms | 3971.40 | 2054.70 | -1916.70 | Δ ≤ +15% | pass |
| sidebar-scroll | frame p95 ms | 16.82 | 17.48 | 0.66 | Δ ≤ +1.0 | pass |
| sidebar-scroll | intervals > 33 ms | 0 | 0 | 0 | Δ ≤ +1 | pass |
| sidebar-scroll | GPUIX CPU % | 45.68 | 42.09 | -3.59 | Δ ≤ +3 | pass |
| sidebar-scroll | GPUIX GPU ms | 2210.50 | 1206.60 | -1003.90 | Δ ≤ +10% | pass |
| sidebar-scroll | GPUIX MiB | 243 | 243 | 0 | Δ ≤ +10 | pass |
| sidebar-scroll | WindowServer CPU % | 20.48 | 16.82 | -3.66 | Δ ≤ +3 | pass |
| sidebar-scroll | WindowServer GPU ms | 2511.60 | 2076.60 | -435 | Δ ≤ +15% | pass |
| idle-home | GPUIX CPU % | 3.12 | 4.18 | 1.06 | Δ ≤ +1 | **FAIL** |
| idle-home | submissions | 0 | 0 | 0 | stays 0 | pass |
| idle-home | GPUIX GPU ms | 0 | 0 | 0 | stays 0 | pass |
| idle-home | GPUIX MiB | 186 | 211 | 25 | Δ ≤ +10 | **FAIL** |
| idle-home | WindowServer CPU % | 3.39 | 3.25 | -0.14 | Δ ≤ +1 | pass |
| idle-home | WindowServer GPU ms | 75.60 | 73.10 | -2.50 | Δ ≤ +15% | pass |

FAILS: streaming frame p95 ms; streaming intervals > 33 ms; streaming GPUIX CPU %; streaming WindowServer CPU %; thread-scroll GPUIX CPU %; idle-home GPUIX CPU %; idle-home GPUIX MiB

#### gate.ts `ade47-before-r` → `ade47-window-r`

| Scenario | Metric | Before | After | Δ | Limit | Result |
|---|---|---:|---:|---:|---|---|
| streaming | frame p95 ms | 24.79 | 24.98 | 0.19 | Δ ≤ +1.0 | pass |
| streaming | intervals > 33 ms | 0 | 0 | 0 | Δ ≤ +1 | pass |
| streaming | GPUIX CPU % | 44.66 | 45.27 | 0.61 | Δ ≤ +3 | pass |
| streaming | GPUIX GPU ms | 3014.30 | 1751 | -1263.30 | Δ ≤ +10% | pass |
| streaming | GPUIX MiB | 244 | 250 | 6 | Δ ≤ +10 | pass |
| streaming | WindowServer CPU % | 26.72 | 26.33 | -0.39 | Δ ≤ +3 | pass |
| streaming | WindowServer GPU ms | 2517.20 | 1808.30 | -708.90 | Δ ≤ +15% | pass |
| thread-scroll | frame p95 ms | 17.43 | 17.15 | -0.28 | Δ ≤ +1.0 | pass |
| thread-scroll | intervals > 33 ms | 0 | 0 | 0 | Δ ≤ +1 | pass |
| thread-scroll | GPUIX CPU % | 46.88 | 51.60 | 4.72 | Δ ≤ +3 | **FAIL** |
| thread-scroll | GPUIX GPU ms | 3337.60 | 1620 | -1717.60 | Δ ≤ +10% | pass |
| thread-scroll | GPUIX MiB | 247 | 252 | 5 | Δ ≤ +10 | pass |
| thread-scroll | WindowServer CPU % | 22.88 | 24.14 | 1.26 | Δ ≤ +3 | pass |
| thread-scroll | WindowServer GPU ms | 2062 | 1837.90 | -224.10 | Δ ≤ +15% | pass |
| sidebar-scroll | frame p95 ms | 17.49 | 17.57 | 0.08 | Δ ≤ +1.0 | pass |
| sidebar-scroll | intervals > 33 ms | 0 | 0 | 0 | Δ ≤ +1 | pass |
| sidebar-scroll | GPUIX CPU % | 47.74 | 49.61 | 1.87 | Δ ≤ +3 | pass |
| sidebar-scroll | GPUIX GPU ms | 2894.80 | 1241.30 | -1653.50 | Δ ≤ +10% | pass |
| sidebar-scroll | GPUIX MiB | 249 | 243 | -6 | Δ ≤ +10 | pass |
| sidebar-scroll | WindowServer CPU % | 19.88 | 17.16 | -2.72 | Δ ≤ +3 | pass |
| sidebar-scroll | WindowServer GPU ms | 2024.50 | 2020.70 | -3.80 | Δ ≤ +15% | pass |
| idle-home | GPUIX CPU % | 5.38 | 4.58 | -0.80 | Δ ≤ +1 | pass |
| idle-home | submissions | 0 | 0 | 0 | stays 0 | pass |
| idle-home | GPUIX GPU ms | 0 | 0 | 0 | stays 0 | pass |
| idle-home | GPUIX MiB | 206 | 208 | 2 | Δ ≤ +10 | pass |
| idle-home | WindowServer CPU % | 3.45 | 3.26 | -0.19 | Δ ≤ +1 | pass |
| idle-home | WindowServer GPU ms | 76.10 | 76.10 | 0 | Δ ≤ +15% | pass |

FAILS: thread-scroll GPUIX CPU %

#### gate.ts `ade47-before` → `ade47-sidebar`

| Scenario | Metric | Before | After | Δ | Limit | Result |
|---|---|---:|---:|---:|---|---|
| streaming | frame p95 ms | 22.35 | 24.64 | 2.29 | Δ ≤ +1.0 | **FAIL** |
| streaming | intervals > 33 ms | 0 | 0 | 0 | Δ ≤ +1 | pass |
| streaming | GPUIX CPU % | 25.72 | 44.74 | 19.02 | Δ ≤ +3 | **FAIL** |
| streaming | GPUIX GPU ms | 3021.80 | 3009.50 | -12.30 | Δ ≤ +10% | pass |
| streaming | GPUIX MiB | 249 | 245 | -4 | Δ ≤ +10 | pass |
| streaming | WindowServer CPU % | 27.64 | 27.72 | 0.08 | Δ ≤ +3 | pass |
| streaming | WindowServer GPU ms | 2958.40 | 2355.30 | -603.10 | Δ ≤ +15% | pass |
| thread-scroll | frame p95 ms | 18.20 | 17.48 | -0.72 | Δ ≤ +1.0 | pass |
| thread-scroll | intervals > 33 ms | 0 | 0 | 0 | Δ ≤ +1 | pass |
| thread-scroll | GPUIX CPU % | 36.25 | 46.82 | 10.57 | Δ ≤ +3 | **FAIL** |
| thread-scroll | GPUIX GPU ms | 2300.30 | 3295.50 | 995.20 | Δ ≤ +10% | **FAIL** |
| thread-scroll | GPUIX MiB | 259 | 254 | -5 | Δ ≤ +10 | pass |
| thread-scroll | WindowServer CPU % | 43.64 | 22.61 | -21.03 | Δ ≤ +3 | pass |
| thread-scroll | WindowServer GPU ms | 3971.40 | 1920.20 | -2051.20 | Δ ≤ +15% | pass |
| sidebar-scroll | frame p95 ms | 16.82 | 17.67 | 0.86 | Δ ≤ +1.0 | pass |
| sidebar-scroll | intervals > 33 ms | 0 | 0 | 0 | Δ ≤ +1 | pass |
| sidebar-scroll | GPUIX CPU % | 45.68 | 47.74 | 2.06 | Δ ≤ +3 | pass |
| sidebar-scroll | GPUIX GPU ms | 2210.50 | 2879.20 | 668.70 | Δ ≤ +10% | **FAIL** |
| sidebar-scroll | GPUIX MiB | 243 | 247 | 4 | Δ ≤ +10 | pass |
| sidebar-scroll | WindowServer CPU % | 20.48 | 19.62 | -0.86 | Δ ≤ +3 | pass |
| sidebar-scroll | WindowServer GPU ms | 2511.60 | 1921 | -590.60 | Δ ≤ +15% | pass |
| idle-home | GPUIX CPU % | 3.12 | 4.45 | 1.33 | Δ ≤ +1 | **FAIL** |
| idle-home | submissions | 0 | 0 | 0 | stays 0 | pass |
| idle-home | GPUIX GPU ms | 0 | 0 | 0 | stays 0 | pass |
| idle-home | GPUIX MiB | 186 | 206 | 20 | Δ ≤ +10 | **FAIL** |
| idle-home | WindowServer CPU % | 3.39 | 3.06 | -0.33 | Δ ≤ +1 | pass |
| idle-home | WindowServer GPU ms | 75.60 | 72.20 | -3.40 | Δ ≤ +15% | pass |

FAILS: streaming frame p95 ms; streaming GPUIX CPU %; thread-scroll GPUIX CPU %; thread-scroll GPUIX GPU ms; sidebar-scroll GPUIX GPU ms; idle-home GPUIX CPU %; idle-home GPUIX MiB

#### gate.ts `ade47-before-r` → `ade47-sidebar-r`

| Scenario | Metric | Before | After | Δ | Limit | Result |
|---|---|---:|---:|---:|---|---|
| streaming | frame p95 ms | 24.79 | 24.97 | 0.18 | Δ ≤ +1.0 | pass |
| streaming | intervals > 33 ms | 0 | 0 | 0 | Δ ≤ +1 | pass |
| streaming | GPUIX CPU % | 44.66 | 45.61 | 0.95 | Δ ≤ +3 | pass |
| streaming | GPUIX GPU ms | 3014.30 | 3034.60 | 20.30 | Δ ≤ +10% | pass |
| streaming | GPUIX MiB | 244 | 250 | 6 | Δ ≤ +10 | pass |
| streaming | WindowServer CPU % | 26.72 | 25.93 | -0.79 | Δ ≤ +3 | pass |
| streaming | WindowServer GPU ms | 2517.20 | 2356.30 | -160.90 | Δ ≤ +15% | pass |
| thread-scroll | frame p95 ms | 17.43 | 18.78 | 1.35 | Δ ≤ +1.0 | **FAIL** |
| thread-scroll | intervals > 33 ms | 0 | 0 | 0 | Δ ≤ +1 | pass |
| thread-scroll | GPUIX CPU % | 46.88 | 50.47 | 3.59 | Δ ≤ +3 | **FAIL** |
| thread-scroll | GPUIX GPU ms | 3337.60 | 2714.80 | -622.80 | Δ ≤ +10% | pass |
| thread-scroll | GPUIX MiB | 247 | 250 | 3 | Δ ≤ +10 | pass |
| thread-scroll | WindowServer CPU % | 22.88 | 25.53 | 2.65 | Δ ≤ +3 | pass |
| thread-scroll | WindowServer GPU ms | 2062 | 2358.50 | 296.50 | Δ ≤ +15% | pass |
| sidebar-scroll | frame p95 ms | 17.49 | 17.45 | -0.05 | Δ ≤ +1.0 | pass |
| sidebar-scroll | intervals > 33 ms | 0 | 0 | 0 | Δ ≤ +1 | pass |
| sidebar-scroll | GPUIX CPU % | 47.74 | 47.41 | -0.33 | Δ ≤ +3 | pass |
| sidebar-scroll | GPUIX GPU ms | 2894.80 | 2868.20 | -26.60 | Δ ≤ +10% | pass |
| sidebar-scroll | GPUIX MiB | 249 | 247 | -2 | Δ ≤ +10 | pass |
| sidebar-scroll | WindowServer CPU % | 19.88 | 19.75 | -0.13 | Δ ≤ +3 | pass |
| sidebar-scroll | WindowServer GPU ms | 2024.50 | 1877.40 | -147.10 | Δ ≤ +15% | pass |
| idle-home | GPUIX CPU % | 5.38 | 4.25 | -1.13 | Δ ≤ +1 | pass |
| idle-home | submissions | 0 | 0 | 0 | stays 0 | pass |
| idle-home | GPUIX GPU ms | 0 | 0 | 0 | stays 0 | pass |
| idle-home | GPUIX MiB | 206 | 207 | 1 | Δ ≤ +10 | pass |
| idle-home | WindowServer CPU % | 3.45 | 3.25 | -0.20 | Δ ≤ +1 | pass |
| idle-home | WindowServer GPU ms | 76.10 | 77.50 | 1.40 | Δ ≤ +15% | pass |

FAILS: thread-scroll frame p95 ms; thread-scroll GPUIX CPU %

#### gate.ts `ade47-before` → `ade47-before-r`

| Scenario | Metric | Before | After | Δ | Limit | Result |
|---|---|---:|---:|---:|---|---|
| streaming | frame p95 ms | 22.35 | 24.79 | 2.44 | Δ ≤ +1.0 | **FAIL** |
| streaming | intervals > 33 ms | 0 | 0 | 0 | Δ ≤ +1 | pass |
| streaming | GPUIX CPU % | 25.72 | 44.66 | 18.94 | Δ ≤ +3 | **FAIL** |
| streaming | GPUIX GPU ms | 3021.80 | 3014.30 | -7.50 | Δ ≤ +10% | pass |
| streaming | GPUIX MiB | 249 | 244 | -5 | Δ ≤ +10 | pass |
| streaming | WindowServer CPU % | 27.64 | 26.72 | -0.92 | Δ ≤ +3 | pass |
| streaming | WindowServer GPU ms | 2958.40 | 2517.20 | -441.20 | Δ ≤ +15% | pass |
| thread-scroll | frame p95 ms | 18.20 | 17.43 | -0.77 | Δ ≤ +1.0 | pass |
| thread-scroll | intervals > 33 ms | 0 | 0 | 0 | Δ ≤ +1 | pass |
| thread-scroll | GPUIX CPU % | 36.25 | 46.88 | 10.63 | Δ ≤ +3 | **FAIL** |
| thread-scroll | GPUIX GPU ms | 2300.30 | 3337.60 | 1037.30 | Δ ≤ +10% | **FAIL** |
| thread-scroll | GPUIX MiB | 259 | 247 | -12 | Δ ≤ +10 | pass |
| thread-scroll | WindowServer CPU % | 43.64 | 22.88 | -20.76 | Δ ≤ +3 | pass |
| thread-scroll | WindowServer GPU ms | 3971.40 | 2062 | -1909.40 | Δ ≤ +15% | pass |
| sidebar-scroll | frame p95 ms | 16.82 | 17.49 | 0.68 | Δ ≤ +1.0 | pass |
| sidebar-scroll | intervals > 33 ms | 0 | 0 | 0 | Δ ≤ +1 | pass |
| sidebar-scroll | GPUIX CPU % | 45.68 | 47.74 | 2.06 | Δ ≤ +3 | pass |
| sidebar-scroll | GPUIX GPU ms | 2210.50 | 2894.80 | 684.30 | Δ ≤ +10% | **FAIL** |
| sidebar-scroll | GPUIX MiB | 243 | 249 | 6 | Δ ≤ +10 | pass |
| sidebar-scroll | WindowServer CPU % | 20.48 | 19.88 | -0.60 | Δ ≤ +3 | pass |
| sidebar-scroll | WindowServer GPU ms | 2511.60 | 2024.50 | -487.10 | Δ ≤ +15% | pass |
| idle-home | GPUIX CPU % | 3.12 | 5.38 | 2.26 | Δ ≤ +1 | **FAIL** |
| idle-home | submissions | 0 | 0 | 0 | stays 0 | pass |
| idle-home | GPUIX GPU ms | 0 | 0 | 0 | stays 0 | pass |
| idle-home | GPUIX MiB | 186 | 206 | 20 | Δ ≤ +10 | **FAIL** |
| idle-home | WindowServer CPU % | 3.39 | 3.45 | 0.06 | Δ ≤ +1 | pass |
| idle-home | WindowServer GPU ms | 75.60 | 76.10 | 0.50 | Δ ≤ +15% | pass |

FAILS: streaming frame p95 ms; streaming GPUIX CPU %; thread-scroll GPUIX CPU %; thread-scroll GPUIX GPU ms; sidebar-scroll GPUIX GPU ms; idle-home GPUIX CPU %; idle-home GPUIX MiB

