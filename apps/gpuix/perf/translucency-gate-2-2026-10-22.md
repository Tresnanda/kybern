# Window translucency perf gate, round 2 (ADE-47, 2026-10-22)

Decides `DEFAULT_SIDEBAR_ONLY` in `src/platform/translucency.ts`, using the cleaner procedure from `perf/translucency-zeron-research.md` §5.
The first gate (`perf/translucency-2026-10.md`) was inconclusive because its base-vs-base control failed.

**Decision: whole-window glass fails again, so `DEFAULT_SIDEBAR_ONLY` stays `true` (no change to the default).** This time the A/A control passed.
`window` fails against both `solid` and `sidebar` on streaming intervals over 33 ms, and against `solid` on WindowServer GPU time.
The single-fill flag and `auto` blur are reported below; neither changes the decision.

## Workload and apparatus

- **One build, modes by environment pin only.** Branch HEAD `6d8209736`, patched addon
  `/Applications/Kybern GPUIX.app/Contents/Resources/gpuix-native.darwin-arm64.node`, SHA-256
  `5d12b1815ad57597396f68a1d928d9e79d634abeb244ffaba9f8e8f2f3fe9040`, bun 1.4.0, scratch kybernd from `/Applications/kybern.app`.
  Every arm pins `KYBERN_WINDOW_MATERIAL`, `KYBERN_WINDOW_OPACITY=90` and `KYBERN_WINDOW_BLUR=64` (`auto` for `window-auto`), dark theme
  (`KYBERN_APPEARANCE` is `light` only for the light check), `KYBERN_FULL_RATE=1`, `KYBERN_BENCH_WINDOWSERVER=1`.
  The runner clears every pinned variable before each launch, so arms cannot leak into each other.
- **Hardware:** MacBook Pro (MacBookPro17,1), Apple M1, 16 GB, macOS 27.0.1, hidden virtual test display 1440×900 @2×, 60 Hz.
- **Scenarios:** `streaming`, `thread-scroll`, `sidebar-scroll` (10 s warm-up, three 15 s windows each) and `idle-home` (20 s warm-up,
  `KYBERN_BENCH_PERSISTED_IDLE=1`). Same workload as `perf/bench/README.md`.
- **Primary session (`tag=primary`):** arms `window` (whole window glass, blur 64), `sidebar` (Sidebar only, blur 64), `solid`, and `solid-aa`
  (a second copy of `solid`, the A/A control). One throw-away warm-up pass (round 0, `solid`, discarded), then 4 rounds. Each round runs
  every arm once; odd rounds use a seeded shuffle of the arm order and even rounds reverse the previous round (A B B A). Scenario order inside
  every pass is a fresh seeded shuffle (seed 20261022, in `results/gate2-2026-10-22.jsonl` and `gate2.ts --seed`).
  17 passes × 4 scenarios × 3 windows = 204 windows, all `ok`, none discarded, no retry, no thermal wait. 99 minutes.
- **Secondary session (`tag=secondary`):** `solid`, `sidebar`, `sidebar-sf` and `solid-sf` (`KYBERN_TRANSLUCENCY_SINGLE_FILL=1`), and `window-auto`
  (blur Auto), `streaming` + `thread-scroll`, 3 rounds + warm-up, same interleaving (seeds 20261023 for thread-scroll, 20261024 for streaming).
  There is no A/A arm in this session, so its "pass" cells carry no noise reference; use the primary A/A for scale.
- **Light check (`tag=light`):** `window-light` vs `solid-light`, `streaming` only, 3 rounds.
- **Statistics:** the unit is the block (arm × round × scenario = 3 windows; the median of its windows, the >33 ms count is their sum, i.e. per 45 s).
  Deltas are paired by round and scenario. The estimate is the median of the paired deltas, with a 90% percentile bootstrap CI over rounds
  (10,000 resamples, seeded; windows are never the resampling unit). A metric **fails** only when the CI lower bound exceeds its limit; it is
  **uninformative** when the A/A CI upper bound already exceeds the limit; **unresolved** means the estimate or CI straddles the limit; with
  fewer than 3 valid pairs it is **insufficient**. A pair is invalid when the two arms' submission counts differ by more than 10%.
  CPU fails only when both the points rule (+5) and the per-frame rule (+10% CPU ms per submitted frame) fail.
- **Thresholds (from the research doc):** frame p95 +1.5 ms; intervals > 33 ms +2 per 45 s; CPU +5 points or +10% per frame; GPUIX GPU +15%
  (per submitted frame); WindowServer CPU +4 points; WindowServer GPU +20%; idle CPU +1.5 points; idle memory +15 MiB; idle submissions and
  GPU ms must stay 0.
- WindowServer CPU is `ps` time; its GPU time is the AGX per-PID counter and counts every window on every display, not only the test display.
  No energy claim anywhere.

## Deviations from the procedure

- **Battery power, not AC.** The Mac was discharging the whole time (76% → 50% over the primary session; Low Power Mode off, no thermal
  warning recorded by `pmset -g therm` before any pass). I could not plug it in. M1 performance is not normally governed by AC state when
  Low Power Mode is off, but this was not verified.
- **Not a quiet machine.** The user's own Kybern GPUIX app, a browser, WhatsApp and other agent sessions were running. WindowServer sat at
  ~45% CPU on the real display at the start, and round 4 of the primary session was hit by an external load: WindowServer GPU time for the
  unchanged `solid` arm went from ~1,180 ms (rounds 1–2) to ~4,700 ms, and the `solid-aa` copy dropped to 662–816 submissions per window.
  The 10% submission-count rule excludes those pairs automatically (the table counts them under "invalid"). It is why streaming rows show
  3 valid pairs of 4. I did not remove or re-run round 4.
- **Secondary streaming needed a fresh dataset per launch.** With `--keep-data` and no `idle-home` pass between them, `streaming` stopped
  painting after about three launches ("No painted content matching /BENCH_RESULT/"), so all secondary `streaming` data were discarded and
  re-collected with `gate2.ts --fresh` (re-seeds per launch). The secondary `thread-scroll` data used the kept dataset. The primary session
  was not affected (every streaming launch followed an `idle-home` launch within a few passes). The cause of the stale dataset was not
  investigated.
- Frame p95 and intervals over 33 ms are scene-submission gaps, not WindowServer presents.

## Result

### Primary session: per mode against `solid` and `sidebar` (90% bootstrap CI, 4 rounds, 3 valid pairs for streaming, 4 for the others)

| Comparison | Scenario | Metric | Δ | 90% CI | Limit | Result |
|---|---|---|---:|---|---:|---|
| window − solid | streaming | Intervals > 33 ms per 45 s | +30 | 7 … 82 | +2 | **FAIL** |
| window − solid | streaming | Frame p95 ms | +0.69 | 0.01 … 3.84 | +1.5 | unresolved |
| window − solid | streaming | WindowServer GPU ms | +48.8% | 48.8 … 67.4 | +20% | **FAIL** |
| window − solid | streaming | GPUIX GPU ms / frame | −44.8% | −59.2 … −44.0 | +15% | pass |
| window − solid | streaming | GPUIX CPU points / ms per frame | +0.73 / +1.6% | | +5 / +10% | uninformative (A/A reaches the limit) |
| window − solid | thread-scroll | Frame p95 ms | −0.22 | −0.79 … 0.20 | +1.5 | pass |
| window − solid | thread-scroll | GPUIX GPU ms / frame | −49.0% | −51.5 … −39.8 | +15% | uninformative (A/A upper 17.3%), large drop |
| window − solid | thread-scroll | WindowServer GPU ms | +67.6% | −19.5 … 99.5 | +20% | unresolved |
| window − solid | sidebar-scroll | Frame p95 ms | +0.52 | −0.38 … 7.21 | +1.5 | unresolved |
| window − solid | sidebar-scroll | GPUIX GPU ms / frame | −55.7% | −69.9 … −43.0 | +15% | pass |
| window − solid | idle-home | CPU points / MiB | −0.09 / −2 | | +1.5 / +15 | pass |
| window − sidebar | streaming | Intervals > 33 ms per 45 s | +30 | 8 … 102 | +2 | **FAIL** |
| window − sidebar | streaming | Frame p95 ms | +0.63 | 0.44 … 8.66 | +1.5 | unresolved |
| window − sidebar | streaming | WindowServer GPU ms | −26.4% | −26.8 … −6.3 | +20% | pass |
| window − sidebar | streaming | GPUIX GPU ms / frame | −40.2% | −46.3 … −39.3 | +15% | pass |
| window − sidebar | thread-scroll | Frame p95 ms | −0.55 | −1.25 … 0.07 | +1.5 | pass |
| window − sidebar | thread-scroll | WindowServer GPU ms | −5.5% | −10.1 … −3.5 | +20% | pass |
| window − sidebar | idle-home | CPU points / MiB | +0.03 / −8 | | +1.5 / +15 | pass |
| sidebar − solid | streaming | WindowServer GPU ms | +90.4% | 53.0 … 102.6 | +20% | **FAIL** |
| sidebar − solid | streaming | GPUIX GPU ms / frame | −15.9% | −25.0 … −7.8 | +15% | pass |
| sidebar − solid | thread-scroll | Frame p95 ms | +0.14 | −0.50 … 1.45 | +1.5 | pass |
| **solid-aa − solid (A/A)** | all | all | | | | **no metric fails** |

Every other row is in the generated tables at the end of this file. Idle invariant: 51 of 51 idle windows had 0 submissions and 0 GPUIX GPU ms.

Medians over rounds of block medians (primary, absolute):

| Scenario | Arm | p95 ms | >33 per 45 s | CPU pts | CPU ms/frame | GPU ms/frame | WS CPU pts | WS GPU ms | MiB |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| streaming | solid | 26.49 | 1 | 45.0 | 7.51 | 3.62 | 32.0 | 1543 | 259 |
| streaming | solid-aa | 26.11 | 0 | 43.4 | 7.38 | 3.42 | 21.9 | 1472 | 252 |
| streaming | sidebar | 25.43 | 0 | 44.1 | 7.34 | 3.05 | 33.6 | 2900 | 261 |
| streaming | window | 29.60 | 66 | 41.4 | 7.47 | 1.74 | 31.8 | 2474 | 260 |
| thread-scroll | solid / solid-aa / sidebar / window | 18.33 / 17.95 / 18.37 / 18.10 | 0 | 49.8 / 46.6 / 46.8 / 48.3 | 8.29 / 7.82 / 7.82 / 8.41 | 3.30 / 3.50 / 3.05 / 1.67 | | | |
| sidebar-scroll | solid / solid-aa / sidebar / window | 17.95 / 18.71 / 18.15 / 18.47 | 0 | 48.1 / 46.9 / 48.2 / 50.1 | 8.02 / 7.93 / 8.03 / 8.34 | 2.95 / 2.78 / 2.72 / 1.29 | | | |

### What the numbers say

- **The A/A control passed, so this gate can discriminate.** `solid-aa − solid` fails no metric. It does make several metrics uninformative in this
  session (A/A CI upper bound above the limit): streaming CPU (both rules), thread-scroll GPUIX GPU per frame (A/A upper 17.3%), sidebar-scroll
  WindowServer CPU and GPU, and idle WindowServer GPU. Those cells are not evidence either way. The spread likely comes from the
  contaminated round 4 and the real display's other windows (not isolated).
- **Whole-window glass is smooth most of the time but not always.** In streaming, `window` has 38 intervals over 33 ms in the two clean rounds
  (30 in one window, then 2 and 6) against 1 for `solid`, 0 for `sidebar` and 0 for `solid-aa`, and 66 per 45 s as the median over all four
  rounds. Frame p95 is higher by 0.7 ms (CI 0.01 … 3.8, unresolved). The first gate saw the same pattern (38 intervals over 33 ms in its
  forward pair). The fail rests on a few bad windows, three of nine valid windows in rounds 1 to 3 had double-digit counts, but it
  reproduces across two sessions, and the lower bound is above the limit with a zero A/A.
- **Sensitivity.** Using rounds 1 to 3 only (all pairs valid, round 4 dropped): `window` still fails streaming intervals over 33 ms against `solid`
  and `sidebar`, and WindowServer GPU in both streaming and thread-scroll against `solid`. Rounds 1 to 2 alone have only two pairs, which the
  procedure calls insufficient; the raw counts there are `window` 38, `solid` 1, `sidebar` 0, `solid-aa` 0. Nothing here supports calling `window` clean.
- **GPUIX GPU time halves in whole-window mode again** (−45 to −56% per submitted frame in all three active scenarios, −50% with blur Auto), as in
  the first gate. CPU per frame does not change. The first gate's explanation, that GPUI no longer draws a `BlurredView`, was already doubtful
  (research §3.2); the single-fill result below tests the overdraw explanation directly.
- **Translucency itself costs WindowServer GPU, in Sidebar only too.** `sidebar − solid` is +90% WindowServer GPU in streaming (CI 53 … 103%).
  That is the shipped default, so the fail is a finding about the default, not just about `window`, but `window − sidebar` is −26% (window is
  cheaper than sidebar for WindowServer). The hidden test display has no desktop to blur, so a real desktop may cost more.
  WindowServer counters are session-sensitive (the same `solid` arm read 1,180 ms in rounds 1 to 2 and ~4,700 ms in round 4), so read these as paired, adjacent comparisons only.
- **Idle:** 0 submissions and 0 GPU ms everywhere; idle CPU and idle memory are within limits for `window`. For `sidebar − solid` idle memory is unresolved (+4 MiB, CI −6 … 17).

### Single fill (`KYBERN_TRANSLUCENCY_SINGLE_FILL=1`, R2)

Secondary session, 3 valid pairs per row, GPUIX GPU ms per submitted frame, no A/A in this session.

| Comparison | streaming | thread-scroll |
|---|---|---|
| solid-sf − solid | −12.6% (CI −13.1 … −6.8) | −24.3% (CI −26.0 … −2.0) |
| sidebar-sf − sidebar | −13.5% (CI −22.7 … −13.4) | +15.5% (CI −17.7 … 30.6, unresolved) |
| sidebar-sf − solid | −22.6% (CI −27.9 … −21.0) | −12.4% (CI −26.2 … −4.7) |

CPU per frame and intervals over 33 ms show no failing metric for either flag; streaming frame p95 is noisy in this session (CIs of ±6 to ±14 ms, all unresolved).
The GPU saving shows in five of six cells (about 13 to 24%), a partial confirmation of the overdraw explanation, not all of it: the whole-window drop is ~50%.
The sidebar thread-scroll cell contradicts it and its CI is wide. This is a suggestive saving but not a "clear" one under this gate's rules, and the pixels were not compared in this lane. **Recommendation:**
worth keeping the flag and checking visuals (rounded-corner seams at the card edge, narrow dock overlay, Reduce transparency, Increase contrast) and then re-measuring
with an A/A arm before making it the default. I did not remove the flag or change the default rendering.

### `window` with blur Auto (effect view instead of CGS blur 64)

Same GPUIX GPU halving as blur 64: −51% (streaming) and −57% (thread-scroll) per frame against `solid`, −47% / −43% against `sidebar`.
WindowServer GPU in streaming is +105% against `solid` (CI 20 … 126%, **FAIL** by the rule), like Sidebar only (+90% in this session) and unlike
thread-scroll (+0.2%, unresolved). Streaming over-33 ms intervals were 42 per 45 s (median) for `window-auto`, 15 for `sidebar` and 30 for `solid` in this session
(all noisy; the CIs span zero). So blur Auto is not obviously cheaper or smoother than blur 64 here. There is no direct `window` vs `window-auto` pair
inside one session; the cross-session comparison is not evidence.

### Light theme, streaming (`window-light` vs `solid-light`)

Three rounds, but one pair was invalid (submission counts differ more than 10%), leaving 2 pairs: every metric is insufficient. Point estimates:
frame p95 +4.95 ms, intervals over 33 ms +22.5 per 45 s, GPUIX GPU per frame −55%, WindowServer GPU +93%. Same direction as dark; no gate claim.

## Decision

`window` fails the rule against `solid` (streaming intervals over 33 ms, streaming WindowServer GPU time) and against `sidebar` (streaming intervals
over 33 ms), with a passing A/A. Per the instruction ("if `window` passes vs `solid` and vs `sidebar`, set `DEFAULT_SIDEBAR_ONLY = false`; otherwise keep `true`"),
**`DEFAULT_SIDEBAR_ONLY` stays `true`.** Only its comment changed. Users can still switch a variant to Translucent (whole window) in Settings › Appearance.

Worth knowing for follow-up work (none of it is a change in this commit):

1. Both translucent modes cost WindowServer GPU time against `solid` while streaming, including the current default (+90%), so "translucency is free for the system" is not supported.
2. The whole-window mode's streaming problem is intermittent over-33 ms intervals, not p95. A rerun that also records which window stutters (the first window of each launch looks suspicious) could say whether it is a warm-up effect that real use would not see.
3. The ~50% GPUIX GPU drop in whole-window mode is unexplained; single fill accounts for roughly 13 to 24 points of it.

## Limits

One machine, one 16 GB M1, battery power, a busy shared Mac with the user's real display active, a hidden test display with no wallpaper, 4 rounds (3 valid for streaming),
n = 3 or 4 pairs per CI (percentile bootstrap over so few blocks is coarse), no energy claim, WindowServer counters that include every window on the machine.
The secondary session has no A/A arm and its streaming data come from a differently prepared dataset than its thread-scroll data.
The real blur look still wants one eye check on a real desktop.

## Reproduce

```sh
cd apps/gpuix
export KYBERN_DATA_DIR=<scratch dir whose path contains "scratch"> KYBERN_BENCH_PORT=<free port>
bun perf/bench/gate2.ts --out perf/bench/results/gate2-2026-10-22.jsonl --rounds 4 --seed 20261022 --tag primary
bun perf/bench/gate2-report.ts perf/bench/results/gate2-2026-10-22.jsonl --tag primary --pairs window:solid,window:sidebar,sidebar:solid --aa solid-aa:solid
```

Raw windows: `perf/bench/results/gate2-2026-10-22.jsonl` (one line per window, tags `primary`, `secondary`, `light`; round 0 is the discarded warm-up).
The primary comparison rows as JSON: `perf/bench/results/gate2-2026-10-22-summary-primary.json`. The secondary `streaming` rows were re-collected (see Deviations);
the first attempt's failed rows are not in the file.

## Generated tables


### Primary session, rounds 1 to 4

Windows: 204 (204 ok); warm-up round 0 excluded from every table.

###### Absolute values (median over rounds of block medians)

| Scenario | Arm | Frame p95 ms | Intervals > 33 ms per 45 s | GPUIX CPU points | GPUIX CPU ms/frame | GPUIX GPU ms/frame | WindowServer CPU points | WindowServer GPU ms | Submissions per 15 s window | GPUIX MiB | Idle CPU points | Idle MiB | Idle WindowServer GPU ms | Idle WindowServer CPU points |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| streaming | solid | 26.49 | 1.00 | 45.01 | 7.51 | 3.62 | 32.01 | 1543 | 901 | 259.00 |  |  |  |  |
| streaming | solid-aa | 26.11 | 0.00 | 43.39 | 7.38 | 3.42 | 21.91 | 1472 | 901 | 252.00 |  |  |  |  |
| streaming | sidebar | 25.43 | 0.00 | 44.05 | 7.34 | 3.05 | 33.58 | 2900 | 901 | 261.00 |  |  |  |  |
| streaming | window | 29.60 | 66.00 | 41.44 | 7.47 | 1.74 | 31.81 | 2474 | 901 | 259.50 |  |  |  |  |
| thread-scroll | solid | 18.33 | 0.00 | 49.80 | 8.29 | 3.30 | 29.55 | 1585 | 902 | 250.00 |  |  |  |  |
| thread-scroll | solid-aa | 17.95 | 0.00 | 46.59 | 7.82 | 3.50 | 29.83 | 1293 | 902 | 253.00 |  |  |  |  |
| thread-scroll | sidebar | 18.37 | 0.00 | 46.77 | 7.82 | 3.05 | 33.34 | 2734 | 902 | 252.50 |  |  |  |  |
| thread-scroll | window | 18.10 | 0.00 | 48.33 | 8.41 | 1.67 | 31.39 | 2517 | 902 | 253.00 |  |  |  |  |
| sidebar-scroll | solid | 17.95 | 0.00 | 48.11 | 8.02 | 2.95 | 25.70 | 1155 | 902 | 239.00 |  |  |  |  |
| sidebar-scroll | solid-aa | 18.71 | 0.00 | 46.91 | 7.93 | 2.78 | 41.06 | 2364 | 900 | 245.00 |  |  |  |  |
| sidebar-scroll | sidebar | 18.15 | 0.00 | 48.22 | 8.03 | 2.72 | 28.56 | 2621 | 902 | 233.50 |  |  |  |  |
| sidebar-scroll | window | 18.47 | 0.00 | 50.06 | 8.34 | 1.29 | 29.80 | 3037 | 902 | 236.00 |  |  |  |  |
| idle-home | solid |  |  |  |  |  |  |  |  |  | 3.16 | 216.00 | 547 | 17.54 |
| idle-home | solid-aa |  |  |  |  |  |  |  |  |  | 3.68 | 214.00 | 1362 | 35.67 |
| idle-home | sidebar |  |  |  |  |  |  |  |  |  | 2.96 | 225.00 | 708 | 17.32 |
| idle-home | window |  |  |  |  |  |  |  |  |  | 3.33 | 216.50 | 633 | 18.50 |

Idle invariant (submissions and GPUIX GPU ms stay 0): 51/51 windows at 0.

##### window − solid

Δ is the median of per-round paired differences, with a 90% bootstrap CI over rounds. Percent rows are relative to the base arm. A/A upper is the A/A CI upper bound for that metric.

| Scenario | Metric | Δ | 90% CI | Pairs (invalid) | Limit | A/A upper | Result |
|---|---|---:|---|---:|---:|---:|---|
| streaming | Frame p95 ms | 0.69 | 0.01 … 3.84 | 3 (1) | +1.5 | 0.48 | unresolved |
| streaming | Intervals > 33 ms per 45 s | 30.00 | 7.00 … 82.00 | 3 (1) | +2 | 0.00 | **FAIL** |
| streaming | GPUIX CPU points | 0.73 | 0.59 … 3.32 | 3 (1) | +5 | 9.04 | uninformative |
| streaming | GPUIX CPU ms / frame (%) | 1.56% | 1.45 … 9.75 | 3 (1) | +10% | 26.73 | uninformative |
| streaming | GPUIX GPU ms / frame (%) | -44.77% | -59.16 … -44.04 | 3 (1) | +15% | 0.08 | pass |
| streaming | WindowServer CPU points | 2.53 | 1.19 … 3.12 | 3 (1) | +4 | 0.07 | pass |
| streaming | WindowServer GPU ms (%) | 48.79% | 48.77 … 67.42 | 3 (1) | +20% | -0.06 | **FAIL** |
| streaming | Submissions per 15 s window (%) | 0.00% | -0.11 … 0.00 | 3 (1) | — | 0.00 | info |
| streaming | GPUIX GPU ms per window (%) | -44.77% | -59.11 … -44.31 | 3 (1) | — | 0.08 | info |
| streaming | GPUIX MiB | -6.00 | -15.00 … 7.00 | 3 (1) | — | -7.00 | info |
| thread-scroll | Frame p95 ms | -0.22 | -0.79 … 0.20 | 4 (0) | +1.5 | 0.13 | pass |
| thread-scroll | Intervals > 33 ms per 45 s | 0.00 | -66.00 … 0.00 | 4 (0) | +2 | 0.00 | pass |
| thread-scroll | GPUIX CPU points | 2.03 | -4.98 … 2.33 | 4 (0) | +5 | 1.65 | pass |
| thread-scroll | GPUIX CPU ms / frame (%) | 4.01% | -9.99 … 6.47 | 4 (0) | +10% | 2.61 | pass |
| thread-scroll | GPUIX GPU ms / frame (%) | -49.03% | -51.45 … -39.82 | 4 (0) | +15% | 17.27 | uninformative |
| thread-scroll | WindowServer CPU points | 1.79 | -6.18 … 2.53 | 4 (0) | +4 | 3.70 | pass |
| thread-scroll | WindowServer GPU ms (%) | 67.60% | -19.54 … 99.49 | 4 (0) | +20% | -2.80 | unresolved |
| thread-scroll | Submissions per 15 s window (%) | 0.00% | -2.58 … 0.11 | 4 (0) | — | 0.06 | info |
| thread-scroll | GPUIX GPU ms per window (%) | -49.00% | -51.42 … -41.56 | 4 (0) | — | 17.27 | info |
| thread-scroll | GPUIX MiB | 2.00 | 0.00 … 6.00 | 4 (0) | — | 6.00 | info |
| sidebar-scroll | Frame p95 ms | 0.52 | -0.38 … 7.21 | 4 (0) | +1.5 | 1.05 | unresolved |
| sidebar-scroll | Intervals > 33 ms per 45 s | 0.00 | -5.00 … 26.00 | 4 (0) | +2 | 0.00 | unresolved |
| sidebar-scroll | GPUIX CPU points | 1.42 | -3.59 … 2.87 | 4 (0) | +5 | 0.60 | pass |
| sidebar-scroll | GPUIX CPU ms / frame (%) | 2.86% | -7.71 … 6.11 | 4 (0) | +10% | 1.21 | pass |
| sidebar-scroll | GPUIX GPU ms / frame (%) | -55.72% | -69.85 … -43.04 | 4 (0) | +15% | 1.72 | pass |
| sidebar-scroll | WindowServer CPU points | 4.20 | 2.46 … 6.66 | 4 (0) | +4 | 30.91 | uninformative |
| sidebar-scroll | WindowServer GPU ms (%) | 118.98% | -49.95 … 231.66 | 4 (0) | +20% | 180.87 | uninformative |
| sidebar-scroll | Submissions per 15 s window (%) | 0.06% | -2.66 … 0.11 | 4 (0) | — | 0.11 | info |
| sidebar-scroll | GPUIX GPU ms per window (%) | -55.75% | -71.75 … -42.97 | 4 (0) | — | 1.61 | info |
| sidebar-scroll | GPUIX MiB | -3.00 | -23.00 … 20.00 | 4 (0) | — | 18.00 | info |
| idle-home | Idle CPU points | -0.09 | -0.33 … 0.73 | 4 (0) | +1.5 | 1.06 | pass |
| idle-home | Idle MiB | -2.00 | -9.50 … 6.00 | 4 (0) | +15 | 15.00 | pass |
| idle-home | Idle WindowServer GPU ms (%) | -0.09% | -0.75 … 113.54 | 4 (0) | +20% | 2014.43 | uninformative |
| idle-home | Idle WindowServer CPU points | 0.96 | -0.03 … 12.34 | 4 (0) | — | 35.73 | info |

CPU rule (points AND per-frame must both fail): streaming: uninformative; thread-scroll: pass; sidebar-scroll: pass.
**window vs solid: FAILS — streaming Intervals > 33 ms per 45 s; streaming WindowServer GPU ms (%).** Uninformative this session (A/A reaches the limit): streaming GPUIX CPU points; streaming GPUIX CPU ms / frame (%); thread-scroll GPUIX GPU ms / frame (%); sidebar-scroll WindowServer CPU points; sidebar-scroll WindowServer GPU ms (%); idle-home Idle WindowServer GPU ms (%).

##### window − sidebar

Δ is the median of per-round paired differences, with a 90% bootstrap CI over rounds. Percent rows are relative to the base arm. A/A upper is the A/A CI upper bound for that metric.

| Scenario | Metric | Δ | 90% CI | Pairs (invalid) | Limit | A/A upper | Result |
|---|---|---:|---|---:|---:|---:|---|
| streaming | Frame p95 ms | 0.63 | 0.44 … 8.66 | 3 (1) | +1.5 | 0.48 | unresolved |
| streaming | Intervals > 33 ms per 45 s | 30.00 | 8.00 … 102.00 | 3 (1) | +2 | 0.00 | **FAIL** |
| streaming | GPUIX CPU points | 0.68 | -2.45 … 1.04 | 3 (1) | +5 | 9.04 | uninformative |
| streaming | GPUIX CPU ms / frame (%) | 1.59% | -6.22 … 2.34 | 3 (1) | +10% | 26.73 | uninformative |
| streaming | GPUIX GPU ms / frame (%) | -40.20% | -46.32 … -39.27 | 3 (1) | +15% | 0.08 | pass |
| streaming | WindowServer CPU points | -0.20 | -0.52 … -0.20 | 3 (1) | +4 | 0.07 | pass |
| streaming | WindowServer GPU ms (%) | -26.40% | -26.75 … -6.31 | 3 (1) | +20% | -0.06 | pass |
| streaming | Submissions per 15 s window (%) | 0.00% | -0.11 … 0.00 | 3 (1) | — | 0.00 | info |
| streaming | GPUIX GPU ms per window (%) | -40.23% | -46.32 … -39.56 | 3 (1) | — | 0.08 | info |
| streaming | GPUIX MiB | -5.00 | -17.00 … 19.00 | 3 (1) | — | -7.00 | info |
| thread-scroll | Frame p95 ms | -0.55 | -1.25 … 0.07 | 4 (0) | +1.5 | 0.13 | pass |
| thread-scroll | Intervals > 33 ms per 45 s | 0.00 | 0.00 … 8.00 | 4 (0) | +2 | 0.00 | unresolved |
| thread-scroll | GPUIX CPU points | 2.20 | -1.98 … 4.09 | 4 (0) | +5 | 1.65 | pass |
| thread-scroll | GPUIX CPU ms / frame (%) | 5.38% | -4.33 … 8.62 | 4 (0) | +10% | 2.61 | pass |
| thread-scroll | GPUIX GPU ms / frame (%) | -46.38% | -51.22 … -41.04 | 4 (0) | +15% | 17.27 | uninformative |
| thread-scroll | WindowServer CPU points | -1.82 | -3.24 … -1.09 | 4 (0) | +4 | 3.70 | pass |
| thread-scroll | WindowServer GPU ms (%) | -5.48% | -10.05 … -3.46 | 4 (0) | +20% | -2.80 | pass |
| thread-scroll | Submissions per 15 s window (%) | 0.06% | 0.00 … 0.12 | 4 (0) | — | 0.06 | info |
| thread-scroll | GPUIX GPU ms per window (%) | -46.35% | -51.22 … -40.97 | 4 (0) | — | 17.27 | info |
| thread-scroll | GPUIX MiB | 0.00 | -1.00 … 0.50 | 4 (0) | — | 6.00 | info |
| sidebar-scroll | Frame p95 ms | 0.25 | 0.02 … 7.37 | 4 (0) | +1.5 | 1.05 | unresolved |
| sidebar-scroll | Intervals > 33 ms per 45 s | 0.00 | 0.00 … 26.00 | 4 (0) | +2 | 0.00 | unresolved |
| sidebar-scroll | GPUIX CPU points | 1.55 | -1.33 … 2.29 | 4 (0) | +5 | 0.60 | pass |
| sidebar-scroll | GPUIX CPU ms / frame (%) | 3.18% | -3.00 … 4.72 | 4 (0) | +10% | 1.21 | pass |
| sidebar-scroll | GPUIX GPU ms / frame (%) | -51.87% | -70.31 … -29.51 | 4 (0) | +15% | 1.72 | pass |
| sidebar-scroll | WindowServer CPU points | -0.47 | -1.10 … 9.64 | 4 (0) | +4 | 30.91 | uninformative |
| sidebar-scroll | WindowServer GPU ms (%) | -8.19% | -45.48 … 52.70 | 4 (0) | +20% | 180.87 | uninformative |
| sidebar-scroll | Submissions per 15 s window (%) | 0.00% | -2.66 … 0.00 | 4 (0) | — | 0.11 | info |
| sidebar-scroll | GPUIX GPU ms per window (%) | -51.89% | -72.18 … -29.51 | 4 (0) | — | 1.61 | info |
| sidebar-scroll | GPUIX MiB | 4.00 | -8.00 … 17.00 | 4 (0) | — | 18.00 | info |
| idle-home | Idle CPU points | 0.03 | -0.13 … 1.19 | 4 (0) | +1.5 | 1.06 | pass |
| idle-home | Idle MiB | -8.00 | -22.00 … 7.00 | 4 (0) | +15 | 15.00 | pass |
| idle-home | Idle WindowServer GPU ms (%) | -1.06% | -11.14 … 36.69 | 4 (0) | +20% | 2014.43 | uninformative |
| idle-home | Idle WindowServer CPU points | 1.21 | 0.00 … 4.51 | 4 (0) | — | 35.73 | info |

CPU rule (points AND per-frame must both fail): streaming: uninformative; thread-scroll: pass; sidebar-scroll: pass.
**window vs sidebar: FAILS — streaming Intervals > 33 ms per 45 s.** Uninformative this session (A/A reaches the limit): streaming GPUIX CPU points; streaming GPUIX CPU ms / frame (%); thread-scroll GPUIX GPU ms / frame (%); sidebar-scroll WindowServer CPU points; sidebar-scroll WindowServer GPU ms (%); idle-home Idle WindowServer GPU ms (%).

##### sidebar − solid

Δ is the median of per-round paired differences, with a 90% bootstrap CI over rounds. Percent rows are relative to the base arm. A/A upper is the A/A CI upper bound for that metric.

| Scenario | Metric | Δ | 90% CI | Pairs (invalid) | Limit | A/A upper | Result |
|---|---|---:|---|---:|---:|---:|---|
| streaming | Frame p95 ms | -0.18 | -4.82 … 3.51 | 4 (0) | +1.5 | 0.48 | unresolved |
| streaming | Intervals > 33 ms per 45 s | -1.00 | -20.00 … -0.50 | 4 (0) | +2 | 0.00 | pass |
| streaming | GPUIX CPU points | -0.20 | -2.07 … 5.77 | 4 (0) | +5 | 9.04 | uninformative |
| streaming | GPUIX CPU ms / frame (%) | -0.45% | -4.64 … 17.02 | 4 (0) | +10% | 26.73 | uninformative |
| streaming | GPUIX GPU ms / frame (%) | -15.88% | -25.01 … -7.75 | 4 (0) | +15% | 0.08 | pass |
| streaming | WindowServer CPU points | 2.22 | -3.32 … 3.18 | 4 (0) | +4 | 0.07 | pass |
| streaming | WindowServer GPU ms (%) | 90.43% | 52.95 … 102.64 | 4 (0) | +20% | -0.06 | **FAIL** |
| streaming | Submissions per 15 s window (%) | 0.00% | 0.00 … 0.00 | 4 (0) | — | 0.00 | info |
| streaming | GPUIX GPU ms per window (%) | -15.84% | -25.01 … -7.73 | 4 (0) | — | 0.08 | info |
| streaming | GPUIX MiB | 0.50 | -12.00 … 13.00 | 4 (0) | — | -7.00 | info |
| thread-scroll | Frame p95 ms | 0.14 | -0.50 … 1.45 | 4 (0) | +1.5 | 0.13 | pass |
| thread-scroll | Intervals > 33 ms per 45 s | 0.00 | -74.00 … 0.00 | 4 (0) | +2 | 0.00 | pass |
| thread-scroll | GPUIX CPU points | -2.03 | -3.03 … 0.71 | 4 (0) | +5 | 1.65 | pass |
| thread-scroll | GPUIX CPU ms / frame (%) | -4.07% | -6.03 … 1.34 | 4 (0) | +10% | 2.61 | pass |
| thread-scroll | GPUIX GPU ms / frame (%) | -0.18% | -9.70 … 7.94 | 4 (0) | +15% | 17.27 | uninformative |
| thread-scroll | WindowServer CPU points | 2.89 | -2.94 … 4.38 | 4 (0) | +4 | 3.70 | unresolved |
| thread-scroll | WindowServer GPU ms (%) | 74.97% | -15.79 … 121.76 | 4 (0) | +20% | -2.80 | unresolved |
| thread-scroll | Submissions per 15 s window (%) | -0.06% | -2.70 … 0.11 | 4 (0) | — | 0.06 | info |
| thread-scroll | GPUIX GPU ms per window (%) | -0.30% | -9.81 … 4.89 | 4 (0) | — | 17.27 | info |
| thread-scroll | GPUIX MiB | 2.00 | 0.00 … 6.00 | 4 (0) | — | 6.00 | info |
| sidebar-scroll | Frame p95 ms | 0.11 | -0.63 … 0.63 | 4 (0) | +1.5 | 1.05 | pass |
| sidebar-scroll | Intervals > 33 ms per 45 s | 0.00 | -5.00 … 0.00 | 4 (0) | +2 | 0.00 | pass |
| sidebar-scroll | GPUIX CPU points | -0.86 | -2.26 … 1.75 | 4 (0) | +5 | 0.60 | pass |
| sidebar-scroll | GPUIX CPU ms / frame (%) | -1.77% | -4.85 … 3.68 | 4 (0) | +10% | 1.21 | pass |
| sidebar-scroll | GPUIX GPU ms / frame (%) | -7.97% | -19.19 … 1.54 | 4 (0) | +15% | 1.72 | pass |
| sidebar-scroll | WindowServer CPU points | 3.02 | -2.98 … 6.01 | 4 (0) | +4 | 30.91 | uninformative |
| sidebar-scroll | WindowServer GPU ms (%) | 124.90% | -8.21 … 144.53 | 4 (0) | +20% | 180.87 | uninformative |
| sidebar-scroll | Submissions per 15 s window (%) | 0.06% | 0.00 … 0.11 | 4 (0) | — | 0.11 | info |
| sidebar-scroll | GPUIX GPU ms per window (%) | -7.97% | -19.10 … 1.54 | 4 (0) | — | 1.61 | info |
| sidebar-scroll | GPUIX MiB | -6.00 | -17.00 … 5.00 | 4 (0) | — | 18.00 | info |
| idle-home | Idle CPU points | -0.16 | -0.46 … -0.13 | 4 (0) | +1.5 | 1.06 | pass |
| idle-home | Idle MiB | 4.00 | -6.00 … 17.00 | 4 (0) | +15 | 15.00 | unresolved |
| idle-home | Idle WindowServer GPU ms (%) | 6.89% | -0.13 … 56.22 | 4 (0) | +20% | 2014.43 | uninformative |
| idle-home | Idle WindowServer CPU points | -0.03 | -0.43 … 7.83 | 4 (0) | — | 35.73 | info |

CPU rule (points AND per-frame must both fail): streaming: uninformative; thread-scroll: pass; sidebar-scroll: pass.
**sidebar vs solid: FAILS — streaming WindowServer GPU ms (%).** Uninformative this session (A/A reaches the limit): streaming GPUIX CPU points; streaming GPUIX CPU ms / frame (%); thread-scroll GPUIX GPU ms / frame (%); sidebar-scroll WindowServer CPU points; sidebar-scroll WindowServer GPU ms (%); idle-home Idle WindowServer GPU ms (%).

##### solid-aa − solid (A/A control: the same mode twice)

Δ is the median of per-round paired differences, with a 90% bootstrap CI over rounds. Percent rows are relative to the base arm. A/A upper is the A/A CI upper bound for that metric.

| Scenario | Metric | Δ | 90% CI | Pairs (invalid) | Limit | A/A upper | Result |
|---|---|---:|---|---:|---:|---:|---|
| streaming | Frame p95 ms | -1.24 | -4.74 … 0.48 | 3 (1) | +1.5 | — | pass |
| streaming | Intervals > 33 ms per 45 s | -1.00 | -20.00 … 0.00 | 3 (1) | +2 | — | pass |
| streaming | GPUIX CPU points | -0.03 | -0.71 … 9.04 | 3 (1) | +5 | — | unresolved |
| streaming | GPUIX CPU ms / frame (%) | 0.00% | -1.65 … 26.73 | 3 (1) | +10% | — | unresolved |
| streaming | GPUIX GPU ms / frame (%) | -0.23% | -11.08 … 0.08 | 3 (1) | +15% | — | pass |
| streaming | WindowServer CPU points | -0.40 | -0.60 … 0.07 | 3 (1) | +4 | — | pass |
| streaming | WindowServer GPU ms (%) | -1.25% | -7.43 … -0.06 | 3 (1) | +20% | — | pass |
| streaming | Submissions per 15 s window (%) | 0.00% | 0.00 … 0.00 | 3 (1) | — | — | info |
| streaming | GPUIX GPU ms per window (%) | -0.23% | -10.98 … 0.08 | 3 (1) | — | — | info |
| streaming | GPUIX MiB | -10.00 | -12.00 … -7.00 | 3 (1) | — | — | info |
| thread-scroll | Frame p95 ms | -0.32 | -0.80 … 0.13 | 4 (0) | +1.5 | — | pass |
| thread-scroll | Intervals > 33 ms per 45 s | 0.00 | -101.00 … 0.00 | 4 (0) | +2 | — | pass |
| thread-scroll | GPUIX CPU points | -0.81 | -3.22 … 1.73 | 4 (0) | +5 | — | pass |
| thread-scroll | GPUIX CPU ms / frame (%) | -2.27% | -6.47 … 3.35 | 4 (0) | +10% | — | pass |
| thread-scroll | GPUIX GPU ms / frame (%) | 9.72% | -1.48 … 17.27 | 4 (0) | +15% | — | unresolved |
| thread-scroll | WindowServer CPU points | 0.04 | -8.04 … 3.70 | 4 (0) | +4 | — | pass |
| thread-scroll | WindowServer GPU ms (%) | -15.59% | -29.38 … 6.18 | 4 (0) | +20% | — | pass |
| thread-scroll | Submissions per 15 s window (%) | 0.00% | -0.82 … 0.11 | 4 (0) | — | — | info |
| thread-scroll | GPUIX GPU ms per window (%) | 9.20% | -1.37 … 17.27 | 4 (0) | — | — | info |
| thread-scroll | GPUIX MiB | 3.00 | 2.50 … 6.00 | 4 (0) | — | — | info |
| sidebar-scroll | Frame p95 ms | 0.07 | -0.56 … 1.05 | 3 (1) | +1.5 | — | pass |
| sidebar-scroll | Intervals > 33 ms per 45 s | 0.00 | 0.00 … 0.00 | 3 (1) | +2 | — | pass |
| sidebar-scroll | GPUIX CPU points | 0.13 | -3.13 … 0.60 | 3 (1) | +5 | — | pass |
| sidebar-scroll | GPUIX CPU ms / frame (%) | 0.28% | -5.60 … 1.21 | 3 (1) | +10% | — | pass |
| sidebar-scroll | GPUIX GPU ms / frame (%) | -0.41% | -11.09 … 1.72 | 3 (1) | +15% | — | pass |
| sidebar-scroll | WindowServer CPU points | 9.45 | 0.13 … 30.91 | 3 (1) | +4 | — | unresolved |
| sidebar-scroll | WindowServer GPU ms (%) | 56.11% | 1.30 … 180.87 | 3 (1) | +20% | — | unresolved |
| sidebar-scroll | Submissions per 15 s window (%) | 0.00% | -0.55 … 0.11 | 3 (1) | — | — | info |
| sidebar-scroll | GPUIX GPU ms per window (%) | -0.52% | -11.69 … 1.61 | 3 (1) | — | — | info |
| sidebar-scroll | GPUIX MiB | 13.00 | -9.00 … 18.00 | 3 (1) | — | — | info |
| idle-home | Idle CPU points | 0.47 | -0.73 … 1.02 | 4 (0) | +1.5 | — | pass |
| idle-home | Idle MiB | 1.00 | -12.00 … 15.00 | 4 (0) | +15 | — | pass |
| idle-home | Idle WindowServer GPU ms (%) | 86.38% | -11.79 … 1093.28 | 4 (0) | +20% | — | unresolved |
| idle-home | Idle WindowServer CPU points | 2.22 | -0.07 … 19.29 | 4 (0) | — | — | info |

CPU rule (points AND per-frame must both fail): streaming: unresolved; thread-scroll: pass; sidebar-scroll: pass.
**solid-aa vs solid: no metric fails.**

### Primary session, rounds 1 to 3 only (sensitivity)

Windows: 144 (144 ok); warm-up round 0 excluded from every table.

###### Absolute values (median over rounds of block medians)

| Scenario | Arm | Frame p95 ms | Intervals > 33 ms per 45 s | GPUIX CPU points | GPUIX CPU ms/frame | GPUIX GPU ms/frame | WindowServer CPU points | WindowServer GPU ms | Submissions per 15 s window | GPUIX MiB | Idle CPU points | Idle MiB | Idle WindowServer GPU ms | Idle WindowServer CPU points |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| idle-home | solid-aa |  |  |  |  |  |  |  |  |  | 4.18 | 214.00 | 1053 | 35.67 |
| idle-home | sidebar |  |  |  |  |  |  |  |  |  | 2.92 | 233.00 | 81 | 2.26 |
| idle-home | window |  |  |  |  |  |  |  |  |  | 3.06 | 216.00 | 79 | 2.26 |
| idle-home | solid |  |  |  |  |  |  |  |  |  | 3.12 | 216.00 | 80 | 2.26 |
| sidebar-scroll | solid-aa | 18.10 | 0.00 | 47.14 | 7.90 | 2.95 | 44.09 | 2199 | 902 | 243.00 |  |  |  |  |
| sidebar-scroll | sidebar | 18.03 | 0.00 | 48.61 | 8.09 | 2.79 | 19.88 | 2181 | 902 | 232.00 |  |  |  |  |
| sidebar-scroll | window | 18.43 | 0.00 | 51.19 | 8.53 | 1.30 | 19.95 | 1982 | 902 | 240.00 |  |  |  |  |
| sidebar-scroll | solid | 18.27 | 0.00 | 49.67 | 8.28 | 2.96 | 16.76 | 900 | 902 | 230.00 |  |  |  |  |
| streaming | solid-aa | 25.38 | 0.00 | 44.09 | 7.35 | 3.64 | 19.88 | 1172 | 901 | 250.00 |  |  |  |  |
| streaming | sidebar | 26.00 | 0.00 | 44.49 | 7.42 | 3.37 | 23.13 | 2381 | 901 | 256.00 |  |  |  |  |
| streaming | window | 27.05 | 30.00 | 45.53 | 7.59 | 2.02 | 22.93 | 1745 | 901 | 251.00 |  |  |  |  |
| streaming | solid | 26.62 | 1.00 | 44.80 | 7.47 | 3.65 | 20.01 | 1173 | 901 | 261.00 |  |  |  |  |
| thread-scroll | solid-aa | 17.57 | 0.00 | 46.68 | 7.77 | 3.58 | 19.48 | 1034 | 902 | 253.00 |  |  |  |  |
| thread-scroll | sidebar | 18.18 | 0.00 | 46.87 | 7.81 | 3.28 | 21.81 | 2160 | 902 | 252.00 |  |  |  |  |
| thread-scroll | window | 17.99 | 0.00 | 51.59 | 8.59 | 1.67 | 20.75 | 1943 | 902 | 253.00 |  |  |  |  |
| thread-scroll | solid | 18.24 | 0.00 | 49.87 | 8.30 | 3.46 | 18.62 | 974 | 902 | 250.00 |  |  |  |  |

Idle invariant (submissions and GPUIX GPU ms stay 0): 36/36 windows at 0.

##### window − solid

Δ is the median of per-round paired differences, with a 90% bootstrap CI over rounds. Percent rows are relative to the base arm. A/A upper is the A/A CI upper bound for that metric.

| Scenario | Metric | Δ | 90% CI | Pairs (invalid) | Limit | A/A upper | Result |
|---|---|---:|---|---:|---:|---:|---|
| idle-home | Idle CPU points | 0.01 | -0.20 … 0.73 | 3 (0) | +1.5 | 1.06 | pass |
| idle-home | Idle MiB | -5.00 | -14.00 … 6.00 | 3 (0) | +15 | 15.00 | pass |
| idle-home | Idle WindowServer GPU ms (%) | -0.70% | -0.75 … 0.51 | 3 (0) | +20% | 2014.43 | uninformative |
| idle-home | Idle WindowServer CPU points | 0.00 | -0.07 … 1.92 | 3 (0) | — | 35.73 | info |
| sidebar-scroll | Frame p95 ms | 0.16 | -0.38 … 7.21 | 3 (0) | +1.5 | 1.05 | unresolved |
| sidebar-scroll | Intervals > 33 ms per 45 s | 0.00 | 0.00 … 26.00 | 3 (0) | +2 | 0.00 | unresolved |
| sidebar-scroll | GPUIX CPU points | 0.92 | -3.59 … 1.93 | 3 (0) | +5 | 0.60 | pass |
| sidebar-scroll | GPUIX CPU ms / frame (%) | 1.94% | -7.71 … 3.77 | 3 (0) | +10% | 1.21 | pass |
| sidebar-scroll | GPUIX GPU ms / frame (%) | -56.27% | -69.85 … -55.18 | 3 (0) | +15% | 1.72 | pass |
| sidebar-scroll | WindowServer CPU points | 3.39 | 1.52 … 5.00 | 3 (0) | +4 | 30.91 | uninformative |
| sidebar-scroll | WindowServer GPU ms (%) | 122.27% | 115.70 … 231.66 | 3 (0) | +20% | 180.87 | uninformative |
| sidebar-scroll | Submissions per 15 s window (%) | 0.00% | -2.66 … 0.11 | 3 (0) | — | 0.11 | info |
| sidebar-scroll | GPUIX GPU ms per window (%) | -56.27% | -71.75 … -55.23 | 3 (0) | — | 1.61 | info |
| sidebar-scroll | GPUIX MiB | 10.00 | -16.00 … 20.00 | 3 (0) | — | 18.00 | info |
| streaming | Frame p95 ms | 0.69 | 0.01 … 3.84 | 3 (0) | +1.5 | 0.48 | unresolved |
| streaming | Intervals > 33 ms per 45 s | 30.00 | 7.00 … 82.00 | 3 (0) | +2 | 0.00 | **FAIL** |
| streaming | GPUIX CPU points | 0.73 | 0.59 … 3.32 | 3 (0) | +5 | 9.04 | uninformative |
| streaming | GPUIX CPU ms / frame (%) | 1.56% | 1.45 … 9.75 | 3 (0) | +10% | 26.73 | uninformative |
| streaming | GPUIX GPU ms / frame (%) | -44.77% | -59.16 … -44.04 | 3 (0) | +15% | 0.08 | pass |
| streaming | WindowServer CPU points | 2.53 | 1.19 … 3.12 | 3 (0) | +4 | 0.07 | pass |
| streaming | WindowServer GPU ms (%) | 48.79% | 48.77 … 67.42 | 3 (0) | +20% | -0.06 | **FAIL** |
| streaming | Submissions per 15 s window (%) | 0.00% | -0.11 … 0.00 | 3 (0) | — | 0.00 | info |
| streaming | GPUIX GPU ms per window (%) | -44.77% | -59.11 … -44.31 | 3 (0) | — | 0.08 | info |
| streaming | GPUIX MiB | -6.00 | -15.00 … 7.00 | 3 (0) | — | -7.00 | info |
| thread-scroll | Frame p95 ms | -0.43 | -0.79 … -0.01 | 3 (0) | +1.5 | 0.12 | pass |
| thread-scroll | Intervals > 33 ms per 45 s | 0.00 | 0.00 … 0.00 | 3 (0) | +2 | 0.00 | pass |
| thread-scroll | GPUIX CPU points | 1.72 | -4.98 … 2.33 | 3 (0) | +5 | 1.73 | pass |
| thread-scroll | GPUIX CPU ms / frame (%) | 3.33% | -9.99 … 4.68 | 3 (0) | +10% | 3.35 | pass |
| thread-scroll | GPUIX GPU ms / frame (%) | -51.30% | -51.60 … -46.76 | 3 (0) | +15% | 17.27 | uninformative |
| thread-scroll | WindowServer CPU points | 1.46 | -6.18 … 2.13 | 3 (0) | +4 | 0.93 | pass |
| thread-scroll | WindowServer GPU ms (%) | 94.42% | 40.77 … 99.49 | 3 (0) | +20% | 6.18 | **FAIL** |
| thread-scroll | Submissions per 15 s window (%) | 0.00% | 0.00 … 0.11 | 3 (0) | — | 0.11 | info |
| thread-scroll | GPUIX GPU ms per window (%) | -51.25% | -51.60 … -46.76 | 3 (0) | — | 17.27 | info |
| thread-scroll | GPUIX MiB | 3.00 | 0.00 … 6.00 | 3 (0) | — | 6.00 | info |

CPU rule (points AND per-frame must both fail): sidebar-scroll: pass; streaming: uninformative; thread-scroll: pass.
**window vs solid: FAILS — streaming Intervals > 33 ms per 45 s; streaming WindowServer GPU ms (%); thread-scroll WindowServer GPU ms (%).** Uninformative this session (A/A reaches the limit): idle-home Idle WindowServer GPU ms (%); sidebar-scroll WindowServer CPU points; sidebar-scroll WindowServer GPU ms (%); streaming GPUIX CPU points; streaming GPUIX CPU ms / frame (%); thread-scroll GPUIX GPU ms / frame (%).

##### window − sidebar

Δ is the median of per-round paired differences, with a 90% bootstrap CI over rounds. Percent rows are relative to the base arm. A/A upper is the A/A CI upper bound for that metric.

| Scenario | Metric | Δ | 90% CI | Pairs (invalid) | Limit | A/A upper | Result |
|---|---|---:|---|---:|---:|---:|---|
| idle-home | Idle CPU points | 0.14 | -0.07 … 1.19 | 3 (0) | +1.5 | 1.06 | pass |
| idle-home | Idle MiB | -15.00 | -22.00 … -1.00 | 3 (0) | +15 | 15.00 | pass |
| idle-home | Idle WindowServer GPU ms (%) | -1.49% | -11.14 … -0.63 | 3 (0) | +20% | 2014.43 | uninformative |
| idle-home | Idle WindowServer CPU points | 0.07 | -0.07 … 2.35 | 3 (0) | — | 35.73 | info |
| sidebar-scroll | Frame p95 ms | 0.25 | -0.21 … 7.37 | 3 (0) | +1.5 | 1.05 | unresolved |
| sidebar-scroll | Intervals > 33 ms per 45 s | 0.00 | 0.00 … 26.00 | 3 (0) | +2 | 0.00 | unresolved |
| sidebar-scroll | GPUIX CPU points | 1.99 | -1.33 … 2.58 | 3 (0) | +5 | 0.60 | pass |
| sidebar-scroll | GPUIX CPU ms / frame (%) | 4.01% | -3.00 … 5.42 | 3 (0) | +10% | 1.21 | pass |
| sidebar-scroll | GPUIX GPU ms / frame (%) | -52.66% | -70.31 … -51.07 | 3 (0) | +15% | 1.72 | pass |
| sidebar-scroll | WindowServer CPU points | -1.01 | -1.20 … 0.07 | 3 (0) | +4 | 30.91 | uninformative |
| sidebar-scroll | WindowServer GPU ms (%) | -7.26% | -9.11 … 52.70 | 3 (0) | +20% | 180.87 | uninformative |
| sidebar-scroll | Submissions per 15 s window (%) | 0.00% | -2.66 … 0.00 | 3 (0) | — | 0.11 | info |
| sidebar-scroll | GPUIX GPU ms per window (%) | -52.72% | -72.18 … -51.07 | 3 (0) | — | 1.61 | info |
| sidebar-scroll | GPUIX MiB | 5.00 | 3.00 … 17.00 | 3 (0) | — | 18.00 | info |
| streaming | Frame p95 ms | 0.63 | 0.44 … 8.66 | 3 (0) | +1.5 | 0.48 | unresolved |
| streaming | Intervals > 33 ms per 45 s | 30.00 | 8.00 … 102.00 | 3 (0) | +2 | 0.00 | **FAIL** |
| streaming | GPUIX CPU points | 0.68 | -2.45 … 1.04 | 3 (0) | +5 | 9.04 | uninformative |
| streaming | GPUIX CPU ms / frame (%) | 1.59% | -6.22 … 2.34 | 3 (0) | +10% | 26.73 | uninformative |
| streaming | GPUIX GPU ms / frame (%) | -40.20% | -46.32 … -39.27 | 3 (0) | +15% | 0.08 | pass |
| streaming | WindowServer CPU points | -0.20 | -0.52 … -0.20 | 3 (0) | +4 | 0.07 | pass |
| streaming | WindowServer GPU ms (%) | -26.40% | -26.75 … -6.31 | 3 (0) | +20% | -0.06 | pass |
| streaming | Submissions per 15 s window (%) | 0.00% | -0.11 … 0.00 | 3 (0) | — | 0.00 | info |
| streaming | GPUIX GPU ms per window (%) | -40.23% | -46.32 … -39.56 | 3 (0) | — | 0.08 | info |
| streaming | GPUIX MiB | -5.00 | -17.00 … 19.00 | 3 (0) | — | -7.00 | info |
| thread-scroll | Frame p95 ms | -0.36 | -0.73 … 0.50 | 3 (0) | +1.5 | 0.12 | pass |
| thread-scroll | Intervals > 33 ms per 45 s | 0.00 | 0.00 … 0.00 | 3 (0) | +2 | 0.00 | pass |
| thread-scroll | GPUIX CPU points | 2.78 | -1.98 … 5.39 | 3 (0) | +5 | 1.73 | unresolved |
| thread-scroll | GPUIX CPU ms / frame (%) | 5.70% | -4.33 … 11.55 | 3 (0) | +10% | 3.35 | unresolved |
| thread-scroll | GPUIX GPU ms / frame (%) | -48.51% | -53.93 … -41.04 | 3 (0) | +15% | 17.27 | uninformative |
| thread-scroll | WindowServer CPU points | -1.80 | -3.24 … -0.39 | 3 (0) | +4 | 0.93 | pass |
| thread-scroll | WindowServer GPU ms (%) | -6.51% | -10.05 … -2.48 | 3 (0) | +20% | 6.18 | pass |
| thread-scroll | Submissions per 15 s window (%) | 0.00% | 0.00 … 0.11 | 3 (0) | — | 0.11 | info |
| thread-scroll | GPUIX GPU ms per window (%) | -48.51% | -53.93 … -40.97 | 3 (0) | — | 17.27 | info |
| thread-scroll | GPUIX MiB | 0.00 | 0.00 … 1.00 | 3 (0) | — | 6.00 | info |

CPU rule (points AND per-frame must both fail): sidebar-scroll: pass; streaming: uninformative; thread-scroll: unresolved.
**window vs sidebar: FAILS — streaming Intervals > 33 ms per 45 s.** Uninformative this session (A/A reaches the limit): idle-home Idle WindowServer GPU ms (%); sidebar-scroll WindowServer CPU points; sidebar-scroll WindowServer GPU ms (%); streaming GPUIX CPU points; streaming GPUIX CPU ms / frame (%); thread-scroll GPUIX GPU ms / frame (%).

##### sidebar − solid

Δ is the median of per-round paired differences, with a 90% bootstrap CI over rounds. Percent rows are relative to the base arm. A/A upper is the A/A CI upper bound for that metric.

| Scenario | Metric | Δ | 90% CI | Pairs (invalid) | Limit | A/A upper | Result |
|---|---|---:|---|---:|---:|---:|---|
| idle-home | Idle CPU points | -0.13 | -0.46 … -0.13 | 3 (0) | +1.5 | 1.06 | pass |
| idle-home | Idle MiB | 7.00 | 1.00 … 17.00 | 3 (0) | +15 | 15.00 | unresolved |
| idle-home | Idle WindowServer GPU ms (%) | 2.03% | -0.13 … 11.76 | 3 (0) | +20% | 2014.43 | uninformative |
| idle-home | Idle WindowServer CPU points | -0.07 | -0.43 … 0.00 | 3 (0) | — | 35.73 | info |
| sidebar-scroll | Frame p95 ms | -0.15 | -0.63 … 0.36 | 3 (0) | +1.5 | 1.05 | pass |
| sidebar-scroll | Intervals > 33 ms per 45 s | 0.00 | 0.00 … 0.00 | 3 (0) | +2 | 0.00 | pass |
| sidebar-scroll | GPUIX CPU points | -1.66 | -2.26 … -0.06 | 3 (0) | +5 | 0.60 | pass |
| sidebar-scroll | GPUIX CPU ms / frame (%) | -3.30% | -4.85 … -0.23 | 3 (0) | +10% | 1.21 | pass |
| sidebar-scroll | GPUIX GPU ms / frame (%) | -5.31% | -10.63 … 1.54 | 3 (0) | +15% | 1.72 | pass |
| sidebar-scroll | WindowServer CPU points | 3.32 | 2.72 … 6.01 | 3 (0) | +4 | 30.91 | uninformative |
| sidebar-scroll | WindowServer GPU ms (%) | 132.59% | 117.20 … 144.53 | 3 (0) | +20% | 180.87 | uninformative |
| sidebar-scroll | Submissions per 15 s window (%) | 0.00% | 0.00 … 0.11 | 3 (0) | — | 0.11 | info |
| sidebar-scroll | GPUIX GPU ms per window (%) | -5.31% | -10.63 … 1.54 | 3 (0) | — | 1.61 | info |
| sidebar-scroll | GPUIX MiB | 3.00 | -19.00 … 5.00 | 3 (0) | — | 18.00 | info |
| streaming | Frame p95 ms | -0.62 | -4.82 … 0.25 | 3 (0) | +1.5 | 0.48 | pass |
| streaming | Intervals > 33 ms per 45 s | -1.00 | -20.00 … 0.00 | 3 (0) | +2 | 0.00 | pass |
| streaming | GPUIX CPU points | -0.09 | -0.31 … 5.77 | 3 (0) | +5 | 9.04 | uninformative |
| streaming | GPUIX CPU ms / frame (%) | -0.13% | -0.76 … 17.02 | 3 (0) | +10% | 26.73 | uninformative |
| streaming | GPUIX GPU ms / frame (%) | -7.85% | -23.91 … -7.65 | 3 (0) | +15% | 0.08 | pass |
| streaming | WindowServer CPU points | 3.05 | 1.39 … 3.32 | 3 (0) | +4 | 0.07 | pass |
| streaming | WindowServer GPU ms (%) | 102.15% | 78.70 … 103.13 | 3 (0) | +20% | -0.06 | **FAIL** |
| streaming | Submissions per 15 s window (%) | 0.00% | 0.00 … 0.00 | 3 (0) | — | 0.00 | info |
| streaming | GPUIX GPU ms per window (%) | -7.85% | -23.83 … -7.61 | 3 (0) | — | 0.08 | info |
| streaming | GPUIX MiB | -1.00 | -12.00 … 2.00 | 3 (0) | — | -7.00 | info |
| thread-scroll | Frame p95 ms | -0.07 | -0.93 … 0.35 | 3 (0) | +1.5 | 0.12 | pass |
| thread-scroll | Intervals > 33 ms per 45 s | 0.00 | 0.00 … 0.00 | 3 (0) | +2 | 0.00 | pass |
| thread-scroll | GPUIX CPU points | -3.00 | -3.06 … -1.06 | 3 (0) | +5 | 1.73 | pass |
| thread-scroll | GPUIX CPU ms / frame (%) | -5.91% | -6.15 … -2.23 | 3 (0) | +10% | 3.35 | pass |
| thread-scroll | GPUIX GPU ms / frame (%) | -5.42% | -9.70 … 5.06 | 3 (0) | +15% | 17.27 | uninformative |
| thread-scroll | WindowServer CPU points | 2.52 | -2.94 … 3.26 | 3 (0) | +4 | 0.93 | pass |
| thread-scroll | WindowServer GPU ms (%) | 99.36% | 50.58 … 121.76 | 3 (0) | +20% | 6.18 | **FAIL** |
| thread-scroll | Submissions per 15 s window (%) | 0.00% | -0.11 … 0.11 | 3 (0) | — | 0.11 | info |
| thread-scroll | GPUIX GPU ms per window (%) | -5.31% | -9.81 … 5.06 | 3 (0) | — | 17.27 | info |
| thread-scroll | GPUIX MiB | 2.00 | 0.00 … 6.00 | 3 (0) | — | 6.00 | info |

CPU rule (points AND per-frame must both fail): sidebar-scroll: pass; streaming: uninformative; thread-scroll: pass.
**sidebar vs solid: FAILS — streaming WindowServer GPU ms (%); thread-scroll WindowServer GPU ms (%).** Uninformative this session (A/A reaches the limit): idle-home Idle WindowServer GPU ms (%); sidebar-scroll WindowServer CPU points; sidebar-scroll WindowServer GPU ms (%); streaming GPUIX CPU points; streaming GPUIX CPU ms / frame (%); thread-scroll GPUIX GPU ms / frame (%).

##### solid-aa − solid (A/A control: the same mode twice)

Δ is the median of per-round paired differences, with a 90% bootstrap CI over rounds. Percent rows are relative to the base arm. A/A upper is the A/A CI upper bound for that metric.

| Scenario | Metric | Δ | 90% CI | Pairs (invalid) | Limit | A/A upper | Result |
|---|---|---:|---|---:|---:|---:|---|
| idle-home | Idle CPU points | 0.99 | -0.06 … 1.06 | 3 (0) | +1.5 | — | pass |
| idle-home | Idle MiB | 4.00 | -22.00 … 15.00 | 3 (0) | +15 | — | pass |
| idle-home | Idle WindowServer GPU ms (%) | 0.63% | -11.79 … 2014.43 | 3 (0) | +20% | — | unresolved |
| idle-home | Idle WindowServer CPU points | 2.85 | -0.07 … 35.73 | 3 (0) | — | — | info |
| sidebar-scroll | Frame p95 ms | 0.07 | -0.56 … 1.05 | 3 (0) | +1.5 | — | pass |
| sidebar-scroll | Intervals > 33 ms per 45 s | 0.00 | 0.00 … 0.00 | 3 (0) | +2 | — | pass |
| sidebar-scroll | GPUIX CPU points | 0.13 | -3.13 … 0.60 | 3 (0) | +5 | — | pass |
| sidebar-scroll | GPUIX CPU ms / frame (%) | 0.28% | -5.60 … 1.21 | 3 (0) | +10% | — | pass |
| sidebar-scroll | GPUIX GPU ms / frame (%) | -0.41% | -11.09 … 1.72 | 3 (0) | +15% | — | pass |
| sidebar-scroll | WindowServer CPU points | 9.45 | 0.13 … 30.91 | 3 (0) | +4 | — | unresolved |
| sidebar-scroll | WindowServer GPU ms (%) | 56.11% | 1.30 … 180.87 | 3 (0) | +20% | — | unresolved |
| sidebar-scroll | Submissions per 15 s window (%) | 0.00% | -0.55 … 0.11 | 3 (0) | — | — | info |
| sidebar-scroll | GPUIX GPU ms per window (%) | -0.52% | -11.69 … 1.61 | 3 (0) | — | — | info |
| sidebar-scroll | GPUIX MiB | 13.00 | -9.00 … 18.00 | 3 (0) | — | — | info |
| streaming | Frame p95 ms | -1.24 | -4.74 … 0.48 | 3 (0) | +1.5 | — | pass |
| streaming | Intervals > 33 ms per 45 s | -1.00 | -20.00 … 0.00 | 3 (0) | +2 | — | pass |
| streaming | GPUIX CPU points | -0.03 | -0.71 … 9.04 | 3 (0) | +5 | — | unresolved |
| streaming | GPUIX CPU ms / frame (%) | 0.00% | -1.65 … 26.73 | 3 (0) | +10% | — | unresolved |
| streaming | GPUIX GPU ms / frame (%) | -0.23% | -11.08 … 0.08 | 3 (0) | +15% | — | pass |
| streaming | WindowServer CPU points | -0.40 | -0.60 … 0.07 | 3 (0) | +4 | — | pass |
| streaming | WindowServer GPU ms (%) | -1.25% | -7.43 … -0.06 | 3 (0) | +20% | — | pass |
| streaming | Submissions per 15 s window (%) | 0.00% | 0.00 … 0.00 | 3 (0) | — | — | info |
| streaming | GPUIX GPU ms per window (%) | -0.23% | -10.98 … 0.08 | 3 (0) | — | — | info |
| streaming | GPUIX MiB | -10.00 | -12.00 … -7.00 | 3 (0) | — | — | info |
| thread-scroll | Frame p95 ms | -0.76 | -0.84 … 0.12 | 3 (0) | +1.5 | — | pass |
| thread-scroll | Intervals > 33 ms per 45 s | 0.00 | 0.00 … 0.00 | 3 (0) | +2 | — | pass |
| thread-scroll | GPUIX CPU points | -3.19 | -3.25 … 1.73 | 3 (0) | +5 | — | pass |
| thread-scroll | GPUIX CPU ms / frame (%) | -6.40% | -6.53 … 3.35 | 3 (0) | +10% | — | pass |
| thread-scroll | GPUIX GPU ms / frame (%) | 3.48% | -1.48 … 17.27 | 3 (0) | +15% | — | unresolved |
| thread-scroll | WindowServer CPU points | -0.86 | -8.04 … 0.93 | 3 (0) | +4 | — | pass |
| thread-scroll | WindowServer GPU ms (%) | -11.77% | -29.38 … 6.18 | 3 (0) | +20% | — | pass |
| thread-scroll | Submissions per 15 s window (%) | 0.00% | 0.00 … 0.11 | 3 (0) | — | — | info |
| thread-scroll | GPUIX GPU ms per window (%) | 3.48% | -1.37 … 17.27 | 3 (0) | — | — | info |
| thread-scroll | GPUIX MiB | 3.00 | 2.00 … 6.00 | 3 (0) | — | — | info |

CPU rule (points AND per-frame must both fail): sidebar-scroll: pass; streaming: unresolved; thread-scroll: pass.
**solid-aa vs solid: no metric fails.**

### Secondary session (single fill, blur Auto)

Windows: 96 (96 ok); warm-up round 0 excluded from every table.

###### Absolute values (median over rounds of block medians)

| Scenario | Arm | Frame p95 ms | Intervals > 33 ms per 45 s | GPUIX CPU points | GPUIX CPU ms/frame | GPUIX GPU ms/frame | WindowServer CPU points | WindowServer GPU ms | Submissions per 15 s window | GPUIX MiB | Idle CPU points | Idle MiB | Idle WindowServer GPU ms | Idle WindowServer CPU points |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| thread-scroll | solid | 17.60 | 0.00 | 38.24 | 6.37 | 3.42 | 44.81 | 3408 | 902 | 251.00 |  |  |  |  |
| thread-scroll | sidebar | 18.72 | 0.00 | 37.93 | 6.32 | 2.59 | 45.92 | 4308 | 902 | 261.00 |  |  |  |  |
| thread-scroll | window-auto | 17.86 | 0.00 | 38.77 | 6.46 | 1.48 | 38.97 | 3251 | 902 | 262.00 |  |  |  |  |
| thread-scroll | sidebar-sf | 17.92 | 0.00 | 47.15 | 7.85 | 2.91 | 42.63 | 3023 | 902 | 261.00 |  |  |  |  |
| thread-scroll | solid-sf | 17.51 | 0.00 | 41.78 | 6.95 | 2.59 | 47.76 | 3390 | 901 | 254.00 |  |  |  |  |
| streaming | solid | 19.70 | 30.00 | 41.88 | 6.98 | 3.36 | 49.66 | 1760 | 901 | 249.00 |  |  |  |  |
| streaming | sidebar | 25.30 | 15.00 | 42.73 | 7.13 | 3.01 | 48.18 | 3577 | 901 | 251.00 |  |  |  |  |
| streaming | window-auto | 25.95 | 42.00 | 40.49 | 6.76 | 1.66 | 46.74 | 3548 | 901 | 251.00 |  |  |  |  |
| streaming | sidebar-sf | 25.70 | 0.00 | 42.03 | 7.01 | 2.58 | 47.34 | 3185 | 901 | 253.00 |  |  |  |  |
| streaming | solid-sf | 23.97 | 3.00 | 42.29 | 7.04 | 2.94 | 50.14 | 1803 | 901 | 250.00 |  |  |  |  |

Idle invariant (submissions and GPUIX GPU ms stay 0): 0/0 windows at 0.

##### sidebar-sf − sidebar

Δ is the median of per-round paired differences, with a 90% bootstrap CI over rounds. Percent rows are relative to the base arm. A/A upper is the A/A CI upper bound for that metric.

| Scenario | Metric | Δ | 90% CI | Pairs (invalid) | Limit | A/A upper | Result |
|---|---|---:|---|---:|---:|---:|---|
| thread-scroll | Frame p95 ms | -0.79 | -1.96 … 0.27 | 3 (0) | +1.5 | — | pass |
| thread-scroll | Intervals > 33 ms per 45 s | 0.00 | 0.00 … 0.00 | 3 (0) | +2 | — | pass |
| thread-scroll | GPUIX CPU points | 8.93 | -2.79 … 17.42 | 3 (0) | +5 | — | unresolved |
| thread-scroll | GPUIX CPU ms / frame (%) | 23.36% | -7.31 … 50.61 | 3 (0) | +10% | — | unresolved |
| thread-scroll | GPUIX GPU ms / frame (%) | 15.51% | -17.66 … 30.55 | 3 (0) | +15% | — | unresolved |
| thread-scroll | WindowServer CPU points | -1.04 | -12.77 … 7.13 | 3 (0) | +4 | — | unresolved |
| thread-scroll | WindowServer GPU ms (%) | -3.87% | -38.57 … -0.08 | 3 (0) | +20% | — | pass |
| thread-scroll | Submissions per 15 s window (%) | 0.00% | -0.11 … 0.11 | 3 (0) | — | — | info |
| thread-scroll | GPUIX GPU ms per window (%) | 15.38% | -17.66 … 30.55 | 3 (0) | — | — | info |
| thread-scroll | GPUIX MiB | 0.00 | -6.00 … 2.00 | 3 (0) | — | — | info |
| streaming | Frame p95 ms | 0.40 | -13.98 … 6.12 | 3 (0) | +1.5 | — | unresolved |
| streaming | Intervals > 33 ms per 45 s | -15.00 | -61.00 … 0.00 | 3 (0) | +2 | — | pass |
| streaming | GPUIX CPU points | -0.70 | -13.94 … -0.08 | 3 (0) | +5 | — | pass |
| streaming | GPUIX CPU ms / frame (%) | -1.70% | -36.05 … -0.23 | 3 (0) | +10% | — | pass |
| streaming | GPUIX GPU ms / frame (%) | -13.51% | -22.66 … -13.43 | 3 (0) | +15% | — | pass |
| streaming | WindowServer CPU points | -2.63 | -4.05 … -0.07 | 3 (0) | +4 | — | pass |
| streaming | WindowServer GPU ms (%) | -5.33% | -11.25 … -3.40 | 3 (0) | +20% | — | pass |
| streaming | Submissions per 15 s window (%) | 0.11% | -0.11 … 0.11 | 3 (0) | — | — | info |
| streaming | GPUIX GPU ms per window (%) | -13.43% | -22.58 … -13.32 | 3 (0) | — | — | info |
| streaming | GPUIX MiB | 4.00 | 0.00 … 6.00 | 3 (0) | — | — | info |

CPU rule (points AND per-frame must both fail): thread-scroll: unresolved; streaming: pass.
**sidebar-sf vs sidebar: no metric fails.**

##### sidebar-sf − solid

Δ is the median of per-round paired differences, with a 90% bootstrap CI over rounds. Percent rows are relative to the base arm. A/A upper is the A/A CI upper bound for that metric.

| Scenario | Metric | Δ | 90% CI | Pairs (invalid) | Limit | A/A upper | Result |
|---|---|---:|---|---:|---:|---:|---|
| thread-scroll | Frame p95 ms | -0.04 | -0.19 … 0.45 | 3 (0) | +1.5 | — | pass |
| thread-scroll | Intervals > 33 ms per 45 s | 0.00 | 0.00 … 0.00 | 3 (0) | +2 | — | pass |
| thread-scroll | GPUIX CPU points | -0.32 | -3.10 … 19.13 | 3 (0) | +5 | — | unresolved |
| thread-scroll | GPUIX CPU ms / frame (%) | -0.67% | -8.11 … 58.62 | 3 (0) | +10% | — | unresolved |
| thread-scroll | GPUIX GPU ms / frame (%) | -12.35% | -26.15 … -4.72 | 3 (0) | +15% | — | pass |
| thread-scroll | WindowServer CPU points | -4.31 | -11.66 … 2.52 | 3 (0) | +4 | — | pass |
| thread-scroll | WindowServer GPU ms (%) | -4.30% | -22.45 … 26.29 | 3 (0) | +20% | — | unresolved |
| thread-scroll | Submissions per 15 s window (%) | 0.00% | 0.00 … 0.00 | 3 (0) | — | — | info |
| thread-scroll | GPUIX GPU ms per window (%) | -12.35% | -26.23 … -4.82 | 3 (0) | — | — | info |
| thread-scroll | GPUIX MiB | 1.00 | -6.00 … 11.00 | 3 (0) | — | — | info |
| streaming | Frame p95 ms | 2.13 | -0.14 … 6.24 | 3 (0) | +1.5 | — | unresolved |
| streaming | Intervals > 33 ms per 45 s | -30.00 | -59.00 … -1.00 | 3 (0) | +2 | — | pass |
| streaming | GPUIX CPU points | -0.59 | -17.12 … 4.10 | 3 (0) | +5 | — | pass |
| streaming | GPUIX CPU ms / frame (%) | -1.27% | -40.90 … 10.44 | 3 (0) | +10% | — | unresolved |
| streaming | GPUIX GPU ms / frame (%) | -22.57% | -27.86 … -21.04 | 3 (0) | +15% | — | pass |
| streaming | WindowServer CPU points | -2.20 | -4.11 … 1.15 | 3 (0) | +4 | — | pass |
| streaming | WindowServer GPU ms (%) | 83.84% | 39.20 … 133.00 | 3 (0) | +20% | — | **FAIL** |
| streaming | Submissions per 15 s window (%) | 0.00% | -0.11 … 0.11 | 3 (0) | — | — | info |
| streaming | GPUIX GPU ms per window (%) | -22.57% | -27.86 … -20.96 | 3 (0) | — | — | info |
| streaming | GPUIX MiB | 4.00 | 4.00 … 8.00 | 3 (0) | — | — | info |

CPU rule (points AND per-frame must both fail): thread-scroll: unresolved; streaming: unresolved.
**sidebar-sf vs solid: FAILS — streaming WindowServer GPU ms (%).**

##### solid-sf − solid

Δ is the median of per-round paired differences, with a 90% bootstrap CI over rounds. Percent rows are relative to the base arm. A/A upper is the A/A CI upper bound for that metric.

| Scenario | Metric | Δ | 90% CI | Pairs (invalid) | Limit | A/A upper | Result |
|---|---|---:|---|---:|---:|---:|---|
| thread-scroll | Frame p95 ms | -0.21 | -1.17 … 2.27 | 3 (0) | +1.5 | — | unresolved |
| thread-scroll | Intervals > 33 ms per 45 s | 0.00 | 0.00 … 0.00 | 3 (0) | +2 | — | pass |
| thread-scroll | GPUIX CPU points | 3.23 | -4.94 … 3.54 | 3 (0) | +5 | — | pass |
| thread-scroll | GPUIX CPU ms / frame (%) | 9.06% | -10.37 … 9.83 | 3 (0) | +10% | — | pass |
| thread-scroll | GPUIX GPU ms / frame (%) | -24.26% | -26.04 … -2.03 | 3 (0) | +15% | — | pass |
| thread-scroll | WindowServer CPU points | 1.71 | -5.40 … 3.74 | 3 (0) | +4 | — | pass |
| thread-scroll | WindowServer GPU ms (%) | -0.53% | -25.04 … 21.36 | 3 (0) | +20% | — | unresolved |
| thread-scroll | Submissions per 15 s window (%) | -0.11% | -0.11 … 0.11 | 3 (0) | — | — | info |
| thread-scroll | GPUIX GPU ms per window (%) | -24.18% | -26.12 … -2.25 | 3 (0) | — | — | info |
| thread-scroll | GPUIX MiB | 3.00 | -22.00 … 5.00 | 3 (0) | — | — | info |
| streaming | Frame p95 ms | 4.26 | -5.68 … 14.74 | 3 (0) | +1.5 | — | unresolved |
| streaming | Intervals > 33 ms per 45 s | -1.00 | -27.00 … 47.00 | 3 (0) | +2 | — | unresolved |
| streaming | GPUIX CPU points | 0.60 | -6.19 … 2.26 | 3 (0) | +5 | — | pass |
| streaming | GPUIX CPU ms / frame (%) | 1.55% | -14.33 … 5.65 | 3 (0) | +10% | — | pass |
| streaming | GPUIX GPU ms / frame (%) | -12.59% | -13.14 … -6.82 | 3 (0) | +15% | — | pass |
| streaming | WindowServer CPU points | 1.00 | -3.74 … 3.95 | 3 (0) | +4 | — | pass |
| streaming | WindowServer GPU ms (%) | -1.02% | -12.47 … 2.43 | 3 (0) | +20% | — | pass |
| streaming | Submissions per 15 s window (%) | 0.00% | 0.00 … 0.00 | 3 (0) | — | — | info |
| streaming | GPUIX GPU ms per window (%) | -12.59% | -13.04 … -6.92 | 3 (0) | — | — | info |
| streaming | GPUIX MiB | -1.00 | -3.00 … 3.00 | 3 (0) | — | — | info |

CPU rule (points AND per-frame must both fail): thread-scroll: pass; streaming: pass.
**solid-sf vs solid: no metric fails.**

##### window-auto − sidebar

Δ is the median of per-round paired differences, with a 90% bootstrap CI over rounds. Percent rows are relative to the base arm. A/A upper is the A/A CI upper bound for that metric.

| Scenario | Metric | Δ | 90% CI | Pairs (invalid) | Limit | A/A upper | Result |
|---|---|---:|---|---:|---:|---:|---|
| thread-scroll | Frame p95 ms | -0.86 | -1.62 … -0.74 | 3 (0) | +1.5 | — | pass |
| thread-scroll | Intervals > 33 ms per 45 s | 0.00 | 0.00 … 0.00 | 3 (0) | +2 | — | pass |
| thread-scroll | GPUIX CPU points | 0.55 | -3.36 … 7.55 | 3 (0) | +5 | — | unresolved |
| thread-scroll | GPUIX CPU ms / frame (%) | 1.44% | -8.92 … 22.09 | 3 (0) | +10% | — | unresolved |
| thread-scroll | GPUIX GPU ms / frame (%) | -42.86% | -53.70 … -27.88 | 3 (0) | +15% | — | pass |
| thread-scroll | WindowServer CPU points | 0.03 | -8.60 … 3.47 | 3 (0) | +4 | — | pass |
| thread-scroll | WindowServer GPU ms (%) | 3.51% | -35.68 … 6.29 | 3 (0) | +20% | — | pass |
| thread-scroll | Submissions per 15 s window (%) | 0.00% | 0.00 … 0.00 | 3 (0) | — | — | info |
| thread-scroll | GPUIX GPU ms per window (%) | -42.86% | -53.70 … -27.88 | 3 (0) | — | — | info |
| thread-scroll | GPUIX MiB | -2.00 | -4.00 … 1.00 | 3 (0) | — | — | info |
| streaming | Frame p95 ms | 6.12 | -13.90 … 8.06 | 3 (0) | +1.5 | — | unresolved |
| streaming | Intervals > 33 ms per 45 s | 27.00 | -61.00 … 125.00 | 3 (0) | +2 | — | unresolved |
| streaming | GPUIX CPU points | -3.72 | -10.31 … 0.53 | 3 (0) | +5 | — | pass |
| streaming | GPUIX CPU ms / frame (%) | -8.31% | -26.72 … 1.24 | 3 (0) | +10% | — | pass |
| streaming | GPUIX GPU ms / frame (%) | -47.36% | -47.37 … -34.67 | 3 (0) | +15% | — | pass |
| streaming | WindowServer CPU points | -2.22 | -4.91 … 3.72 | 3 (0) | +4 | — | pass |
| streaming | WindowServer GPU ms (%) | -8.00% | -23.19 … 7.62 | 3 (0) | +20% | — | pass |
| streaming | Submissions per 15 s window (%) | 0.00% | 0.00 … 0.00 | 3 (0) | — | — | info |
| streaming | GPUIX GPU ms per window (%) | -47.31% | -47.31 … -34.67 | 3 (0) | — | — | info |
| streaming | GPUIX MiB | -4.00 | -10.00 … 12.00 | 3 (0) | — | — | info |

CPU rule (points AND per-frame must both fail): thread-scroll: unresolved; streaming: pass.
**window-auto vs sidebar: no metric fails.**

##### window-auto − solid

Δ is the median of per-round paired differences, with a 90% bootstrap CI over rounds. Percent rows are relative to the base arm. A/A upper is the A/A CI upper bound for that metric.

| Scenario | Metric | Δ | 90% CI | Pairs (invalid) | Limit | A/A upper | Result |
|---|---|---:|---|---:|---:|---:|---|
| thread-scroll | Frame p95 ms | 0.30 | -1.20 … 0.39 | 3 (0) | +1.5 | — | pass |
| thread-scroll | Intervals > 33 ms per 45 s | 0.00 | 0.00 … 0.00 | 3 (0) | +2 | — | pass |
| thread-scroll | GPUIX CPU points | -3.67 | -8.70 … 9.26 | 3 (0) | +5 | — | unresolved |
| thread-scroll | GPUIX CPU ms / frame (%) | -9.70% | -18.33 … 28.59 | 3 (0) | +10% | — | unresolved |
| thread-scroll | GPUIX GPU ms / frame (%) | -56.65% | -59.20 … -46.43 | 3 (0) | +15% | — | pass |
| thread-scroll | WindowServer CPU points | -7.49 | -7.97 … 3.59 | 3 (0) | +4 | — | pass |
| thread-scroll | WindowServer GPU ms (%) | 0.20% | -14.25 … 30.82 | 3 (0) | +20% | — | unresolved |
| thread-scroll | Submissions per 15 s window (%) | 0.00% | -0.11 … 0.11 | 3 (0) | — | — | info |
| thread-scroll | GPUIX GPU ms per window (%) | -56.60% | -59.25 … -46.49 | 3 (0) | — | — | info |
| thread-scroll | GPUIX MiB | -3.00 | -5.00 … 13.00 | 3 (0) | — | — | info |
| streaming | Frame p95 ms | 6.24 | -0.06 … 9.78 | 3 (0) | +1.5 | — | unresolved |
| streaming | Intervals > 33 ms per 45 s | 12.00 | -59.00 … 124.00 | 3 (0) | +2 | — | unresolved |
| streaming | GPUIX CPU points | 0.46 | -13.49 … 0.64 | 3 (0) | +5 | — | pass |
| streaming | GPUIX CPU ms / frame (%) | 1.49% | -32.29 … 1.68 | 3 (0) | +10% | — | pass |
| streaming | GPUIX GPU ms / frame (%) | -50.90% | -51.95 … -41.57 | 3 (0) | +15% | — | pass |
| streaming | WindowServer CPU points | -3.06 | -3.70 … 4.94 | 3 (0) | +4 | — | unresolved |
| streaming | WindowServer GPU ms (%) | 104.82% | 20.48 … 126.45 | 3 (0) | +20% | — | **FAIL** |
| streaming | Submissions per 15 s window (%) | 0.00% | -0.11 … 0.00 | 3 (0) | — | — | info |
| streaming | GPUIX GPU ms per window (%) | -50.90% | -51.95 … -41.57 | 3 (0) | — | — | info |
| streaming | GPUIX MiB | 0.00 | -8.00 … 12.00 | 3 (0) | — | — | info |

CPU rule (points AND per-frame must both fail): thread-scroll: unresolved; streaming: pass.
**window-auto vs solid: FAILS — streaming WindowServer GPU ms (%).**

##### sidebar − solid

Δ is the median of per-round paired differences, with a 90% bootstrap CI over rounds. Percent rows are relative to the base arm. A/A upper is the A/A CI upper bound for that metric.

| Scenario | Metric | Δ | 90% CI | Pairs (invalid) | Limit | A/A upper | Result |
|---|---|---:|---|---:|---:|---:|---|
| thread-scroll | Frame p95 ms | 1.24 | -0.46 … 1.92 | 3 (0) | +1.5 | — | unresolved |
| thread-scroll | Intervals > 33 ms per 45 s | 0.00 | 0.00 … 0.00 | 3 (0) | +2 | — | pass |
| thread-scroll | GPUIX CPU points | -0.31 | -9.25 … 1.71 | 3 (0) | +5 | — | pass |
| thread-scroll | GPUIX CPU ms / frame (%) | -0.85% | -19.49 … 5.32 | 3 (0) | +10% | — | pass |
| thread-scroll | GPUIX GPU ms / frame (%) | -24.12% | -43.43 … 15.72 | 3 (0) | +15% | — | unresolved |
| thread-scroll | WindowServer CPU points | 1.11 | -11.44 … 3.56 | 3 (0) | +4 | — | pass |
| thread-scroll | WindowServer GPU ms (%) | 26.39% | -19.33 … 55.78 | 3 (0) | +20% | — | unresolved |
| thread-scroll | Submissions per 15 s window (%) | 0.00% | -0.11 … 0.11 | 3 (0) | — | — | info |
| thread-scroll | GPUIX GPU ms per window (%) | -24.04% | -43.49 … 15.59 | 3 (0) | — | — | info |
| thread-scroll | GPUIX MiB | -1.00 | -6.00 … 17.00 | 3 (0) | — | — | info |
| streaming | Frame p95 ms | 1.72 | 0.12 … 13.84 | 3 (0) | +1.5 | — | unresolved |
| streaming | Intervals > 33 ms per 45 s | -1.00 | -15.00 … 2.00 | 3 (0) | +2 | — | pass |
| streaming | GPUIX CPU points | 0.11 | -3.18 … 4.18 | 3 (0) | +5 | — | pass |
| streaming | GPUIX CPU ms / frame (%) | 0.44% | -7.59 … 10.69 | 3 (0) | +10% | — | unresolved |
| streaming | GPUIX GPU ms / frame (%) | -8.71% | -10.56 … -6.71 | 3 (0) | +15% | — | pass |
| streaming | WindowServer CPU points | 1.22 | -1.48 … 1.85 | 3 (0) | +4 | — | pass |
| streaming | WindowServer GPU ms (%) | 90.31% | 56.84 … 146.13 | 3 (0) | +20% | — | **FAIL** |
| streaming | Submissions per 15 s window (%) | 0.00% | -0.11 … 0.00 | 3 (0) | — | — | info |
| streaming | GPUIX GPU ms per window (%) | -8.81% | -10.56 … -6.82 | 3 (0) | — | — | info |
| streaming | GPUIX MiB | 2.00 | 0.00 … 4.00 | 3 (0) | — | — | info |

CPU rule (points AND per-frame must both fail): thread-scroll: pass; streaming: unresolved.
**sidebar vs solid: FAILS — streaming WindowServer GPU ms (%).**

### Light theme streaming

Windows: 21 (21 ok); warm-up round 0 excluded from every table.

###### Absolute values (median over rounds of block medians)

| Scenario | Arm | Frame p95 ms | Intervals > 33 ms per 45 s | GPUIX CPU points | GPUIX CPU ms/frame | GPUIX GPU ms/frame | WindowServer CPU points | WindowServer GPU ms | Submissions per 15 s window | GPUIX MiB | Idle CPU points | Idle MiB | Idle WindowServer GPU ms | Idle WindowServer CPU points |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| streaming | solid-light | 24.83 | 23.00 | 21.54 | 4.13 | 3.36 | 45.02 | 1965 | 901 | 255.00 |  |  |  |  |
| streaming | window-light | 27.63 | 14.00 | 30.85 | 5.38 | 1.54 | 46.14 | 3821 | 901 | 250.00 |  |  |  |  |

Idle invariant (submissions and GPUIX GPU ms stay 0): 0/0 windows at 0.

##### window-light − solid-light

Δ is the median of per-round paired differences, with a 90% bootstrap CI over rounds. Percent rows are relative to the base arm. A/A upper is the A/A CI upper bound for that metric.

| Scenario | Metric | Δ | 90% CI | Pairs (invalid) | Limit | A/A upper | Result |
|---|---|---:|---|---:|---:|---:|---|
| streaming | Frame p95 ms | 4.95 | 4.58 … 5.31 | 2 (1) | +1.5 | — | insufficient |
| streaming | Intervals > 33 ms per 45 s | 22.50 | 14.00 … 31.00 | 2 (1) | +2 | — | insufficient |
| streaming | GPUIX CPU points | 0.77 | -3.79 … 5.32 | 2 (1) | +5 | — | insufficient |
| streaming | GPUIX CPU ms / frame (%) | 7.85% | -8.99 … 24.70 | 2 (1) | +10% | — | insufficient |
| streaming | GPUIX GPU ms / frame (%) | -54.92% | -59.16 … -50.69 | 2 (1) | +15% | — | insufficient |
| streaming | WindowServer CPU points | 1.67 | -2.38 … 5.72 | 2 (1) | +4 | — | insufficient |
| streaming | WindowServer GPU ms (%) | 93.29% | 48.53 … 138.05 | 2 (1) | +20% | — | insufficient |
| streaming | Submissions per 15 s window (%) | 0.00% | 0.00 … 0.00 | 2 (1) | — | — | info |
| streaming | GPUIX GPU ms per window (%) | -54.92% | -59.16 … -50.69 | 2 (1) | — | — | info |
| streaming | GPUIX MiB | 1.50 | -5.00 … 8.00 | 2 (1) | — | — | info |

CPU rule (points AND per-frame must both fail): streaming: insufficient.
**window-light vs solid-light: no metric fails.** 7 metrics have fewer than 3 valid pairs and are insufficient, not passed.
