# Fast flick scheduling — GPUIX issue 108

Final same-addon pair: **42/42 accepted windows** at 2x on the hidden display,
with no build/peer/screen-invalid overlap. The fast-flick pacing goal was met:
fling p99 24.55→17.85 ms, worst interval 107.54→26.11 ms, >33 ms intervals
6/6/6→0/0/0. Every candidate scrolling window stayed below 33 ms (worst
across all five scrolling scenarios: 28.15 ms). Idle remained zero frames.

**The wider low-resource and 120-ready goals are not met.** CPU stayed broadly
similar; four scrolling scenarios have higher measured AGX time. The native
render p95 and whole-process CPU averages still exceed 8 ms in several paths.
Keep the resource regressions visible when reviewing integration; this is a
cadence/older-history improvement, not evidence of lower overall energy use.

## Finding and implementation

The embedding enables GPUI test support. Its eager dirty-window effect loop
rebuilt native scenes 8–16 times between display callbacks. Choosing the normal
platform frame scheduler removes that repeated work without replacing the
existing semantic-key sparse list, native scroll accumulation, height hints,
Markdown formatting or visual effects. No new runtime timer or history cache
was introduced.

The relevant source transfer is Zed’s normal dirty-window scheduler, scoped
away from its eager test mode: [pinned app.rs](https://github.com/zed-industries/zed/blob/56934ec0560bce8929025497411de7f5322fb6ca/crates/gpui/src/app.rs#L2104).
Zed’s [List offset/splice logic](https://github.com/zed-industries/zed/blob/56934ec0560bce8929025497411de7f5322fb6ca/crates/gpui/src/elements/list.rs#L511)
retains logical item anchors; its [wheel accumulation](https://github.com/zed-industries/zed/blob/56934ec0560bce8929025497411de7f5322fb6ca/crates/gpui/src/elements/list.rs#L1590)
is relative to the last painted frame. Zeron uses stable row models and a
[viewport-retained derived Markdown cache](https://github.com/zeronsh/zeron/blob/c526d6f7cfc7a53e5588e3e6c5df7484a14d649f/crates/ui/src/markdown/render.rs#L438).
Neither establishes an unlimited shaped-history cache. Exact source findings
and limitations are in [RESEARCH.md](RESEARCH.md), checked against read-only
revisioned clones.

Native patches, separately:

- `native/patches/flick_frame_gpui.py`: platform-frame draws by default;
  `KYBERN_INPUT_FRAME_DRAW=0` retains the eager same-addon control. A paused
  per-window automation clock retains deterministic eager test paints until resume.
- `native/patches/flick_bounds_hooks.py`: explicit automation-tree/image capture
  barriers finish dirty scenes through an unborrowed window handle. Ordinary
  painted-bounds reads remain reads.
- `native/patches/apply_hooks.py`, `backdrop_gpui.py`: minimal reconstruction hooks.
- `native/patches/automation_display.rs`, `automation_display_hooks.py`: inherited placement fix
  from 29268adf + c1ab6aaf, with all flick hooks retained.

Production TypeScript:

- `src/transcript/Window.tsx`: count changes wait for the existing post-paint
  native list observer. The semantic anchor keeps visible body hosts mounted
  while a deferred frame still exposes the old numeric index. The previous
  immediate count-triggered read briefly remapped it into the new key array.
- `src/transcript/Window.test.tsx`: reproduces that old-offset/new-key boundary
  and requires original host identity to survive prepend and unrelated tail growth.
- `src/shell/window.ts`: inherited hidden-display origin placement.

Measurement and regression tools:

- `perf/bench/app.ts`: harness-only full-history/input controls and explicit
  provider/settings/target/catalog readiness; rendered product is unchanged.
- `perf/bench/scenarios.ts`, `telemetry.ts`, `run.ts`: real AppKit wheel input,
  complete 3,000-turn fling history, native frame-boundary accounting, and five
  second input bridges outside resource windows while controller guards run.
  Buffered pipe telemetry drains before both marks. Hashes identify relevant
  production and harness source, addon and flags.
- `perf/bench/window-onscreen.ts`/`.swift`, `model.test.ts`: require onscreen
  hidden-display bounds and actual mode pixel/logical scale 2; handle the
  quoted negative coordinates in CoreGraphics dictionary output.
- `perf/bench/lease.ts`: quiet owner gets the next UI batch.
- `perf/flick/quiet.ts`, `quiet-check.py`: bounded owned process-group cleanup
  before releasing markers; actual SIGINT/SIGTERM child/grandchild checks.
- Other `perf/flick/` runners reuse existing scroll2/native assertions under
  owned scratch paths; gate every capture, keep pixels separate from timing,
  preserve per-run distributions and correlate every slow native interval.

## Workload and interpretation

Final evidence uses one validated addon for both eager control (0) and
normal default (unset; equivalent to 1), three consecutive 15-second resource
windows per scenario after a ten-second warmup. Order is fixed: 0 then default;
one fresh app process per scenario/variant, not three independently restarted
processes or a randomized significance study. Native wheel production targets
120 packets/s with precise deltas and contact/momentum phases; achieved packet
rates are retained rather than assumed. Five-second bridges are outside each
window. Synthetic fixture: 300 threads across 20 projects, a fully loaded
3,000-turn mixed transcript, expanded large file tree, long Markdown/source.

Host: Apple M1, macOS 27.0.1; hidden 1440×900 logical / 2880×1800 pixel display
at 60 Hz, app 1280×820, `KYBERN_FULL_RATE=1`. Every measured window proved
hidden-display bounds at 2x before/after, unlocked/awake screen, no peer app,
no native-build overlap, and nonzero active submissions/GPU. No screenshots,
profiles or manually advanced clocks are used inside timing windows.

Frame intervals are native submissions, not physical presents. Every scrolling
window delivered all 1,800 scheduled packets except one candidate fling window
with 1,799; accepted equals offered, and requested/effective/handler distances
match in every window. Wall-clock phase sampling makes distances close rather
than byte-identical across variants. Latency is a next-submission receipt proxy;
that submission need not contain the input. The 2.40 ms fling proxy is not a
physical response latency. Separate native input-to-CPU-paint telemetry is also
not display latency. CPU is percent of one core; GPU is accumulated process
AGX milliseconds per actual resource window; footprint is the physical-footprint
endpoint, not peak. Per-submission CPU/GPU averages include whole-process work
and do not establish an 8 ms worst-case budget. Older-history resource windows
follow the action and include stationary indicator cadence; their intervals
must not be called fast-flick stalls.

## Final before/after measurements

0 = eager same-addon control; default = unset, platform-frame draw path.
Quantiles/resources are medians of three windows; max is the worst of all
three. >16.7 counts include ordinary near-vsync jitter, not just missed frames.
Per-window full distributions/resources are retained in [RESULTS.json](RESULTS.json)
and the raw paired JSON/logs below.

| Scenario | Variant | p50 / p95 / p99 ms | Worst max ms | >16.7 median | >33 by run | Proxy p95 | CPU % | GPU ms / window | MiB |
|---|---|---|---|---|---|---|---|---|---|
| thread-fling | 0 | 16.65 / 21.22 / 24.55 | 107.54 | 386.00 | 6/6/6 | 15.85 | 51.07 | 1379.50 | 369.00 |
| sidebar-scroll | 0 | 16.67 / 17.88 / 23.80 | 27.62 | 386.00 | 0/0/0 | 14.80 | 50.27 | 196.70 | 246.00 |
| explorer-scroll | 0 | 16.67 / 17.16 / 17.64 | 18.58 | 384.00 | 0/0/0 | 15.87 | 53.66 | 577.20 | 285.00 |
| markdown-scroll | 0 | 16.65 / 17.14 / 17.35 | 17.75 | 401.00 | 0/0/0 | 15.99 | 46.88 | 1554.60 | 265.00 |
| code-scroll | 0 | 16.67 / 22.79 / 23.50 | 27.68 | 406.00 | 0/0/0 | 16.73 | 47.47 | 1690.10 | 272.00 |
| older-history | 0 | 199.89 / 201.30 / 215.70 | 216.00 | 83.00 | 72/73/73 | — | 8.25 | 108.80 | 269.00 |
| idle-thread | 0 | — / — / — | 0.00 | 0.00 | 0/0/0 | — | 3.46 | 0.00 | 244.00 |
| thread-fling | default | 16.68 / 17.07 / 17.85 | 26.11 | 383.00 | 0/0/0 | 2.40 | 52.53 | 90.50 | 370.00 |
| sidebar-scroll | default | 16.61 / 21.15 / 23.38 | 28.15 | 388.00 | 0/0/0 | 19.28 | 48.04 | 1335.10 | 248.00 |
| explorer-scroll | default | 16.67 / 17.42 / 18.23 | 23.02 | 375.00 | 0/0/0 | 16.47 | 50.54 | 2501.00 | 301.00 |
| markdown-scroll | default | 16.67 / 16.83 / 17.23 | 22.03 | 296.00 | 0/0/0 | 15.77 | 49.34 | 2724.10 | 272.00 |
| code-scroll | default | 16.66 / 17.61 / 18.02 | 27.14 | 353.00 | 0/0/0 | 16.84 | 47.15 | 2911.70 | 273.00 |
| older-history | default | 199.50 / 201.41 / 213.89 | 217.06 | 87.00 | 72/71/72 | — | 8.44 | 378.60 | 272.00 |
| idle-thread | default | — / — / — | 0.00 | 0.00 | 0/0/0 | — | 3.59 | 0.00 | 255.00 |

Older-history intervals above are the stationary 5 Hz indicator cadence after
loading, not fast scrolling. The separate newly-older painted-content probe
improved from **1,164.16 ms to 241.34 ms** median (all runs 1,156.91–1,170.37 ms
versus 230.59–291.45 ms). It uses automation inspection, not a physical-present
fence or a cold-start benchmark.

| Scenario | Variant | Native render / layout p95 ms | Process CPU / GPU ms per submission | First input → CPU paint p95 ms |
|---|---|---|---|---|
| thread-fling | 0 | 9.14 / 1.29 | 8.72 / 1.57 | 18.10 |
| sidebar-scroll | 0 | 9.01 / 1.02 | 8.39 / 0.22 | 15.43 |
| explorer-scroll | 0 | 8.02 / 0.81 | 8.95 / 0.64 | 16.63 |
| markdown-scroll | 0 | 7.16 / 1.25 | 7.82 / 1.73 | 16.63 |
| code-scroll | 0 | 11.34 / 1.96 | 7.92 / 1.88 | 22.30 |
| older-history | 0 | 8.67 / 1.02 | 12.27 / 1.08 | — |
| idle-thread | 0 | — / — | — / — | — |
| thread-fling | default | 10.91 / 1.64 | 8.76 / 0.10 | 15.39 |
| sidebar-scroll | default | 8.91 / 1.32 | 8.02 / 1.48 | 20.67 |
| explorer-scroll | default | 8.38 / 0.77 | 8.43 / 2.78 | 16.87 |
| markdown-scroll | default | 7.90 / 1.29 | 8.23 / 3.03 | 15.84 |
| code-scroll | default | 7.18 / 1.23 | 7.86 / 3.24 | 16.27 |
| older-history | default | 8.94 / 1.03 | 11.97 / 3.57 | — |
| idle-thread | default | — / — | — / — | — |

The resource outcome is mixed and unresolved: fling CPU 51.07→52.53% and
footprint 369→370 MiB are essentially unchanged; its AGX time fell
1,379.5→90.5 ms/window, while sidebar, Explorer, Markdown and source increased
196.7→1,335.1, 577.2→2,501.0, 1,554.6→2,724.1 and 1,690.1→2,911.7 ms/window.
Control sidebar itself ranged 46.9–1,236.3 ms across its three windows. These
are the sampler's per-process driver counters; raw AGX endpoint dumps were not
retained, so the cause/measurement stability cannot be established from this
capture. Sidebar p95/proxy also worsened 17.88→21.15 / 14.80→19.28 ms;
this is not a uniform improvement across surfaces. A read-only current-driver check found AppUsage before creator in all
50 entries, so no observed property-order parser failure explains them. No
favorable resource sample replaces these results. Idle CPU remains a roughly
3.5% process floor despite zero GPU/submissions; low CPU/energy needs more work.

## Tried and excluded

- Unconditional deferred draws exposed synchronous bounds, hover screenshot
  and controlled-clock spring regressions. Explicit snapshot barriers and a
  scoped paused-clock exception fixed them; full updater checks passed.
- An immediate post-prepend numeric anchor read remounted the current native
  body under deferred drawing. A failing headless regression and actual host
  identity check led to the post-paint fix above; no identity assertion was weakened.
- Earlier samples overlapping the stray orchestrator probe from 03:24:43Z and
  the aborted control pair are excluded.
- `hidden-final` is diagnostic only: stopping input between resource windows
  plus synchronous controller guards admitted buffered 5 Hz idle scenes into
  subsequent scroll marks. The continuous bridges and pipe drains correct the
  protocol while retaining actual boundary stalls in counts.
- CoreGraphics logical width was an invalid HiDPI scale numerator, and quoted
  negative X initially rejected the valid hidden screen. Mode pixel width and
  explicit parser tests corrected those preflight guards; rejected samples
  supply no acceptance numbers.
- Preview captures initially raced expanded-tree loading and provider/catalog
  discovery. The latter changed the Hand off button and permission badge
  between captures. Both variants now require real loaded UI. A later 46-pixel
  rail-arc difference came from live account-use data; the visual-only harness
  holds one loaded usage snapshot across all variants/themes (hash recorded).
  All rings and visual effects remain present. Image comparisons exclude the
  existing 4 px frame edge and bottom corner shadow regions; no content region
  is masked to conceal a state difference. Timing never invokes this control.
- A code-preview GPU anomaly prompted an interleaved control; it did not repeat.
  Those earlier exploratory measurements are not pooled with final evidence.
  The final pair has broader AGX increases, retained above as an unresolved
  resource regression; the earlier experiment does not dismiss them.

## Attribution and limitations

Independent `sample` profiles are diagnostic, excluded from acceptance cadence.
Largest inclusive flush stack counts fell 634→23 and renderer-build counts
419→249; overlapping inclusive stacks are not wall-time percentages. Sparse
shaping samples do not prove shaping free. Stripped Bun/JIT symbols and absent
GC instrumentation prevent an exhaustive JS/GC cause allocation.

Final `attribute.py` output retains every >16.7 ms interval and asserts both
threshold counts against exact measured windows. All **18** control fling
intervals over 33 ms contain **8–16 native draws** between submissions: total
draw work 46.65–99.48 ms, largest individual draw only 6.27–9.41 ms. Their
49.85–107.54 ms gaps therefore correlate with repeated scene construction,
not one >16.7 ms measured draw. Ten of those gaps have no React commit;
React is not required for the observed burst. Candidate fling has zero such
multiple-draw slow intervals and zero >33 ms intervals. Its 1,163 intervals
above 16.7 ms classify as 992 scheduler/display intervals without a long
measured draw and 171 with a correlated React commit. Those are not an
exhaustive causal allocation.
Correlation is not proof that a commit caused a stall.

## Evidence and validation

All raw logs, images, JSON and profiles are under
`/Users/mymac/projects/ade/previews/gpuix/perf/flick/`.
Only this report, condensed final JSON and reusable tools belong in the commit.

| Evidence | Artifact path below that root |
|---|---|
| Final raw same-addon windows | `continuous-final-0.json`, `continuous-final-default.json`; same-named directories contain native logs and resource text |
| Every slow interval + asserted counts | `attribution-continuous-0/`, `attribution-continuous-default/` |
| Independent profiling diagnostics | `profile-full/`, `profile-frame/`, `profiles-summary.json` |
| Full native updater | `native-update-resumed.log`, `native-passed.json` |
| Full-app preview pixels | `preview-visual/pixels.json`, light/dark 0/1 tree/Markdown/code PNGs |
| Follow/prepend stable native host and y | `follow/results.json`, corresponding light/dark PNGs |
| Sidebar/menu pixels and interaction | `checks/sidebar/settled-pixel-diff.json`, `verify-sidebar.log`, per-batch gate JSON |
| Transcript/copy/list/snapshot checks | `visual/pixel-diff.json`, `verify-transcript-pixels.log`, `verify-transcript.log`, `verify-cross-turn-copy.log`, `verify-list-anchors.log`, `verify-synchronous-snapshot.log` |
| Board/list/project motion and drag | `tasks/dark-0/`, `tasks/light-1/`, `verify-task-project-drag.log` |
| Headless checks | `typecheck-resumed.log`, `native-typecheck-resumed.log`, `bench-typecheck-resumed.log`, `flick-typecheck-resumed.log`, `bun-test-resumed.log`, `bench-tests-resumed.log`, `quiet-cleanup-resumed.log` |
| Cleanup and exact final commit/status | `cleanup.json`, `cleanup-open-files.json`, `handoff.json` |


Completed: full `native/update.sh` end to end; synchronous tree/image barriers
and paused/resumed clock; transcript light/dark × normal/reduced-motion pixels
(16 comparisons, zero changed pixels); original scroll2 transcript rail,
selection/copy across disposed rows, exact final formatted content; 30,000-row
sparse-list focus/prepend/reverse anchors; both-theme × both-mode native
follow-bottom/unrelated-growth/prepend host identity and y position unchanged. Full-app Explorer tree/Markdown/source previews add
12 light/dark comparisons with actual movement and matched offsets, zero changed
content pixels, one loaded usage snapshot. Representative dark/light captures
were visually inspected for formatted content and unchanged hierarchy. Sidebar
checks passed in both themes; 8 paired sidebar/menu/scrolled crops at
1440×900 @2x have zero changed pixels. Correctness batches record CPU-build
overlap as context and make no timing/resource claims. Task/project interaction
checks passed dark/normal and light/reduced: quick save, board/list carry and
edge scrolling, drop/Escape cleanup and project drag. The queue wait is separate
from the active 285-second batch watchdog.

Headless: source typecheck, native/bench/flick TypeScript; all 338 source tests
(6,921 assertions, 58 files); 13 bench tests (56 assertions); quiet wrapper
SIGINT/SIGTERM process-group cleanup. Bench/flick TypeScript reran after the final harness readiness edits and passed.

Physical trackpad use, physical present timestamps, energy/battery, a real
120 Hz display, combined-lane integration, and exhaustive JS/GC attribution remain
unmeasured. Fling median native render p95 is 10.91 ms and fling process CPU averages
8.76 ms/submission; 120 Hz readiness has not been achieved. The fixture
and virtual 60 Hz display cannot establish a universal frame-rate guarantee.

## Handoff

Branch `gpuix/perf-flick`; measured source `9e1b306ec91732f2041804855126b0d548dfa288`.
Final report commit/clean status are attested after committing in artifact
`handoff.json` (avoids embedding a self-referential commit hash). Native addon SHA-256:
`98c0b228c1a46638bdb59603c1d77c58f2a8b5e242efe47664145aa797122cfc`.
Full rebuild free space: 89.01→86.68 GiB; initial worktree-start free ~91 GiB.
The disposable 1.9 GiB native target was removed after open-file checks.
Final cleanup free space: **83.79→84.12 GiB**;
this is a shared volume and the change is not wholly attributed to this lane.
Removed the disposable 188 MiB dependency tree, 185 MiB upstream build clone,
prior addon, generated test executables/inputs, scratch data and wheel helper.
Retained only the validated addon and required webview dylib in native/build
(25.41 MiB), so the measured runtime remains available.
No owned process or generated-file open handle remained at cleanup. Shared
research clones and peer/user processes were preserved. Raw final bench outputs
were moved to the artifact folder, with existing JSON copies hash-checked.
