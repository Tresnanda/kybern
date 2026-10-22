# Window translucency round 2: frost-class perf gate (ADE-47, 2026-10-22)

Decides which frost classes (a scene blur behind the glass tint) ship on whole-window glass, per `docs/specs/gpuix-translucency-r2.md` §8.
Control = the same build with every class tint-only (`KYBERN_GLASS_FROST=none`, `denseFloat` fill, same rim and highlight).

**Decision: no class passes the keep/drop rule, so `FROST_DEFAULT` in `src/platform/translucency.ts` is now empty.**
Composer, pills and menus all fall back to the layered tint (`denseFloat`, rim, top highlight, no blur, no shadow).
`KYBERN_GLASS_FROST=menus|composer|pills|all` turns a class back on.

| Class | Scenario that decides | GPUIX GPU ms per submitted frame vs tint-only (limit +30%) | Frame p95 / intervals > 33 ms / CPU | Result |
|---|---|---|---|---|
| composer (+ stacked request panels) | streaming; thread-scroll | **+73%** (CI 60 … 80); **+103%** (103 … 104) | pass | **drop** |
| menus | streaming-menu (model picker held open over the stream) | **+91%** (89 … 100); 2.51 → 4.79 ms | pass | **drop** |
| pills (scroll pill, selection bar, front toast, notes toolbar) | streaming-away | +29.8% (4 rounds, unresolved), **+27.2%** (23 … 32) after two more rounds, still unresolved | pass | **drop**: unresolved after the extra rounds and the point estimate is above half the limit (15%) |

What the numbers say: every class passes frame pacing (p95, intervals over 33 ms, CPU, WindowServer, idle) and fails or sits on the limit only on
GPUIX GPU time per submitted frame, whose base is small (1.3 to 2.5 ms), so one blur roughly doubles it. The absolute cost is +1.5 to +2.3 ms of GPU
per frame for the composer (3.4 ms vs 1.96 ms while streaming) and +2.3 ms for an open menu. The rule is the one the spec set; this is its outcome, not a
judgement that the frames stutter. If frost on menus is wanted anyway (round 1 shipped it), `FROST_DEFAULT = ['menus']` is the one-line change;
`popup.ts model-picker` (25 opens, three reps per arm) shows no frame regression from it (p95 28.7 / 28.2 / 28.7 ms vs 27.0 / 29.4 / 29.1 ms tint-only;
about +11 MiB footprint, limit +15).

## Apparatus

- **One build, arms by environment only.** Worktree HEAD `a42328340` (the bench scenario commit; no product change after it except `FROST_DEFAULT`, which the arms override),
  patched addon `native/build/gpuix-native.darwin-arm64.node` (N1 scratch pool, N2 half-resolution blur, N3 edgeFade, source-over alpha blend),
  SHA-256 `85a59fd92ed1333c25d83badf0b0aca2c8928715d0e080d6ff6d8fb16c6587bb`, bun 1.4.0, scratch kybernd from `/Applications/kybern.app`, `NAPI_RS_NATIVE_LIBRARY_PATH` pinned to that addon
  (the shell defaults to the installed app's addon, which has none of these).
  Every arm: `KYBERN_WINDOW_MATERIAL=window`, `KYBERN_WINDOW_OPACITY=90`, `KYBERN_WINDOW_BLUR=64`, `KYBERN_APPEARANCE=dark`, `KYBERN_FULL_RATE=1`, `KYBERN_BENCH_WINDOWSERVER=1`,
  and `KYBERN_GLASS_FROST` = `none` (`w-tint`, `w-tint-aa`), `composer`, `pills`, `menus`, `all`. `w-composer-fullres` = `composer` + `KYBERN_BACKDROP_HALFRES=0`.
  The runner clears every pinned variable before each launch.
- **Hardware:** MacBook Pro (M1), macOS 27.0.1, hidden virtual test display 1440×900 @2×, 60 Hz. **AC power** for the whole run (`pmset`: "Now drawing from 'AC Power'" in every row); gate 2 ran on battery.
- **Sessions (all windows ok, none discarded):** `main` (arms `w-tint`, `w-tint-aa`, `w-composer`, `w-pills`, `w-menus`, `w-all`; scenarios `streaming`, `thread-scroll`, `idle-thread`; 225 windows);
  `away` (`w-tint`, `w-tint-aa`, `w-pills`, `w-all`; `streaming-away`, 6 rounds after the two extra; 75 windows); `menu` (`w-tint`, `w-tint-aa`, `w-menus`, `w-all`; `streaming-menu`; 51 windows);
  `fullres` (`w-composer`, `w-composer-fullres`; `streaming`, `thread-scroll`; 54 windows). One throw-away warm-up pass (round 0), then 4 rounds, A B B A interleave, seeded scenario order
  (seeds 20261022 to 20261025), `--fresh` (re-seeded scratch dataset per launch), three 15 s windows per block after a 10 s warm-up (idle: 20 s). Raw rows: `perf/bench/results/gate3-2026-10-22.jsonl`.
- **New scenarios** (`perf/bench/scenarios.ts`): `streaming-away` (stream grows past a screen, then real wheel events scroll 800 px up from the tail: scroll pill and transcript edge fade on) and `streaming-menu` (model picker open for every window).
  `idle-thread` already existed.
- **Statistics, thresholds, rule:** as gate 2 (`gate2-report.ts`): block = arm × round × scenario (median of 3 windows, intervals summed), paired by round, 90% bootstrap CI over rounds, a metric fails only when the CI lower bound is above its limit,
  a pair is invalid when submission counts differ by more than 10%. Limits (§8.3): intervals > 33 ms +2 per 45 s; frame p95 +1.5 ms; GPUIX GPU ms per submitted frame **+30%** (`--limit gpuFrame=30`);
  CPU +5 points **and** +10% per frame; idle submissions and GPU ms 0; idle memory +15 MiB. WindowServer rows are reported, not gating. Unresolved cell: two more rounds, then keep only if the point estimate is at most half the limit.
- **A/A control:** `w-tint-aa − w-tint` fails no metric in any session (the session is valid). It is wide on the streaming intervals: +44.5 intervals per 45 s, CI −2 … 172, so streaming frame p95, intervals and WindowServer GPU are
  *uninformative* in `main` (the A/A already reaches the limit); they decided nothing. The GPU-per-frame ratio is tight (A/A −6% to +0.4%, CI inside ±14%), which is why it can decide.
- **N2 buys:** `w-composer-fullres − w-composer`: GPUIX GPU per frame **+28%** (CI 26 … 29) in streaming and +14% in thread-scroll for the full-resolution path, WindowServer GPU +4% and +14%; i.e. the half-resolution path is 22% cheaper per frame (3.38 vs 4.32 ms streaming; 3.74 vs 4.27 ms thread-scroll).
- No energy claim anywhere.

## Limitations

- **Not a quiet machine.** The user's own Kybern GPUIX app and other agent sessions were open; WindowServer (21% CPU) and its GPU counter cover every display. The streaming interval counts swing from 0 to 67 per 45 s between identical tint-only arms (`w-tint` 5.5, `w-tint-aa` 67),
  so only paired, A/A-referenced cells are used for the decision, and those that the A/A makes uninformative are listed as such.
- **`streaming-away` paints about a third as often** (≈ 300 submissions per 15 s against 900): the scene is mostly unchanged while the tail grows offscreen. Its frame metrics are submission gaps, not presents, and carry little information here; the GPU-per-frame ratio is per submitted frame.
- Frame p95 and intervals over 33 ms are scene-submission gaps, not WindowServer presents. The test display is a virtual display with a flat wallpaper: it shows the cost of the in-scene blur, not the real desktop blur behind the window.
- Dark theme only (light was not run: the blur kernel and the cost are the same).
- A relative GPU-per-frame limit on a 1 to 2.5 ms base is strict by construction; the absolute numbers are given above so the call can be revisited.

## Apparatus change found while building the gate

`gpui_apple` set the destination alpha factor of the quad and sprite pipelines to `One`, so stacked translucent fills added their alphas (a 0.9 coat under a 0.3 card read opaque). Round 1 never stacked two translucent fills. All
bench arms ran with the fix (`native/patches/alpha_blend_gpui.py`; `KYBERN_ADDITIVE_ALPHA=1` restores the old blend); the pixel checks (`src/platform/verify.glass.ts`) pass with it.

## Tables

Generated by `bun perf/bench/gate2-report.ts perf/bench/results/gate3-2026-10-22.jsonl --tag <tag> --limit gpuFrame=30 --pairs …`.

### `main` (`--pairs w-composer:w-tint,w-pills:w-tint,w-menus:w-tint,w-all:w-tint --aa w-tint-aa:w-tint`)

Windows: 225 (225 ok); warm-up round 0 excluded from every table.

#### Absolute values (median over rounds of block medians)

| Scenario | Arm | Frame p95 ms | Intervals > 33 ms per 45 s | GPUIX CPU points | GPUIX CPU ms/frame | GPUIX GPU ms/frame | WindowServer CPU points | WindowServer GPU ms | Submissions per 15 s window | GPUIX MiB | Idle CPU points | Idle MiB | Idle WindowServer GPU ms | Idle WindowServer CPU points |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| streaming | w-tint | 28.12 | 5.50 | 41.20 | 6.87 | 1.96 | 21.61 | 1979 | 901 | 250.50 |  |  |  |  |
| streaming | w-all | 25.37 | 3.50 | 43.20 | 7.20 | 3.35 | 21.17 | 1817 | 901 | 252.00 |  |  |  |  |
| streaming | w-menus | 28.09 | 32.00 | 41.15 | 6.86 | 1.97 | 21.61 | 1980 | 901 | 255.50 |  |  |  |  |
| streaming | w-composer | 29.50 | 3.00 | 41.61 | 6.94 | 3.35 | 21.73 | 2114 | 901 | 258.00 |  |  |  |  |
| streaming | w-tint-aa | 32.01 | 67.00 | 40.72 | 6.79 | 1.83 | 21.84 | 2297 | 901 | 257.00 |  |  |  |  |
| streaming | w-pills | 30.91 | 53.50 | 40.98 | 6.83 | 1.84 | 22.30 | 2302 | 901 | 258.50 |  |  |  |  |
| thread-scroll | w-tint | 17.33 | 0.00 | 42.89 | 7.15 | 1.81 | 14.96 | 2002 | 901 | 250.00 |  |  |  |  |
| thread-scroll | w-all | 17.27 | 0.00 | 42.83 | 7.13 | 3.80 | 17.86 | 1785 | 901 | 251.50 |  |  |  |  |
| thread-scroll | w-menus | 17.32 | 0.00 | 42.83 | 7.14 | 1.81 | 14.93 | 1996 | 902 | 249.00 |  |  |  |  |
| thread-scroll | w-composer | 17.29 | 0.00 | 42.75 | 7.13 | 3.69 | 17.72 | 1795 | 901 | 250.00 |  |  |  |  |
| thread-scroll | w-tint-aa | 17.16 | 0.00 | 42.96 | 7.16 | 1.81 | 15.00 | 2000 | 901 | 251.00 |  |  |  |  |
| thread-scroll | w-pills | 17.39 | 0.00 | 42.49 | 7.08 | 2.19 | 15.60 | 1989 | 901 | 250.00 |  |  |  |  |
| idle-thread | w-tint |  |  |  |  |  |  |  |  |  | 3.06 | 238.50 | 0 | 0.73 |
| idle-thread | w-all |  |  |  |  |  |  |  |  |  | 3.06 | 235.00 | 0 | 0.73 |
| idle-thread | w-menus |  |  |  |  |  |  |  |  |  | 2.96 | 239.00 | 0 | 0.73 |
| idle-thread | w-composer |  |  |  |  |  |  |  |  |  | 3.06 | 239.00 | 0 | 0.73 |
| idle-thread | w-tint-aa |  |  |  |  |  |  |  |  |  | 3.03 | 236.50 | 0 | 0.73 |
| idle-thread | w-pills |  |  |  |  |  |  |  |  |  | 3.09 | 234.00 | 0 | 0.70 |

Idle invariant (submissions and GPUIX GPU ms stay 0): 75/75 windows at 0.

#### w-composer − w-tint

Δ is the median of per-round paired differences, with a 90% bootstrap CI over rounds. Percent rows are relative to the base arm. A/A upper is the A/A CI upper bound for that metric.

| Scenario | Metric | Δ | 90% CI | Pairs (invalid) | Limit | A/A upper | Result |
|---|---|---:|---|---:|---:|---:|---|
| streaming | Frame p95 ms | -0.24 | -0.44 … 3.60 | 4 (0) | +1.5 | 8.13 | uninformative |
| streaming | Intervals > 33 ms per 45 s | -3.50 | -37.00 … 82.00 | 4 (0) | +2 | 172.00 | uninformative |
| streaming | GPUIX CPU points | 0.45 | -0.01 … 0.55 | 4 (0) | +5 | 0.31 | pass |
| streaming | GPUIX CPU ms / frame (%) | 1.13% | -0.02 … 1.43 | 4 (0) | +10% | 0.87 | pass |
| streaming | GPUIX GPU ms / frame (%) | 73.04% | 59.92 … 80.12 | 4 (0) | +30% | -0.01 | **FAIL** |
| streaming | WindowServer CPU points | 0.09 | -0.15 … 0.39 | 4 (0) | +4 | 0.87 | pass |
| streaming | WindowServer GPU ms (%) | 2.38% | -1.79 … 20.20 | 4 (0) | +20% | 41.97 | uninformative |
| streaming | Submissions per 15 s window (%) | 0.00% | 0.00 … 0.11 | 4 (0) | — | 0.00 | info |
| streaming | GPUIX GPU ms per window (%) | 73.04% | 60.10 … 80.12 | 4 (0) | — | -0.12 | info |
| streaming | GPUIX MiB | 6.00 | -1.00 … 12.00 | 4 (0) | — | 20.00 | info |
| thread-scroll | Frame p95 ms | -0.03 | -0.05 … -0.01 | 4 (0) | +1.5 | -0.00 | pass |
| thread-scroll | Intervals > 33 ms per 45 s | 0.00 | 0.00 … 0.00 | 4 (0) | +2 | 0.00 | pass |
| thread-scroll | GPUIX CPU points | 0.09 | -0.67 … 0.33 | 4 (0) | +5 | 3.53 | pass |
| thread-scroll | GPUIX CPU ms / frame (%) | 0.14% | -1.42 … 0.80 | 4 (0) | +10% | 7.40 | pass |
| thread-scroll | GPUIX GPU ms / frame (%) | 103.40% | 103.15 … 104.37 | 4 (0) | +30% | 3.69 | **FAIL** |
| thread-scroll | WindowServer CPU points | 2.63 | 1.73 … 3.79 | 4 (0) | +4 | 5.51 | uninformative |
| thread-scroll | WindowServer GPU ms (%) | -10.59% | -17.38 … -4.02 | 4 (0) | +20% | -0.03 | pass |
| thread-scroll | Submissions per 15 s window (%) | 0.00% | 0.00 … 0.11 | 4 (0) | — | 0.11 | info |
| thread-scroll | GPUIX GPU ms per window (%) | 103.51% | 103.12 … 104.37 | 4 (0) | — | 3.81 | info |
| thread-scroll | GPUIX MiB | 0.00 | -4.00 … 5.00 | 4 (0) | — | 3.00 | info |
| idle-thread | Idle CPU points | 0.00 | -0.13 … 0.00 | 4 (0) | +1.5 | 0.06 | pass |
| idle-thread | Idle MiB | 1.00 | 0.00 … 2.00 | 4 (0) | +15 | 1.50 | pass |
| idle-thread | Idle WindowServer GPU ms (%) | —% | — | 0 (0) | +20% | — | insufficient |
| idle-thread | Idle WindowServer CPU points | 0.00 | -0.07 … 0.00 | 4 (0) | — | 0.07 | info |

CPU rule (points AND per-frame must both fail): streaming: pass; thread-scroll: pass.
**w-composer vs w-tint: FAILS — streaming GPUIX GPU ms / frame (%); thread-scroll GPUIX GPU ms / frame (%).** 1 metrics have fewer than 3 valid pairs and are insufficient, not passed. Uninformative this session (A/A reaches the limit): streaming Frame p95 ms; streaming Intervals > 33 ms per 45 s; streaming WindowServer GPU ms (%); thread-scroll WindowServer CPU points.

#### w-pills − w-tint

Δ is the median of per-round paired differences, with a 90% bootstrap CI over rounds. Percent rows are relative to the base arm. A/A upper is the A/A CI upper bound for that metric.

| Scenario | Metric | Δ | 90% CI | Pairs (invalid) | Limit | A/A upper | Result |
|---|---|---:|---|---:|---:|---:|---|
| streaming | Frame p95 ms | 1.45 | 0.08 … 7.49 | 4 (0) | +1.5 | 8.13 | uninformative |
| streaming | Intervals > 33 ms per 45 s | 50.50 | 3.50 … 95.00 | 4 (0) | +2 | 172.00 | uninformative |
| streaming | GPUIX CPU points | -0.31 | -0.72 … 0.21 | 4 (0) | +5 | 0.31 | pass |
| streaming | GPUIX CPU ms / frame (%) | -0.69% | -1.64 … 0.54 | 4 (0) | +10% | 0.87 | pass |
| streaming | GPUIX GPU ms / frame (%) | -2.09% | -12.51 … 0.37 | 4 (0) | +30% | -0.01 | pass |
| streaming | WindowServer CPU points | 0.53 | 0.27 … 0.79 | 4 (0) | +4 | 0.87 | pass |
| streaming | WindowServer GPU ms (%) | 5.79% | -0.07 … 37.36 | 4 (0) | +20% | 41.97 | uninformative |
| streaming | Submissions per 15 s window (%) | 0.00% | -0.11 … 0.11 | 4 (0) | — | 0.00 | info |
| streaming | GPUIX GPU ms per window (%) | -2.04% | -12.51 … 0.26 | 4 (0) | — | -0.12 | info |
| streaming | GPUIX MiB | 8.00 | -7.00 … 15.00 | 4 (0) | — | 20.00 | info |
| thread-scroll | Frame p95 ms | 0.13 | -0.04 … 0.17 | 4 (0) | +1.5 | -0.00 | pass |
| thread-scroll | Intervals > 33 ms per 45 s | 0.00 | 0.00 … 0.00 | 4 (0) | +2 | 0.00 | pass |
| thread-scroll | GPUIX CPU points | -0.37 | -0.73 … 0.07 | 4 (0) | +5 | 3.53 | pass |
| thread-scroll | GPUIX CPU ms / frame (%) | -0.82% | -1.88 … 0.15 | 4 (0) | +10% | 7.40 | pass |
| thread-scroll | GPUIX GPU ms / frame (%) | 20.74% | 20.32 … 20.92 | 4 (0) | +30% | 3.69 | pass |
| thread-scroll | WindowServer CPU points | 0.50 | 0.00 … 1.13 | 4 (0) | +4 | 5.51 | uninformative |
| thread-scroll | WindowServer GPU ms (%) | -0.88% | -1.20 … -0.37 | 4 (0) | +20% | -0.03 | pass |
| thread-scroll | Submissions per 15 s window (%) | 0.00% | 0.00 … 0.00 | 4 (0) | — | 0.11 | info |
| thread-scroll | GPUIX GPU ms per window (%) | 20.69% | 20.33 … 20.92 | 4 (0) | — | 3.81 | info |
| thread-scroll | GPUIX MiB | 1.50 | -3.00 … 2.50 | 4 (0) | — | 3.00 | info |
| idle-thread | Idle CPU points | 0.03 | -0.01 … 0.13 | 4 (0) | +1.5 | 0.06 | pass |
| idle-thread | Idle MiB | -4.50 | -5.00 … -2.00 | 4 (0) | +15 | 1.50 | pass |
| idle-thread | Idle WindowServer GPU ms (%) | —% | — | 0 (0) | +20% | — | insufficient |
| idle-thread | Idle WindowServer CPU points | -0.03 | -0.07 … 0.07 | 4 (0) | — | 0.07 | info |

CPU rule (points AND per-frame must both fail): streaming: pass; thread-scroll: pass.
**w-pills vs w-tint: no metric fails.** 1 metrics have fewer than 3 valid pairs and are insufficient, not passed. Uninformative this session (A/A reaches the limit): streaming Frame p95 ms; streaming Intervals > 33 ms per 45 s; streaming WindowServer GPU ms (%); thread-scroll WindowServer CPU points.

#### w-menus − w-tint

Δ is the median of per-round paired differences, with a 90% bootstrap CI over rounds. Percent rows are relative to the base arm. A/A upper is the A/A CI upper bound for that metric.

| Scenario | Metric | Δ | 90% CI | Pairs (invalid) | Limit | A/A upper | Result |
|---|---|---:|---|---:|---:|---:|---|
| streaming | Frame p95 ms | -0.14 | -0.30 … 0.52 | 4 (0) | +1.5 | 8.13 | uninformative |
| streaming | Intervals > 33 ms per 45 s | 8.50 | -2.50 … 63.00 | 4 (0) | +2 | 172.00 | uninformative |
| streaming | GPUIX CPU points | -0.03 | -0.15 … 0.12 | 4 (0) | +5 | 0.31 | pass |
| streaming | GPUIX CPU ms / frame (%) | -0.08% | -0.27 … 0.27 | 4 (0) | +10% | 0.87 | pass |
| streaming | GPUIX GPU ms / frame (%) | 0.55% | -0.84 … 2.11 | 4 (0) | +30% | -0.01 | pass |
| streaming | WindowServer CPU points | 0.00 | -0.14 … 0.20 | 4 (0) | +4 | 0.87 | pass |
| streaming | WindowServer GPU ms (%) | -0.24% | -1.08 … 0.06 | 4 (0) | +20% | 41.97 | uninformative |
| streaming | Submissions per 15 s window (%) | 0.00% | -0.06 … 0.11 | 4 (0) | — | 0.00 | info |
| streaming | GPUIX GPU ms per window (%) | 0.57% | -0.84 … 2.11 | 4 (0) | — | -0.12 | info |
| streaming | GPUIX MiB | 4.00 | -1.00 … 5.00 | 4 (0) | — | 20.00 | info |
| thread-scroll | Frame p95 ms | -0.00 | -0.06 … 0.02 | 4 (0) | +1.5 | -0.00 | pass |
| thread-scroll | Intervals > 33 ms per 45 s | 0.00 | 0.00 … 0.00 | 4 (0) | +2 | 0.00 | pass |
| thread-scroll | GPUIX CPU points | -0.00 | -0.13 … 0.06 | 4 (0) | +5 | 3.53 | pass |
| thread-scroll | GPUIX CPU ms / frame (%) | -0.01% | -0.45 … 0.02 | 4 (0) | +10% | 7.40 | pass |
| thread-scroll | GPUIX GPU ms / frame (%) | 0.17% | -0.02 … 0.24 | 4 (0) | +30% | 3.69 | pass |
| thread-scroll | WindowServer CPU points | -0.07 | -0.17 … 0.13 | 4 (0) | +4 | 5.51 | uninformative |
| thread-scroll | WindowServer GPU ms (%) | -0.27% | -0.58 … -0.12 | 4 (0) | +20% | -0.03 | pass |
| thread-scroll | Submissions per 15 s window (%) | 0.06% | 0.00 … 0.11 | 4 (0) | — | 0.11 | info |
| thread-scroll | GPUIX GPU ms per window (%) | 0.18% | 0.02 … 0.34 | 4 (0) | — | 3.81 | info |
| thread-scroll | GPUIX MiB | 0.50 | -2.00 … 1.00 | 4 (0) | — | 3.00 | info |
| idle-thread | Idle CPU points | -0.17 | -0.27 … -0.07 | 4 (0) | +1.5 | 0.06 | pass |
| idle-thread | Idle MiB | 0.00 | -2.00 … 1.50 | 4 (0) | +15 | 1.50 | pass |
| idle-thread | Idle WindowServer GPU ms (%) | —% | — | 0 (0) | +20% | — | insufficient |
| idle-thread | Idle WindowServer CPU points | 0.00 | -0.07 … 0.07 | 4 (0) | — | 0.07 | info |

CPU rule (points AND per-frame must both fail): streaming: pass; thread-scroll: pass.
**w-menus vs w-tint: no metric fails.** 1 metrics have fewer than 3 valid pairs and are insufficient, not passed. Uninformative this session (A/A reaches the limit): streaming Frame p95 ms; streaming Intervals > 33 ms per 45 s; streaming WindowServer GPU ms (%); thread-scroll WindowServer CPU points.

#### w-all − w-tint

Δ is the median of per-round paired differences, with a 90% bootstrap CI over rounds. Percent rows are relative to the base arm. A/A upper is the A/A CI upper bound for that metric.

| Scenario | Metric | Δ | 90% CI | Pairs (invalid) | Limit | A/A upper | Result |
|---|---|---:|---|---:|---:|---:|---|
| streaming | Frame p95 ms | -0.31 | -5.49 … -0.02 | 4 (0) | +1.5 | 8.13 | uninformative |
| streaming | Intervals > 33 ms per 45 s | 0.00 | -41.00 … 3.00 | 4 (0) | +2 | 172.00 | uninformative |
| streaming | GPUIX CPU points | -0.21 | -0.82 … 5.66 | 4 (0) | +5 | 0.31 | unresolved |
| streaming | GPUIX CPU ms / frame (%) | -0.48% | -1.80 … 14.78 | 4 (0) | +10% | 0.87 | unresolved |
| streaming | GPUIX GPU ms / frame (%) | 71.05% | 59.41 … 82.04 | 4 (0) | +30% | -0.01 | **FAIL** |
| streaming | WindowServer CPU points | -0.25 | -0.72 … 0.09 | 4 (0) | +4 | 0.87 | pass |
| streaming | WindowServer GPU ms (%) | 5.11% | -21.98 … 10.13 | 4 (0) | +20% | 41.97 | uninformative |
| streaming | Submissions per 15 s window (%) | 0.00% | 0.00 … 0.00 | 4 (0) | — | 0.00 | info |
| streaming | GPUIX GPU ms per window (%) | 71.05% | 59.59 … 82.04 | 4 (0) | — | -0.12 | info |
| streaming | GPUIX MiB | 5.00 | -8.00 … 7.50 | 4 (0) | — | 20.00 | info |
| thread-scroll | Frame p95 ms | -0.05 | -0.07 … -0.01 | 4 (0) | +1.5 | -0.00 | pass |
| thread-scroll | Intervals > 33 ms per 45 s | 0.00 | 0.00 … 0.00 | 4 (0) | +2 | 0.00 | pass |
| thread-scroll | GPUIX CPU points | 0.00 | -0.53 … 0.23 | 4 (0) | +5 | 3.53 | pass |
| thread-scroll | GPUIX CPU ms / frame (%) | -0.06% | -1.24 … 0.60 | 4 (0) | +10% | 7.40 | pass |
| thread-scroll | GPUIX GPU ms / frame (%) | 110.16% | 108.53 … 110.70 | 4 (0) | +30% | 3.69 | **FAIL** |
| thread-scroll | WindowServer CPU points | 2.92 | 2.03 … 3.79 | 4 (0) | +4 | 5.51 | uninformative |
| thread-scroll | WindowServer GPU ms (%) | -10.96% | -17.33 … -5.09 | 4 (0) | +20% | -0.03 | pass |
| thread-scroll | Submissions per 15 s window (%) | 0.00% | 0.00 … 0.11 | 4 (0) | — | 0.11 | info |
| thread-scroll | GPUIX GPU ms per window (%) | 110.19% | 108.53 … 110.60 | 4 (0) | — | 3.81 | info |
| thread-scroll | GPUIX MiB | 1.50 | 1.00 … 4.00 | 4 (0) | — | 3.00 | info |
| idle-thread | Idle CPU points | 0.00 | -0.20 … 0.03 | 4 (0) | +1.5 | 0.06 | pass |
| idle-thread | Idle MiB | -3.00 | -4.00 … -2.00 | 4 (0) | +15 | 1.50 | pass |
| idle-thread | Idle WindowServer GPU ms (%) | —% | — | 0 (0) | +20% | — | insufficient |
| idle-thread | Idle WindowServer CPU points | 0.00 | -0.07 … 0.07 | 4 (0) | — | 0.07 | info |

CPU rule (points AND per-frame must both fail): streaming: unresolved; thread-scroll: pass.
**w-all vs w-tint: FAILS — streaming GPUIX GPU ms / frame (%); thread-scroll GPUIX GPU ms / frame (%).** 1 metrics have fewer than 3 valid pairs and are insufficient, not passed. Uninformative this session (A/A reaches the limit): streaming Frame p95 ms; streaming Intervals > 33 ms per 45 s; streaming WindowServer GPU ms (%); thread-scroll WindowServer CPU points.

#### w-tint-aa − w-tint (A/A control: the same mode twice)

Δ is the median of per-round paired differences, with a 90% bootstrap CI over rounds. Percent rows are relative to the base arm. A/A upper is the A/A CI upper bound for that metric.

| Scenario | Metric | Δ | 90% CI | Pairs (invalid) | Limit | A/A upper | Result |
|---|---|---:|---|---:|---:|---:|---|
| streaming | Frame p95 ms | 3.89 | -0.22 … 8.13 | 4 (0) | +1.5 | — | unresolved |
| streaming | Intervals > 33 ms per 45 s | 44.50 | -2.00 … 172.00 | 4 (0) | +2 | — | unresolved |
| streaming | GPUIX CPU points | -0.43 | -1.46 … 0.23 | 4 (0) | +5 | — | pass |
| streaming | GPUIX CPU ms / frame (%) | -0.85% | -3.32 … 0.67 | 4 (0) | +10% | — | pass |
| streaming | GPUIX GPU ms / frame (%) | -6.28% | -13.37 … -0.19 | 4 (0) | +30% | — | pass |
| streaming | WindowServer CPU points | 0.13 | -0.26 … 0.87 | 4 (0) | +4 | — | pass |
| streaming | WindowServer GPU ms (%) | 18.98% | -2.01 … 41.97 | 4 (0) | +20% | — | unresolved |
| streaming | Submissions per 15 s window (%) | 0.00% | -0.11 … 0.00 | 4 (0) | — | — | info |
| streaming | GPUIX GPU ms per window (%) | -6.30% | -13.37 … -0.25 | 4 (0) | — | — | info |
| streaming | GPUIX MiB | 7.50 | -8.00 … 20.00 | 4 (0) | — | — | info |
| thread-scroll | Frame p95 ms | -0.02 | -0.57 … -0.00 | 4 (0) | +1.5 | — | pass |
| thread-scroll | Intervals > 33 ms per 45 s | 0.00 | 0.00 … 0.00 | 4 (0) | +2 | — | pass |
| thread-scroll | GPUIX CPU points | 0.10 | -0.13 … 3.53 | 4 (0) | +5 | — | pass |
| thread-scroll | GPUIX CPU ms / frame (%) | 0.20% | -0.33 … 7.40 | 4 (0) | +10% | — | pass |
| thread-scroll | GPUIX GPU ms / frame (%) | 0.08% | -0.12 … 3.69 | 4 (0) | +30% | — | pass |
| thread-scroll | WindowServer CPU points | 0.06 | -0.03 … 5.51 | 4 (0) | +4 | — | unresolved |
| thread-scroll | WindowServer GPU ms (%) | -0.22% | -17.75 … -0.03 | 4 (0) | +20% | — | pass |
| thread-scroll | Submissions per 15 s window (%) | 0.00% | 0.00 … 0.11 | 4 (0) | — | — | info |
| thread-scroll | GPUIX GPU ms per window (%) | 0.08% | -0.13 … 3.81 | 4 (0) | — | — | info |
| thread-scroll | GPUIX MiB | 1.50 | -1.00 … 3.00 | 4 (0) | — | — | info |
| idle-thread | Idle CPU points | -0.10 | -0.20 … 0.06 | 4 (0) | +1.5 | — | pass |
| idle-thread | Idle MiB | -2.00 | -6.00 … 2.00 | 4 (0) | +15 | — | pass |
| idle-thread | Idle WindowServer GPU ms (%) | —% | — | 0 (0) | +20% | — | insufficient |
| idle-thread | Idle WindowServer CPU points | 0.00 | -0.07 … 0.07 | 4 (0) | — | — | info |

CPU rule (points AND per-frame must both fail): streaming: pass; thread-scroll: pass.
**w-tint-aa vs w-tint: no metric fails.** 1 metrics have fewer than 3 valid pairs and are insufficient, not passed.



### `away` (6 rounds; `--pairs w-pills:w-tint,w-all:w-tint --aa w-tint-aa:w-tint`)

Windows: 75 (75 ok); warm-up round 0 excluded from every table.

#### Absolute values (median over rounds of block medians)

| Scenario | Arm | Frame p95 ms | Intervals > 33 ms per 45 s | GPUIX CPU points | GPUIX CPU ms/frame | GPUIX GPU ms/frame | WindowServer CPU points | WindowServer GPU ms | Submissions per 15 s window | GPUIX MiB | Idle CPU points | Idle MiB | Idle WindowServer GPU ms | Idle WindowServer CPU points |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| streaming-away | w-tint | 70.10 | 624.00 | 40.32 | 19.95 | 1.28 | 21.50 | 2154 | 303 | 249.50 |  |  |  |  |
| streaming-away | w-all | 70.17 | 623.00 | 40.22 | 19.81 | 3.12 | 21.27 | 2149 | 310 | 251.00 |  |  |  |  |
| streaming-away | w-tint-aa | 70.07 | 626.00 | 40.10 | 20.22 | 1.30 | 21.74 | 2144 | 298 | 248.50 |  |  |  |  |
| streaming-away | w-pills | 70.30 | 625.00 | 39.95 | 19.91 | 1.63 | 21.44 | 2145 | 304 | 252.50 |  |  |  |  |

Idle invariant (submissions and GPUIX GPU ms stay 0): 0/0 windows at 0.

#### w-pills − w-tint

Δ is the median of per-round paired differences, with a 90% bootstrap CI over rounds. Percent rows are relative to the base arm. A/A upper is the A/A CI upper bound for that metric.

| Scenario | Metric | Δ | 90% CI | Pairs (invalid) | Limit | A/A upper | Result |
|---|---|---:|---|---:|---:|---:|---|
| streaming-away | Frame p95 ms | 0.18 | -0.09 … 0.30 | 6 (0) | +1.5 | 0.05 | pass |
| streaming-away | Intervals > 33 ms per 45 s | 1.00 | -8.00 … 17.50 | 6 (0) | +2 | 8.00 | uninformative |
| streaming-away | GPUIX CPU points | -0.45 | -0.86 … 0.45 | 6 (0) | +5 | 0.24 | pass |
| streaming-away | GPUIX CPU ms / frame (%) | -0.75% | -4.65 … 6.87 | 6 (0) | +10% | 5.09 | pass |
| streaming-away | GPUIX GPU ms / frame (%) | 27.20% | 23.45 … 31.71 | 6 (0) | +30% | 2.87 | unresolved |
| streaming-away | WindowServer CPU points | -0.17 | -0.28 … 0.09 | 6 (0) | +4 | 0.39 | pass |
| streaming-away | WindowServer GPU ms (%) | -0.46% | -0.77 … -0.34 | 6 (0) | +20% | -0.10 | pass |
| streaming-away | Submissions per 15 s window (%) | -0.33% | -3.70 … 2.91 | 6 (0) | — | 1.99 | info |
| streaming-away | GPUIX GPU ms per window (%) | 25.90% | 24.82 … 29.31 | 6 (0) | — | 0.92 | info |
| streaming-away | GPUIX MiB | 3.00 | -2.50 … 5.50 | 6 (0) | — | 1.00 | info |

CPU rule (points AND per-frame must both fail): streaming-away: pass.
**w-pills vs w-tint: no metric fails.** Uninformative this session (A/A reaches the limit): streaming-away Intervals > 33 ms per 45 s.

#### w-all − w-tint

Δ is the median of per-round paired differences, with a 90% bootstrap CI over rounds. Percent rows are relative to the base arm. A/A upper is the A/A CI upper bound for that metric.

| Scenario | Metric | Δ | 90% CI | Pairs (invalid) | Limit | A/A upper | Result |
|---|---|---:|---|---:|---:|---:|---|
| streaming-away | Frame p95 ms | -0.02 | -0.20 … 0.36 | 6 (0) | +1.5 | 0.05 | pass |
| streaming-away | Intervals > 33 ms per 45 s | 2.00 | -7.00 … 3.50 | 6 (0) | +2 | 8.00 | uninformative |
| streaming-away | GPUIX CPU points | 0.07 | -0.11 … 0.61 | 6 (0) | +5 | 0.24 | pass |
| streaming-away | GPUIX CPU ms / frame (%) | 0.31% | -4.18 … 5.34 | 6 (0) | +10% | 5.09 | pass |
| streaming-away | GPUIX GPU ms / frame (%) | 145.47% | 140.45 … 150.43 | 6 (0) | +30% | 2.87 | **FAIL** |
| streaming-away | WindowServer CPU points | -0.26 | -0.43 … 0.06 | 6 (0) | +4 | 0.39 | pass |
| streaming-away | WindowServer GPU ms (%) | -0.04% | -0.47 … 0.30 | 6 (0) | +20% | -0.10 | pass |
| streaming-away | Submissions per 15 s window (%) | 0.83% | -3.51 … 4.95 | 6 (0) | — | 1.99 | info |
| streaming-away | GPUIX GPU ms per window (%) | 147.69% | 141.63 … 156.72 | 6 (0) | — | 0.92 | info |
| streaming-away | GPUIX MiB | 1.00 | -2.00 … 6.00 | 6 (0) | — | 1.00 | info |

CPU rule (points AND per-frame must both fail): streaming-away: pass.
**w-all vs w-tint: FAILS — streaming-away GPUIX GPU ms / frame (%).** Uninformative this session (A/A reaches the limit): streaming-away Intervals > 33 ms per 45 s.

#### w-tint-aa − w-tint (A/A control: the same mode twice)

Δ is the median of per-round paired differences, with a 90% bootstrap CI over rounds. Percent rows are relative to the base arm. A/A upper is the A/A CI upper bound for that metric.

| Scenario | Metric | Δ | 90% CI | Pairs (invalid) | Limit | A/A upper | Result |
|---|---|---:|---|---:|---:|---:|---|
| streaming-away | Frame p95 ms | -0.01 | -0.44 … 0.05 | 6 (0) | +1.5 | — | pass |
| streaming-away | Intervals > 33 ms per 45 s | -2.00 | -5.00 … 9.00 | 6 (0) | +2 | — | unresolved |
| streaming-away | GPUIX CPU points | -0.27 | -0.70 … 0.24 | 6 (0) | +5 | — | pass |
| streaming-away | GPUIX CPU ms / frame (%) | 0.60% | -3.15 … 6.05 | 6 (0) | +10% | — | pass |
| streaming-away | GPUIX GPU ms / frame (%) | 0.44% | -1.38 … 2.87 | 6 (0) | +30% | — | pass |
| streaming-away | WindowServer CPU points | -0.10 | -0.23 … 0.39 | 6 (0) | +4 | — | pass |
| streaming-away | WindowServer GPU ms (%) | -0.33% | -0.53 … -0.10 | 6 (0) | +20% | — | pass |
| streaming-away | Submissions per 15 s window (%) | -1.16% | -4.51 … 0.83 | 6 (0) | — | — | info |
| streaming-away | GPUIX GPU ms per window (%) | -0.32% | -1.31 … 0.92 | 6 (0) | — | — | info |
| streaming-away | GPUIX MiB | -1.00 | -5.00 … 1.00 | 6 (0) | — | — | info |

CPU rule (points AND per-frame must both fail): streaming-away: pass.
**w-tint-aa vs w-tint: no metric fails.**



### `menu` (`--pairs w-menus:w-tint,w-all:w-tint --aa w-tint-aa:w-tint`)

Windows: 51 (51 ok); warm-up round 0 excluded from every table.

#### Absolute values (median over rounds of block medians)

| Scenario | Arm | Frame p95 ms | Intervals > 33 ms per 45 s | GPUIX CPU points | GPUIX CPU ms/frame | GPUIX GPU ms/frame | WindowServer CPU points | WindowServer GPU ms | Submissions per 15 s window | GPUIX MiB | Idle CPU points | Idle MiB | Idle WindowServer GPU ms | Idle WindowServer CPU points |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| streaming-menu | w-tint | 27.71 | 0.50 | 42.16 | 7.03 | 2.51 | 20.21 | 1553 | 901 | 263.00 |  |  |  |  |
| streaming-menu | w-menus | 27.42 | 0.00 | 42.46 | 7.09 | 4.79 | 20.11 | 1672 | 901 | 266.50 |  |  |  |  |
| streaming-menu | w-all | 27.71 | 0.00 | 43.09 | 7.18 | 6.04 | 20.05 | 1615 | 901 | 271.00 |  |  |  |  |
| streaming-menu | w-tint-aa | 27.53 | 0.00 | 41.93 | 6.99 | 2.45 | 20.41 | 1567 | 901 | 263.50 |  |  |  |  |

Idle invariant (submissions and GPUIX GPU ms stay 0): 0/0 windows at 0.

#### w-menus − w-tint

Δ is the median of per-round paired differences, with a 90% bootstrap CI over rounds. Percent rows are relative to the base arm. A/A upper is the A/A CI upper bound for that metric.

| Scenario | Metric | Δ | 90% CI | Pairs (invalid) | Limit | A/A upper | Result |
|---|---|---:|---|---:|---:|---:|---|
| streaming-menu | Frame p95 ms | -0.37 | -3.00 … 0.17 | 4 (0) | +1.5 | 0.09 | pass |
| streaming-menu | Intervals > 33 ms per 45 s | -0.50 | -45.50 … 0.00 | 4 (0) | +2 | 0.00 | pass |
| streaming-menu | GPUIX CPU points | 0.47 | 0.01 … 0.74 | 4 (0) | +5 | 0.54 | pass |
| streaming-menu | GPUIX CPU ms / frame (%) | 1.12% | 0.13 … 1.87 | 4 (0) | +10% | 1.18 | pass |
| streaming-menu | GPUIX GPU ms / frame (%) | 91.05% | 89.40 … 100.02 | 4 (0) | +30% | 1.30 | **FAIL** |
| streaming-menu | WindowServer CPU points | -0.26 | -0.53 … 0.10 | 4 (0) | +4 | 3.46 | pass |
| streaming-menu | WindowServer GPU ms (%) | 7.62% | -1.43 … 11.05 | 4 (0) | +20% | 2.78 | pass |
| streaming-menu | Submissions per 15 s window (%) | -0.06% | -0.11 … 0.00 | 4 (0) | — | 0.00 | info |
| streaming-menu | GPUIX GPU ms per window (%) | 91.16% | 89.19 … 100.12 | 4 (0) | — | 1.42 | info |
| streaming-menu | GPUIX MiB | 3.50 | -2.00 … 12.00 | 4 (0) | — | 8.00 | info |

CPU rule (points AND per-frame must both fail): streaming-menu: pass.
**w-menus vs w-tint: FAILS — streaming-menu GPUIX GPU ms / frame (%).**

#### w-all − w-tint

Δ is the median of per-round paired differences, with a 90% bootstrap CI over rounds. Percent rows are relative to the base arm. A/A upper is the A/A CI upper bound for that metric.

| Scenario | Metric | Δ | 90% CI | Pairs (invalid) | Limit | A/A upper | Result |
|---|---|---:|---|---:|---:|---:|---|
| streaming-menu | Frame p95 ms | -0.08 | -2.62 … 0.38 | 4 (0) | +1.5 | 0.09 | pass |
| streaming-menu | Intervals > 33 ms per 45 s | -0.50 | -46.50 … 0.00 | 4 (0) | +2 | 0.00 | pass |
| streaming-menu | GPUIX CPU points | 1.04 | 0.74 … 1.27 | 4 (0) | +5 | 0.54 | pass |
| streaming-menu | GPUIX CPU ms / frame (%) | 2.51% | 1.75 … 3.09 | 4 (0) | +10% | 1.18 | pass |
| streaming-menu | GPUIX GPU ms / frame (%) | 140.39% | 138.66 … 152.66 | 4 (0) | +30% | 1.30 | **FAIL** |
| streaming-menu | WindowServer CPU points | -0.16 | -0.27 … 0.07 | 4 (0) | +4 | 3.46 | pass |
| streaming-menu | WindowServer GPU ms (%) | 4.22% | -4.29 … 7.06 | 4 (0) | +20% | 2.78 | pass |
| streaming-menu | Submissions per 15 s window (%) | 0.00% | 0.00 … 0.00 | 4 (0) | — | 0.00 | info |
| streaming-menu | GPUIX GPU ms per window (%) | 140.66% | 138.66 … 152.94 | 4 (0) | — | 1.42 | info |
| streaming-menu | GPUIX MiB | 9.50 | 5.00 … 10.00 | 4 (0) | — | 8.00 | info |

CPU rule (points AND per-frame must both fail): streaming-menu: pass.
**w-all vs w-tint: FAILS — streaming-menu GPUIX GPU ms / frame (%).**

#### w-tint-aa − w-tint (A/A control: the same mode twice)

Δ is the median of per-round paired differences, with a 90% bootstrap CI over rounds. Percent rows are relative to the base arm. A/A upper is the A/A CI upper bound for that metric.

| Scenario | Metric | Δ | 90% CI | Pairs (invalid) | Limit | A/A upper | Result |
|---|---|---:|---|---:|---:|---:|---|
| streaming-menu | Frame p95 ms | -0.39 | -2.93 … 0.09 | 4 (0) | +1.5 | — | pass |
| streaming-menu | Intervals > 33 ms per 45 s | -0.50 | -46.50 … 0.00 | 4 (0) | +2 | — | pass |
| streaming-menu | GPUIX CPU points | -0.20 | -0.92 … 0.36 | 4 (0) | +5 | — | pass |
| streaming-menu | GPUIX CPU ms / frame (%) | -0.42% | -2.17 … 0.87 | 4 (0) | +10% | — | pass |
| streaming-menu | GPUIX GPU ms / frame (%) | -2.22% | -3.32 … 1.30 | 4 (0) | +30% | — | pass |
| streaming-menu | WindowServer CPU points | 0.21 | -0.40 … 1.90 | 4 (0) | +4 | — | pass |
| streaming-menu | WindowServer GPU ms (%) | -0.76% | -4.96 … 5.23 | 4 (0) | +20% | — | pass |
| streaming-menu | Submissions per 15 s window (%) | 0.00% | 0.00 … 0.00 | 4 (0) | — | — | info |
| streaming-menu | GPUIX GPU ms per window (%) | -2.17% | -3.21 … 1.42 | 4 (0) | — | — | info |
| streaming-menu | GPUIX MiB | -2.50 | -6.00 … 8.00 | 4 (0) | — | — | info |

CPU rule (points AND per-frame must both fail): streaming-menu: pass.
**w-tint-aa vs w-tint: no metric fails.**



### `fullres` (`--pairs w-composer-fullres:w-composer`; the trailing `solid-aa` block is the report default and has no data)

Windows: 54 (54 ok); warm-up round 0 excluded from every table.

#### Absolute values (median over rounds of block medians)

| Scenario | Arm | Frame p95 ms | Intervals > 33 ms per 45 s | GPUIX CPU points | GPUIX CPU ms/frame | GPUIX GPU ms/frame | WindowServer CPU points | WindowServer GPU ms | Submissions per 15 s window | GPUIX MiB | Idle CPU points | Idle MiB | Idle WindowServer GPU ms | Idle WindowServer CPU points |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| streaming | w-composer | 25.59 | 22.00 | 44.08 | 7.36 | 3.38 | 21.54 | 1820 | 901 | 250.00 |  |  |  |  |
| streaming | w-composer-fullres | 25.40 | 0.00 | 44.28 | 7.38 | 4.32 | 21.57 | 1890 | 901 | 254.00 |  |  |  |  |
| thread-scroll | w-composer | 17.48 | 0.00 | 46.78 | 7.79 | 3.74 | 19.62 | 1654 | 902 | 252.00 |  |  |  |  |
| thread-scroll | w-composer-fullres | 17.47 | 0.00 | 46.84 | 7.80 | 4.27 | 20.15 | 1891 | 902 | 253.00 |  |  |  |  |

Idle invariant (submissions and GPUIX GPU ms stay 0): 0/0 windows at 0.

#### w-composer-fullres − w-composer

Δ is the median of per-round paired differences, with a 90% bootstrap CI over rounds. Percent rows are relative to the base arm. A/A upper is the A/A CI upper bound for that metric.

| Scenario | Metric | Δ | 90% CI | Pairs (invalid) | Limit | A/A upper | Result |
|---|---|---:|---|---:|---:|---:|---|
| streaming | Frame p95 ms | -0.25 | -1.59 … -0.03 | 4 (0) | +1.5 | — | pass |
| streaming | Intervals > 33 ms per 45 s | -22.00 | -70.00 … 0.00 | 4 (0) | +2 | — | pass |
| streaming | GPUIX CPU points | 0.11 | 0.01 … 0.63 | 4 (0) | +5 | — | pass |
| streaming | GPUIX CPU ms / frame (%) | 0.18% | -0.09 … 1.45 | 4 (0) | +10% | — | pass |
| streaming | GPUIX GPU ms / frame (%) | 27.97% | 26.20 … 28.54 | 4 (0) | +30% | — | pass |
| streaming | WindowServer CPU points | 0.10 | -0.13 … 0.14 | 4 (0) | +4 | — | pass |
| streaming | WindowServer GPU ms (%) | 3.88% | 0.08 … 5.98 | 4 (0) | +20% | — | pass |
| streaming | Submissions per 15 s window (%) | 0.00% | 0.00 … 0.11 | 4 (0) | — | — | info |
| streaming | GPUIX GPU ms per window (%) | 27.90% | 26.34 … 28.54 | 4 (0) | — | — | info |
| streaming | GPUIX MiB | 3.50 | -4.00 … 11.00 | 4 (0) | — | — | info |
| thread-scroll | Frame p95 ms | 0.00 | -0.01 … 0.00 | 4 (0) | +1.5 | — | pass |
| thread-scroll | Intervals > 33 ms per 45 s | 0.00 | 0.00 … 0.00 | 4 (0) | +2 | — | pass |
| thread-scroll | GPUIX CPU points | 0.19 | -0.27 … 0.53 | 4 (0) | +5 | — | pass |
| thread-scroll | GPUIX CPU ms / frame (%) | 0.41% | -0.68 … 1.15 | 4 (0) | +10% | — | pass |
| thread-scroll | GPUIX GPU ms / frame (%) | 14.48% | 12.76 … 14.60 | 4 (0) | +30% | — | pass |
| thread-scroll | WindowServer CPU points | 0.57 | 0.43 … 0.86 | 4 (0) | +4 | — | pass |
| thread-scroll | WindowServer GPU ms (%) | 13.86% | 11.76 … 17.13 | 4 (0) | +20% | — | pass |
| thread-scroll | Submissions per 15 s window (%) | 0.00% | 0.00 … 0.11 | 4 (0) | — | — | info |
| thread-scroll | GPUIX GPU ms per window (%) | 14.54% | 12.76 … 14.73 | 4 (0) | — | — | info |
| thread-scroll | GPUIX MiB | 2.00 | 1.00 … 5.00 | 4 (0) | — | — | info |

CPU rule (points AND per-frame must both fail): streaming: pass; thread-scroll: pass.
**w-composer-fullres vs w-composer: no metric fails.**

#### solid-aa − solid (A/A control: the same mode twice)

Δ is the median of per-round paired differences, with a 90% bootstrap CI over rounds. Percent rows are relative to the base arm. A/A upper is the A/A CI upper bound for that metric.

| Scenario | Metric | Δ | 90% CI | Pairs (invalid) | Limit | A/A upper | Result |
|---|---|---:|---|---:|---:|---:|---|
| streaming | Frame p95 ms | — | — | 0 (0) | +1.5 | — | insufficient |
| streaming | Intervals > 33 ms per 45 s | — | — | 0 (0) | +2 | — | insufficient |
| streaming | GPUIX CPU points | — | — | 0 (0) | +5 | — | insufficient |
| streaming | GPUIX CPU ms / frame (%) | —% | — | 0 (0) | +10% | — | insufficient |
| streaming | GPUIX GPU ms / frame (%) | —% | — | 0 (0) | +30% | — | insufficient |
| streaming | WindowServer CPU points | — | — | 0 (0) | +4 | — | insufficient |
| streaming | WindowServer GPU ms (%) | —% | — | 0 (0) | +20% | — | insufficient |
| streaming | Submissions per 15 s window (%) | —% | — | 0 (0) | — | — | info |
| streaming | GPUIX GPU ms per window (%) | —% | — | 0 (0) | — | — | info |
| streaming | GPUIX MiB | — | — | 0 (0) | — | — | info |
| thread-scroll | Frame p95 ms | — | — | 0 (0) | +1.5 | — | insufficient |
| thread-scroll | Intervals > 33 ms per 45 s | — | — | 0 (0) | +2 | — | insufficient |
| thread-scroll | GPUIX CPU points | — | — | 0 (0) | +5 | — | insufficient |
| thread-scroll | GPUIX CPU ms / frame (%) | —% | — | 0 (0) | +10% | — | insufficient |
| thread-scroll | GPUIX GPU ms / frame (%) | —% | — | 0 (0) | +30% | — | insufficient |
| thread-scroll | WindowServer CPU points | — | — | 0 (0) | +4 | — | insufficient |
| thread-scroll | WindowServer GPU ms (%) | —% | — | 0 (0) | +20% | — | insufficient |
| thread-scroll | Submissions per 15 s window (%) | —% | — | 0 (0) | — | — | info |
| thread-scroll | GPUIX GPU ms per window (%) | —% | — | 0 (0) | — | — | info |
| thread-scroll | GPUIX MiB | — | — | 0 (0) | — | — | info |

CPU rule (points AND per-frame must both fail): streaming: insufficient; thread-scroll: insufficient.
**solid-aa vs solid: no metric fails.** 14 metrics have fewer than 3 valid pairs and are insufficient, not passed.


