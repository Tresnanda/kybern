# 0.4.3 integration review

Integration PR: https://github.com/Tresnanda/kybern/pull/31

The starting main revision was `abb8448` (0.4.2). The isolated
`release/0.4.3-reviewed` worktree preserves the original checkout and its
untracked files. Cargo targets and test data are isolated. No installed binary
or production daemon database was replaced.

## Included candidates

| PR | Reviewed head | Integration |
| --- | --- | --- |
| #23 | `8857eb55c6024a4dfb612c42cf55f872bfae2bdf` | Exact-commit release CI gate; merged ancestry |
| #24 | `1904f8625200bf8b68d1ac96a6d0758d6d064cbd` | Superseded by corrected implementation in #30 |
| #27 | `c85f3bfd35c0fa55d3a99eccbaf86ae6de9479b2` | Hugeicons and usage/integration changes; merged ancestry |
| #28 | `19de5debb5abc9660d365604c303b371837e7d7f` | Superseded by mounted leases and snapshot-safe hydration in #30 |
| #29 | `3caabb8236e305836d2606748c916fb70e6b4d55` | Daemon-only jemalloc; merged ancestry |
| #30 | `ca09481857d3da0bda819b1b0caa169b90ca8a7e` | Reviewed consolidated memory implementation; merged ancestry |

The archive integration, installer compatibility checks, real store tests,
protocol compatibility, and original matched daemon measurements are documented
in [the consolidated report](memory-review-2026-09-17/REPORT.md).
PR #29's historical percentages and #30's percentages use different workloads
and must not be added together.

## Corrections during integration

`e65bb96` scopes Usage page account-limit responses to their environment.
Previously a successful result could survive an environment switch and remain
visible indefinitely when the next daemon rejected the newer method. A native
production-CSP fixture checks immediate isolation, older-daemon failure, and a
late response arriving after another switch. CI runs that fixture.

Native diagnostics in `00ed400` identified the macOS 15 CI failure: the
entry mounted with **zero loaded stylesheets**, so the unstyled transcript
initially measured 280,952 px high. At the next sample its styles had loaded,
but initial virtualization/anchoring was already invalid. The speculative
percentage-height (`2716e55`) and absolute-layout (`c49e524`) changes did not fix
this and were reverted. `d871d92` places extracted stylesheet links before the
module entry in both production and fixture HTML. CI on `bf4018a` passes both scaling and history retention with styled layout;
thresholds have not been relaxed.

Actual Tauri validation also exposed an end-follow failure after scrolling
history and opening a terminal dock. A new native history test reproduced it:
explicit return to latest followed by a smaller pane left a 473 px gap. The
button bypassed MessageScroller's follow state, and layout-generated scroll
events could disable following before resize reconciliation. The correction
resumes through the scroller, follows viewport resize, and leaves following on
reader input rather than layout notifications. The broader work-stream fixture
caught a click/upward-gesture race in an initial asynchronous correction; the
synchronous controller in `9d803c8` passes both fixtures. `bf4018a` also pins
live selection endpoints before row removal: WebKit may queue `selectionchange`
until after a transcript update. The macOS 15 history fixture then passes
selection retention. Shift-Space reading is covered explicitly.

A final accessibility regression check exposed native scroll actions that move
scrollTop without DOM wheel/key/pointer events. While an automatic end target
was settling, the scroller could ignore that upward movement and pull the reader
back. The final correction cancels that target when the cursor moves upward in
an unchanged viewport; resizing alone does not cancel following. Explicit
resume restores native scrolling back to the bottom. Both accessibility
checks, the dock-resize fixture, and the immediate-upward-gesture streaming
fixture pass. The last streaming rerun recorded 19 ms frame p95, 16 ms input p95,
5 ms commit p95, exact output, no overlaps, and zero chrome invalidations for
100 text deltas. This final small follow correction was not part of the
incomplete `bf4018a` full-Tauri measurement. CI on `d09cb23` exposed an initial
virtualizer correction that was mistaken for accessibility input, leaving a
105 px gap. VirtualRows now records its own applied scroll positions in a
weak-keyed map; the scroller excludes those writes from reader-input detection.
This preserves initial reconciliation as well as native accessibility
cancellation. Local interaction and history-retention fixtures pass together;
the failed CI attempt is retained. The full five-job gate passed at
`f205a96d80d3e61d11ae7d7436e010c3c318bdeb`
([CI run](https://github.com/Tresnanda/kybern/actions/runs/35182163274)),
including native macOS 15 history, scaling, and interaction checks.

Local native scaling at `d871d92`: 8 mounted messages, 45 ms mount commit,
18 ms streaming frame-interval p95, 14 ms input-frame p95, 1 ms final commit.
History retention passed at 1100 and 480 px with zero anchor shift, selection,
focus, identity, reload, and dock-resize checks. Native interaction passed wheel,
keyboard, scrollbar, touch, small upward gestures, and virtualized navigation.
These synthetic figures are not whole-app latency or memory guarantees.

## Verification status

- Desktop: 233 tests, typecheck, lint, and production frontend build passed.
- Rust: formatting, workspace Clippy, all non-live workspace tests, and 117
  driver unit tests passed. Full workspace execution also ran the seven live
  driver tests: five passed; two OpenCode tests failed with
  `ProviderNoProvidersError: No providers are available`. This is an installed
  harness configuration blocker; the OpenCode driver source is unchanged.
- Release daemon and sidecar-aware production Tauri app builds passed, including
  the corrected frontend at `bf4018a241cde1579327c83f6934cb69edc73aae`.
- Release gate: five tests passed; `cargo-dist 0.32.0 generate --check` passed.
- Memory sampler: four tests passed.
- Native production-CSP fixtures passed for interactions, scrolling (all 1,600
  scenario frames), tool leases, tool output memory, terminal lifecycle,
  Markdown memory, worker lifecycle, settings, profiles, icons, materials,
  integrations, updates, and formatted rendering. Initial work-stream execution
  timed out; after the follow-state correction it passed with 18 ms frame p95,
  17 ms input p95, 4 ms commit p95, exact stream sequence, no overlaps, and no
  thread-chrome invalidation for 100 text deltas. Thresholds are unchanged.
- Current desktop tests (233), typecheck, lint, and native selection/dock/keyboard
  fixtures pass. [CI at `bf4018a`](https://github.com/Tresnanda/kybern/actions/runs/35179709099)
  passed all five jobs, including macOS 15 native WebKit checks.
- The local 1,600-frame scrolling rerun at `bf4018a` passed every scenario with no empty
  frames, 18–19 ms frame p95, at most 25 ms worst frame, and at most 2.25 px
  visible anchor movement. Scaling, 480 px retention, and work-stream passed.
- The real-daemon tool-leases fixture now also invokes native WebKit Copy and
  verifies exact Unicode pasteboard contents, then restores the previous
  pasteboard. Copy crosses an asynchronous process boundary; an initial
  synchronous harness read failed and was corrected to wait for the response.
  Its complete 32-view/16-result lifecycle and real reconnect check passed.
- Final local frame-based reruns at `f205a96` did not complete: scrolling
  stopped at its first frame stage and scaling stopped after history setup.
  Read-only IORegistry inspection confirmed `CGSSessionScreenIsLocked=Yes`;
  these runs are incomplete, not passes. The lock screen was left unchanged.
  The corresponding macOS CI fixtures passed at that exact source revision.
- One earlier Linux driver-unit run failed intermittently in the unchanged
  Claude integration catalog test; two subsequent CI runs passed that suite.
  The original failure log is retained. Exact release-commit CI is pending.

## Native anchor investigation and correction

The final documentation-only rerun at `6d58bf3` failed the 480 px history-retention
fixture with `Reload preserves reading position: 63.171875px`
([run 35182644085](https://github.com/Tresnanda/kybern/actions/runs/35182644085)).
The preceding wide-window test passed. This is not classified as an unrelated
failure: at that stage its root cause and whether it reflected position movement or DOM
replacement were unconfirmed. No tolerance or acceptance criterion was
relaxed, and no production-code change has been made solely to obtain a pass.

Additional diagnostics record the existing anchor, topology size, and scroll
writes. Three narrow repetitions at `5e60eab` and ten at `8dfcfff` passed; both
complete five-job CI runs passed. The latter traces recorded 0–1 px residual
anchor movement. These passes do not prove that the intermittent failure is
fixed. A further ten repetitions at `fff44c573018db77188e1030691efca7f75805dc` also
passed, and [all five CI jobs](https://github.com/Tresnanda/kybern/actions/runs/35183957057)
completed successfully. That diagnostic checks whether a replacement row
occupies the original anchor position and avoids extra intermediate anchor
rectangles. Across the three diagnostic runs, 23 narrow repetitions passed
without a production fix; the original timing had not yet been reproduced.

After the Mac was unlocked, the default workload passed ten local repetitions.
Moving the reading point from 1,000 px to 100 px then reproduced a deterministic
failure: turn `t800` was unmounted and scrollTop remained 51 px after 40 older
turns were prepended. The persistent history-status row was selected as the
virtualizer's anchor; since that row never moved, the transcript was not rebased.
The status now sits outside the keyed transcript. Its eventual removal preserves
the reading position below it through the existing list-origin measurement.

That change exposed a second deterministic error: three newly mounted rows
were each 49 px shorter than estimated, moving the anchor 147 px. During commit,
measurement callbacks compared new row positions with the old DOM scrollTop,
instead of the virtualizer's already-rebased cursor. The correction preserves
that cursor while edge keys/count are being committed, then resumes the existing
DOM-relative wheel/trackpad adjustment. The 100 px reproducer now retains the
same connected row at exactly 9 px. Native coverage includes reading offsets
100, 200, 400, and 1,000 px, without changing tolerances. The isolated original
CI timing is not claimed to have been replayed exactly; the deterministic
prepend/measurement failures and their before/after traces are preserved.

The first macOS 15 run of that correction (`a00c262`) retained the anchor but
reported a 3.171875 px shift in the near-top case. Its trace exposed fractional
measurement corrections: synchronous mount measurement kept fractions while
the default ResizeObserver measurement rounded them. WebKit also rounded DOM
scroll writes, and using that rounded value as the next adjustment base lost
fractions repeatedly. The final correction uses the virtualizer's existing rounded-size policy in
both paths, including our forced synchronous scrolling measurement. A custom
fractional measurement callback introduced a 28 px cold-history jump; two
matched cold runs with the default callback passed at 1.03125 px. That custom
callback and the speculative preservation of ordinary scroll cursors were
removed. Ordinary corrections continue to use the current DOM position; only
the pending prepend/trim commit uses the virtualizer's rebased cursor. The fixture includes
fractional row geometry on every native runner. The failed run was cancelled
after collecting the failure so the correction can receive a complete new run;
it is not recorded as a pass.

Final source `308e35776274114950bf020439389b25b33dc6fa` passed all five
[CI jobs](https://github.com/Tresnanda/kybern/actions/runs/35187029505), including
eight narrow native repetitions at offsets 100/200/400/1,000 px and the wide test.
Local narrow shifts were 0.75/0.5/0.25/0 px; the full retention test stayed below
0.672 px. All 1,600 scrolling frames passed (maximum visible jump 0.5 px,
18–20 ms frame p95, 31 ms worst frame), as did interaction, scaling and
work-stream (18 ms frame p95, 16 ms input p95, 4 ms commit p95, exact final text,
no overlap or chrome invalidation). These are fixture-specific measurements.
Both the unchanged baseline and this corrected source then passed the production
sidecar-aware Tauri wrapper build. Runtime-isolated build hashes and native
measurements are recorded below. No failing threshold was weakened.

## Combined daemon changes: matched allocator comparison

Three alternating system/jemalloc pairs ran the same scratch-daemon workload
without compiler processes: 400 turns, 800 tools, 6,400 events, recent/history
pages, full output pages, ordered replay, terminal output, and ten seconds of
post-workload idle. Each run used a newly seeded database. Physical footprint
was sampled every 100 ms; the earliest sub-sample startup peak may be missed.
These are daemon-only figures and do not establish full-app responsiveness.

| Metric | #30 system allocator median (range) | Integrated jemalloc median (range) |
| --- | --- | --- |
| Initial idle, MiB | 5.67 (5.66–5.72) | 6.80 (6.78–6.86) |
| Sampled peak, MiB | 23.61 (23.55–25.66) | 21.55 (21.03–24.47) |
| Post-workload idle, MiB | 23.59 (23.53–25.66) | 21.53 (21.02–24.28) |
| Cold recent-page RPC, ms | 185.68 (149.75–187.08) | 185.28 (177.30–187.07) |
| Warm recent-page RPC, ms | 0.41 (0.40–0.42) | 0.43 (0.42–0.53) |
| Full-output page RPC, ms | 20.54 (20.01–20.91) | 21.51 (20.83–22.46) |

Jemalloc reduced median sampled peak by about 2.06 MiB (8.7%) and post-workload
idle by 2.06 MiB (8.7%), while initial idle increased by 1.13 MiB (19.9%). The
ranges overlap. The roughly 1 ms full-output RPC increase is reported rather
than hidden; three runs do not establish statistical significance. No timeout,
replay-order failure, or missing terminal output occurred. This modest additional
benefit must not be added to the earlier 88% baseline-to-#30 reduction.

System binary: `b7024bd400679d805525bcd92c58216ed9c6f61b` implementation,
SHA-256 `5e677dde6824ad26ffeefebbb3dd4b4f038594c7dbc4fff356bb2baebae85fd1`.
Integrated binary: `c49e5244e4e356285e7aada72b1d54ff38f68383` production build,
SHA-256 `01e3a8c35ace90194527bbd1f4c1f92426534a92f48a250efbb09d39520ff0be`.
Subsequent changes are frontend-only. Samples, latencies, binary hashes, and
summary are preserved as `allocator-*` artifacts in the original checkout.

## Actual Tauri measurement attempts

The unmodified `c85f3bf` release binaries saved before the archive integration
were launched with separate scratch databases. Each database contains 400
synthetic turns, 800 large Unicode outputs, and 6,400 events. No production
conversation data was copied.

`scripts/profile-tauri-coalition.py` identifies the launched executable and
its sibling daemon, then attributes WebContent, GPU, and networking helpers by
the shell's macOS resource coalition. It rediscovers processes every sample,
records kernel start identities, and rechecks identity/ownership to reject PID
reuse. The private read-only attribution ABI is described in Apple's
[proc_info_private.h](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info_private.h)
and [coalition.h](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/mach/coalition.h).

The sampler records RSS and physical footprint separately. A combined footprint
is a sum of per-process physical footprints, not a claim of unique physical RAM;
RSS can double-count shared mappings. Compiler processes, other browsers, agent
CLIs, and the unrelated production daemon do not qualify for the application
total. Missing shell, daemon, renderer, GPU, or networking coverage makes a
sample incomplete.

Two exploratory runs were excluded: the first began occluded in Stage Manager
and changed geometry; in the second the packaged GUI restarted and automation
lost the scratch window. A subsequent user-reserved profiling window allowed
one controlled baseline/candidate pair at 1440 × 900, without build tools or a
second Kybern GUI. The production daemon and agent work remained active and
were excluded from totals. The packaged GUI was restored afterward.

The pair used the preserved `c85f3bf` baseline and the `c49e524` candidate
production build (plus release-note-only working changes), on macOS 27.0
26A428, Apple M1 MacBookPro17,1, 16 GiB RAM, WebKit 22625.1.29.11.27. Both
were release builds with embedded assets, distinct ad-hoc-signed scratch bundle
identities, and dark appearance. The workload covered startup, initial idle,
thread interaction, a large Unicode tool result, four 12-page upward scrolls,
return to latest, terminal output (3,000 numbered Unicode lines), and idle.
Manual interaction pacing differed; this is one pair, not repeated statistical
validation. Real provider streaming is covered separately by native fixtures.

The candidate failed the final visual check: after opening the terminal dock,
it remained at examples 377–379 instead of the latest example 399. The baseline
reached 399. Consequently **this pair is not an accepted optimization result**.
Raw JSONL, phase labels, window geometry, screenshots, and vmmap summaries are
preserved under `perf-artifacts/memory-followup-20260917` in the original
conversation checkout. No difference or percentage is claimed from a candidate
that failed functionality. Retesting the corrected production build is pending.

For diagnostic transparency only, median renderer physical footprint during the
large-result phase was approximately 180 MiB in each run. Post-workload medians
were 251.2 MiB baseline and 259.5 MiB candidate. Those observations do **not**
support a renderer savings claim. The earlier 88% daemon-only reduction is not a
`tauri://localhost` renderer result. No graphics effect was removed.

The native `vmmap` snapshots also locate substantial graphics memory. At the
large-result stage, owned graphics dirty memory was 88.5 MiB in each diagnostic
run; WebKit malloc dirty memory was 83.5/85.6 MiB. During terminal output graphics
dirty memory was 125.8/125.6 MiB. The much larger graphics resident/reserved
figures are not interchangeable with physical footprint and are not counted as
savings. These snapshots and the existing tile/layer fixtures support preserving
the paint-host boundaries; no new graphics behavior change is justified by this
failed candidate pair.

## Corrected Tauri run and remaining measurement limitation

A second reserved window used fresh scratch data, explicit
`KYBERN_CLIENT_CONFIG_DIR`, `KYBERN_DATA_DIR`, and LaunchServices `open --env`
launches. A direct child-process launch had exited before automation attached;
its automatic relaunch lacked scratch configuration and selected the saved
environment registry. That attempt was stopped without workload actions and is
excluded. Both the data directory **and** client configuration must be isolated;
changing only the bundle display identity is insufficient.

The properly isolated baseline (`c85f3bf`) completed the full workload, with
example 399 and terminal line 2999 visually verified. The corrected candidate
(`bf4018a`) completed initial idle, thread loading, and the same expanded Unicode
result at the same 1440 × 900 geometry. During the next history-scroll action,
the CUA service timed out after approximately 120 seconds; further AX snapshot
and app-selection calls also timed out, including one requested with a 10-second
limit. The candidate WebContent sample was idle in its Mach run loop, and the
attributed processes reported 0% CPU at inspection. A window-only screenshot
still showed example 399 and the expanded result. This establishes an automation
blocker, **not** a completed history/dock/terminal test or proof of an app hang.
The candidate was stopped and the packaged GUI restored; daemon PID 1939
remained active. No third profiling window was requested.

The following are physical-footprint observations in MiB. Startup and workload
rows use the maximum sampled process footprint; idle rows use phase medians.
Combined values are simultaneous sums, so component maxima need not add to the
combined maximum. Manual phase duration differs; there is one partial pair and
no statistically established frontend saving. Incomplete rows are deliberately
not populated from a previous failed build or a differently scoped fixture.

| Stage / build | Frontend | Daemon | Tauri shell | WebKit helpers | Combined |
| --- | ---: | ---: | ---: | ---: | ---: |
| Observed startup / baseline | 299.7 | 7.8 | 36.4 | 37.1 | 379.8 |
| Observed startup / corrected | 279.0 | 9.3 | 40.0 | 35.9 | 363.5 |
| Initial idle / baseline | 131.9 | 7.8 | 35.7 | 28.4 | 203.7 |
| Initial idle / corrected | 131.1 | 9.3 | 38.6 | 28.2 | 207.2 |
| Large result peak / baseline | 394.4 | 153.2 | 36.1 | 38.0 | 621.8 |
| Large result peak / corrected | 385.9 | 13.3 | 39.2 | 37.6 | 475.9 |
| Complete workload peak / baseline | 477.5 | 176.9 | 36.4 | 52.1 | 734.8 |
| Complete workload peak / corrected | unavailable | unavailable | unavailable | unavailable | unavailable |
| Post-workload idle / baseline | 239.1 | 57.4 | 30.8 | 27.5 | 354.8 |
| Post-workload idle / corrected | unavailable | unavailable | unavailable | unavailable | unavailable |

Initial-idle windows were 25.6/25.7 seconds; large-result windows were 54.1/32.0
seconds. Samplers began just after launch and can miss earlier startup peaks.
Do not calculate an overall savings percentage from these partial observations.
The robust repeated daemon result remains separate. Native production-CSP
fixtures and CI verify the corrected follow/dock/selection behavior, while the
final full-Tauri end-to-end replay and matched post-workload memory remain
unperformed because GUI automation became unavailable. This limitation also
applies to claims about full-app responsiveness; fixture timing is reported as
fixture timing. Raw logs are `tauri-baseline-isolated.jsonl`,
`tauri-candidate-fixed.jsonl`, `tauri-final-partial-summary.json`, the corresponding
window geometry/screenshots, and `tauri-candidate-fixed-timeout-sample.txt`.

## Completed runtime-isolated Tauri pair

After the Mac was unlocked, the corrected build completed the full workflow.
This supersedes the earlier automation blocker, while retaining those failed and
incomplete runs above. Baseline source: `c85f3bfd35c0fa55d3a99eccbaf86ae6de9479b2`;
candidate: `308e35776274114950bf020439389b25b33dc6fa`.
Both were built with `pnpm@11.25.0 tauri build --bundles app --config ...`, their
own `CARGO_TARGET_DIR`, and `CARGO_BUILD_JOBS=2`. The config overrides only the
native identifier and 1440 × 900 window geometry; production CSP, appearance,
assets and optimization settings remain enabled. Hardware/runtime are the same
M1/16 GiB/macOS 27/WebKit environment described above. No compilers ran during
sampling. Exact compiler version, binary hashes, configs and phase summaries are
committed beside [the measured summary](memory-review-2026-09-17/tauri-runtime-matched-summary.json).

A further isolation review found that the earlier copies changed Info.plist but
not the compiled Tauri identifier: native window preferences could still be
shared. Those prior samples remain exploratory, not accepted savings evidence.
The new builds use distinct **compiled** identifiers
`dev.kybern.memory-profile.baseline5` / `dev.kybern.memory-profile.candidate3`.
Read-only open-file inspection verified separate `Library/WebKit` stores.
`KYBERN_DATA_DIR` and `KYBERN_CLIENT_CONFIG_DIR` are also distinct scratch paths;
LaunchServices launches pass both, and copied bundles carry matching environment
metadata. The pinned Tauri macro rejected an optional `dataStoreIdentifier`
override (`expected [u8;16], found Vec<u8>`) on both sources. That unsupported
override was removed; no dependency upgrade or source bypass was made.

The same sanitized seed was used: 400 turns, 800 tools, 6,400 events. Each run
opened the thread and `file-399-0.ts`, closed the result, scrolled upward four
times by 12 pages, returned to example 399, opened a 77 × 36 terminal and printed
3,000 numbered Unicode lines. Line 2999 and unchanged visual materials were
verified in app-window screenshots. An offline Claude-shaped fixture then sent
500 numbered Unicode deltas at 20 ms intervals through the actual driver,
daemon, store and WebSocket into the app. Both durable canonical messages equal
the expected 500-line text exactly; both turns completed. The fixture is
`scripts/profile-stream-driver.py`, not a real-provider/network performance test.
Because scratch folders are inside the original repository, automatic checkpoint
summaries displayed three scratch SQLite files in both runs; no production data
was used. Post-workload idle lasted about 70 seconds. The packaged GUI was
restored; production daemon PID 1939 stayed active throughout.

Physical footprint, MiB (startup/workload rows: sampled maxima; idle: medians):

| Stage / build | Frontend | Daemon | Shell | WebKit helpers | Combined |
| --- | ---: | ---: | ---: | ---: | ---: |
| Observed startup / baseline | 320.2 | 7.7 | 39.1 | 36.1 | 402.2 |
| Observed startup / candidate | 334.9 | 8.5 | 40.1 | 35.2 | 418.6 |
| Initial idle / baseline | 131.3 | 7.8 | 37.9 | 27.6 | 204.5 |
| Initial idle / candidate | 128.7 | 8.8 | 39.2 | 19.7 | 196.3 |
| Large result peak / baseline | 395.7 | 153.4 | 38.3 | 39.0 | 626.4 |
| Large result peak / candidate | 504.0 | 12.8 | 39.8 | 39.3 | 596.0 |
| Workload peak / baseline | 758.4 | 185.3 | 38.5 | 76.2 | 964.1 |
| Workload peak / candidate | 720.7 | 14.7 | 40.3 | 62.8 | 833.8 |
| Post-workload idle / baseline | 331.2 | 95.5 | 34.2 | 31.7 | 492.5 |
| Post-workload idle / candidate | 294.6 | 14.3 | 35.9 | 33.0 | 378.1 |

The combined sampled workload peak fell from 964.1 to 833.8 MiB; post-workload
idle fell from 492.5 to 378.1 MiB. These are **one-pair observations**, not a
repeatable whole-app percentage claim. Frontend post-idle was 331.2/294.6 MiB,
but large-result frontend median was **178.1/233.9 MiB**, with sampled peaks
395.7/504.0 MiB. Startup frontend also rose. Therefore this does **not** establish
a general `tauri://localhost` savings claim or uniformly lower frontend memory.
The robust repeated daemon-only result remains separately documented.

Native large-result vmmap snapshots attribute graphics dirty memory of
88.5/141.5 MiB, while WebKit malloc dirty memory was 82.3/81.3 MiB. The roughly
53 MiB graphics difference accounts for much of that stage's frontend increase;
this is an attribution observation, not proof of which rendering operation caused
it. Terminal graphics dirty memory was 124.5/135.1 MiB, with WebKit malloc dirty
121.3/107.4 MiB. Reserved/resident graphics mappings are not counted as RAM
savings. No visual effect or graphics behavior was removed to improve a number.
The frontend increase is retained in the report; further repeated layer/tile
profiling is needed before claiming an improvement there. Native responsiveness,
selection, focus, anchoring, formatted output and final follow behavior pass.

Limitations: only one full pair; manual phase timings differ (recorded in JSON),
and identical scroll gestures reached example 310 in the baseline versus 327 in
the corrected candidate. Thus history depth is not perfectly matched. Independent
production agents were active but excluded from totals and can affect machine
load. Sampling targets 0.5 s and can miss transient peaks; vmmap's kernel lifetime
high-water marks exceeded sampled stage peaks. Seven startup samples per build
lacked all roles and were excluded from complete totals. Combined maxima are
simultaneous sums, so component maxima need not add. No across-run frontend
variability or full-app latency claim is made. Repeated daemon pairs and native
fixture timings provide separate evidence. Raw samples/screenshots/vmmap logs
remain in the original checkout's `perf-artifacts/memory-followup-20260917/`
under `runtime-*`; summaries and hashes are committed for review.

## Outstanding optimization

Genuinely page-aware or persisted/incremental transcript reconstruction remains
outstanding. The real-store profiling in the consolidated report still shows
full relevant-history folding before cheap borrowed paging. No raw-event LIMIT,
schema migration, forced GC, artificial memory cap, or graphics-quality reduction
was introduced in this integration.

The repository references `docs/architecture.md` and `docs/design.md`, but those
files are absent at the reviewed main and candidate revisions. Root instructions
and the desktop performance guide were followed; missing documents were not
treated as evidence of completed review.
