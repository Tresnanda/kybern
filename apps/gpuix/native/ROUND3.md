# Round 3 native work — scoped paint verified, display loops experimental

Branch: `gpuix/native`. Own build only: `native/build` (1.9 GiB initially).
Initial available space: 90 GiB. No shared addon overwritten.

Baseline (`native/build/round3-before.jsonl`), Apple M1 / macOS 27, 15 s,
background fixture, one synthetic running sidebar row:

| Scene | CPU % | GPU ms | MiB | Island renders/wakes | React commits |
|---|---:|---:|---:|---:|---:|
| Home | 4.12 | 64.02 | 191 | 151/151 | 77 |
| Tasks | 4.73 | 30.59 | 206 | 122/122 | 61 |

Tasks cadence was below nominal 75 ticks; visibility / host contention needs
control before claiming a speedup. Existing scripts own and clean their daemon.

Investigation: GPUI `Window::mark_view_dirty` dirties the full view ancestor
path. Its cached `ViewElement` stores opaque prepaint/paint ranges and forces
refreshing while rebuilding an affected parent. Merely stopping retained-tree
revision propagation would not isolate nested views.

Prototype (NOT yet verified): fixed-geometry passive leaf scene paint replay.
Native `paint_replay.rs` tags div fills / SVG opacity with no events, children,
hover/active, border/shadow/filter/motion. Pure fill/opacity updates can update
recorded GPUI scene operations and request presentation without React ancestor
render, native render, layout or prepaint. Mixed/structural/unknown/clipped cases
fall back to full notify. The Metal scene is still presented in full.

Next: build; pixel, hit/focus, parent-change, nested island, scroll tests; compare
baseline workloads. Then animation cadence inventory and native vsync work.
Desktop matrix pulses are continuous ease-in-out (`styles/motion.css:156-183`),
not deliberately stepped. Task fill breathes 1.6 s alternate (`tasks.css:112`).


First prototype sample (before final display-demand fix):

| Scene | CPU % | GPU ms | MiB | Island renders/wakes | React commits |
|---|---:|---:|---:|---:|---:|
| Home | 3.39 | 114.89 | 170 | 1/1 | 77 |
| Tasks | 2.66 | 87.46 | 195 | 0/0 | 75 |

No GPU speedup claim: full-scene submission remains, and the initial Tasks
baseline had fewer visible ticks. Need same-binary disabled/enabled A/B.

The OS-capture regression caught a real lost-presentation race: scheduling the
platform directly was insufficient when its display source had gone idle.
`Window::repaint_tagged` now leaves an `on_next_frame` callback pending, which
constitutes frame demand without dirtying any view. The regression deliberately
uses OS capture; native `captureScreenshot` forces `refresh` and hides this bug.

Verification so far: all existing update.sh native checks passed (islands,
overlays, pointer/key/close behavior, secure input, code wrap, springs, fonts,
selection, decorated and rounded input, Markdown, diff, backdrop, links, layout,
syntax lifecycle/large documents, full-shell pointer routing). The wrapper
reported a final missing-path error after I edited update.sh while it was
running; direct 
running 2 tests
test tests::endpoints_and_overshoot ... ok
test tests::initial_velocity_and_equal_endpoints ... ok

test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s separately passed both tests.
Three new Rust paint allowlist/revision tests passed. Full retained-tree tests
are still compiling. Dark live pixel A/B passed before the scheduling fix;
final dark/light rerun is pending. App and native typechecks passed.

Also corrected absolute sibling-worktree imports in audit-qr.ts,
audit-requests-perf.ts and audit-split.ts; these pre-existing imports made the
mandatory typecheck fail when that other checkout lacked dependencies.


Verified checkpoint: final dark/light OS capture test passes. Six states are
pixel-identical to the full-invalidation reference (including opacity and parent
changes); eight scheduled leaf changes produce zero ancestor island renders
(after the initial input event). Clicks, focus/editing and remount pass.
The fixture is kept visible at floating level without activation: macOS stops
its display link when a background window is fully occluded, and OS captures
then correctly return its last presented frame. The final callback request also
preserves frame demand on demand-driven platforms. Do not interpret a capture
of a fully covered window as a cache invalidation test.

Rust: 3 new paint tests and all 16 retained-tree tests pass. Two spring tests
pass. Native full suite passed before the scheduling-only adjustment; the final
live paint regression covers that adjustment. Same-binary, controlled-visible
A/B sampling is now in progress. Task 2 remains unimplemented at this checkpoint.


## Controlled-visible, same-binary A/B (scoped-paint checkpoint)

`KYBERN_IDLE_VISIBLE=1 KYBERN_SCOPED_PAINT=0|1
KYBERN_IDLE_RUNNING_THREAD=1 KYBERN_REDUCED_MOTION=0 bun scripts/idle-measure.ts home tasks`
The fixture stays visible without activation; same 200 ms clock, native binary,
fixtures, 10 s warmup and ~15.02 s sample. Apple M1, macOS 27, Bun 1.4.0.
Other agents and normal host apps still run. CPU is process CPU time, GPU is
AGX per-process accumulated GPU time, memory is physical footprint; no energy
claim. React and island instrumentation add overhead.

| Scene | Scoped paint | CPU % | GPU ms | MiB | Renders/wakes | React commits |
|---|---|---:|---:|---:|---:|---:|
| Home, running row | off | 3.72 | 115.52 | 184 | 151/151 | 77 |
| Home, running row | on | 2.53 | 118.79 | 170 | 1/1 | 77 |
| Tasks, running header | off | 3.39 | 79.64 | 188 | 150/150 | 75 |
| Tasks, running header | on | 2.46 | 85.36 | 191 | 0/0 | 75 |

Observed CPU reduction: ~32% Home, ~27% Tasks. GPU did not improve (+2.8%,
+7.2% in this single A/B); full-window submission is retained. React commits
are unchanged. The late Home update is not a per-tick invalidation.
Logs: `native/build/round3-controlled-{before,after}.jsonl`.

Verified scoped-paint commit: `369f0b80`. Task 2 now has unverified working
changes (native vsync subscription with bounded callbacks, display-rate window
policy, shared loader clock and SVG rotation). Do not treat those as verified
until the next checkpoint. Current native addon remains the scoped-paint build.


## Resume checkpoint — 2026-10-16

Worktree `/Users/mymac/projects/ade-gpuix-native`, branch `gpuix/native`,
base `b8c9be01`. The additive candidate is built in this checkout only; no shared
or installed addon was replaced. All changes are uncommitted for parent integration.

The pointer patch preserves native ancestor routing through implicitly filled
children while blocking painted overlapping siblings. Explicit `pointerEvents:auto`
and anchored/deferred overlay barriers retain their previous behavior. Its live
regression first failed on the baseline and then passed dark/light move → 250ms
hover → click, one enter without flapping, cached descendant, covered sibling,
uncovered sibling, and deferred overlay checks.

Clipboard additions expose `readClipboardImage()` (bytes/media type/name or null),
`readClipboardPaths()` and the automation-only `simulateFileDrop(x,y,paths)` bridge.
The automation protocol schema and client forwarding are included in the npm patch.
Composer owns the full app clipboard/drop acceptance; consult its final results.

Display-loop work is **experimental and not integration-approved**. `paintAnimation`
evaluates matrix/breathe keyframes in the native scene without React, render,
layout, or prepaint. It still reconstructs typed scene arrays and submits the whole
scene; it is not a GPU dirty-region compositor. Tags preserve animation epoch on
unrelated redraw and retain base color for theme changes. The div forwarding omission
was caught with actual OS-captured pixels and fixed. The frame subscriber API bounds
one queued delivery per subscriber (maximum64), and the host waker also coalesces
one pending delivery. Stale JS generations are rejected after unsubscribe.

The optional CoreVideo-to-host wake and full-rate inactive-window policy are now
opt-in (`KYBERN_VSYNC_WAKE=1`, `KYBERN_FULL_RATE=1`). This preserves the previous
inactive policy when integrating pointer/clipboard without app frame changes.
Do not integrate the `src/MatrixLoader.tsx`, `src/native/frame.ts`, frame-related
`main.tsx`, Connection, Glyphs, drag/edge and transcript changes as accepted parity
until the full Tasks regression below is resolved. Native scene loops require the
new JS `paintAnimation` forwarding; copying the addon alone is insufficient.

Controlled four-task board sample, final candidate before restoring opt-in default,
15s with10s warmup; Apple M1/macOS27, new declarative app JS, no model turns:

| Host wake | CPU | GPU / sample | Footprint | Native submits | p50 / p95 ms | Island renders / React commits |
|---|---:|---:|---:|---:|---:|---:|
| off | 7.16% | 304.93ms | 201MiB | 899 | 16.28 / 23.80 | 0 / 0 |
| on | 6.98% | 217.14ms | 202MiB | 895 | 16.67 / 17.60 | 0 / 0 |

These are native draw/submission timestamps, not GPU/display presentation fences.
They do not establish sustained60fps or energy savings. CPU/GPU endpoints precede
footprint queries; actual elapsed time is the denominator. Instrumentation is on.
The task worker's larger old-JS board reported40.8% CPU /1424ms GPU idle. Its CPU
sampler reads the endpoint after a footprint query but divides by15s, so CPU may be
inflated. The GPU endpoint is before footprint and remains an unresolved concern.
The four-task sample is not the same workload and cannot clear that result.

No rich formatted document editor, subtree blur, or subtree scale/rotation was added.
Those native capability gaps remain separate from this patch.

App and native TypeScript checks pass after the resume changes. Composer verified
clipboard image, Finder file paste, native drop, text paste and sent-thumbnail
rendering through a mocked send boundary, with no provider turn. Full larger-scene
resource reruns were deferred to respect the requested break/thermal budget;
frame-loop integration remains unaccepted rather than treating missing validation
as a pass.

### Final targeted verification

Final opt-in-default-restored native build passed (1m40s). The packaged addon and
SHA256 are recorded in `previews/gpuix/round3-resume/native/candidate.json` in the
original workspace. Final `pointer-check.ts` passes both themes. Final
`paint-check.ts` passes both themes: six actual-window states pixel-identical to
full repaint; scheduled passive changes render zero ancestor islands; moved click,
focus/editing, parent opacity and remove/remount pass.

Final `frame-check.ts` passes dark/light with reduced motion on/off. Four matrix
variants demonstrably change OS-captured pixels only with motion enabled. The
3s cadence intervals contain zero island renders. Native draw/submission p50/p95:
dark16.668/18.495ms, light16.660/18.389ms. Reduced motion produced zero submissions
in each3s interval. Raw callback backpressure (one until acknowledged), shared
unsubscribe, minimized idle after1.5s OS transition allowance, and unmount idle
pass. The initial minimize test waited500ms and observed one final transition
frame; steady idle was checked after the transition, not by relaxing frame counts.

The WebKit comparison helper could not import its historical Playwright path;
no package/browser install was performed. `PLAYWRIGHT_CORE` can select an existing
installation for `frame-webkit.mjs`. The new Tauri/WebKit reference strips remain
**incomplete**, and native-only `frame-sheet.swift` produces four-frame contact sheets. Native individual frame
captures and JSON timestamps are retained. No frame-parity completion claim.

Resource inventory: volume free85GiB before this resume,73GiB at final check
(concurrent team work; not attributed to this task). Native build2.7GiB, including
its only Cargo target; upstream185MiB; existing GPUIX dependencies398MiB. Parent
requested cleanup after integration: keep the deliverable `.node` (~20MiB) and
source/evidence; target, intermediate logs/screenshots and upstream are disposable
after verifying no user of them remains. No installed runtime or user data changed.
All own fixture windows/daemons closed; headless-reference Vite is stopped.
