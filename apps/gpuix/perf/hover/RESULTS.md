# Hands-on round 5: hover and selection

Evidence root: `/Users/mymac/projects/ade/previews/gpuix/handson-r5/hover/`.
Branch: `gpuix/hr5-hover`, based on `e1ffabf6`.

## Root causes and implementation

**Item 6, hover on scroll:** GPUI already hit-tests the completed prepaint
layout. Its ordinary div paint path updates hover then, like current Zed.
GPUIX's cached paint replay skips that path. List rows that remain mounted in
React but leave the native painted range also lose their native listeners
without receiving a leave. Retained paint transforms update hitboxes without
another mouse hit test. The result is stale native `:hover` and JS
`onMouseEnter`/`onMouseLeave` state when the cursor does not move.

**Item 7, hover after disclosure:** the same native gap combines with sidebar
child-control hover counters. Reflow or removal can unbalance enter/leave
pairs, keeping several rows revealed indefinitely. `src/sidebar/rows.tsx` now
gives one native ancestor ownership of the row and its controls, using one
boolean rather than child keep counters. The inner project drag handlers
remain on their original element.

**Item 7, selection:** GPUIX's inherited native default is selectable, whereas
desktop `styles/kybern.css:25–35` makes application chrome unselectable and
opts document content in. `src/App.tsx` now establishes that policy, and `Label`
also covers anchored overlays outside the root. Prose, Markdown, code and diff
bodies explicitly opt in. Inputs and the notes rich editor retain their own
selection models. Native custom surfaces also needed to register explicit
selection-start regions; inherited selectability alone still hit the
unselectable ancestor when starting a code/Markdown/diff drag.

The source audit covers every native Markdown/code/diff callsite. Explicit
body opt-ins are in coordinator cards, dock Agents/Artifacts/Diff/Explorer/
Project, native DiffView/DocumentMarkdown, PR description/timeline/diff,
settings instructions and transcript diffs. Existing transcript prose, code,
thinking, task description and update-note opt-ins remain in place.

Desktop references: `styles/kit.css:516–518,570–572` and
`lib/kit/sidebarRowStyles.ts:24–27` supply existing hover/selection colours;
this change introduces no new colour, geometry or animation tokens.

Research: pinned GPUI `81c99f816b4a5f69d3c014774068034c24d1d7af` versus local
Zed research checkout `56934ec0560bce8929025497411de7f5322fb6ca`,
`crates/gpui/src/window.rs` (`mouse_hit_test`, draw/prepaint) and
`elements/div.rs` (`hitbox.is_hovered`, on-hover updates).

## Native patches (integrate separately)

- `native/patches/hover_reconcile.rs` and `hover_reconcile_gpui.py`, invoked by
  one appended hook in `backdrop_gpui.py`: reconcile live cached hover and
  retired hover owners after frame swap; re-hit-test after retained transform
  geometry changes. A private typed event avoids synthesizing mouse moves,
  dragging or selection input. Updates defer owning-view notifications until
  after draw and occur only on a state transition.
- `native/patches/selection_surface_hooks.py`, invoked by one appended hook in
  `apply_hooks.py`: custom content registers its explicit `userSelect` start
  region, using the existing host-element policy.
- Both late hooks flush their modified files themselves; preserve that order
  when combining sibling lane hooks.
- There is no new timer or idle frame source. Retained transforms reuse their
  existing presentation callback. `KYBERN_HOVER_RECONCILE=0` is a diagnostic
  native control, not an application setting.
- `native/subtree-transform-check.ts` now verifies the screen and owned window
  before OS captures. The benchmark capture guard verifies the pinned hidden
  display's actual CG bounds at scale 2. The orchestrator explicitly authorized
  its move from `(-1440,900)` to `(0,0)` when the MacBook lid closed; no invalid
  capture or timing was accepted during that transition.

Final addon SHA-256:
`f1e8642f44a5a4c3801ce1827aa64f4e44af20fda747d54459fdb9f5e308ebac`.
`native-update-accepted.log` and `native-passed.json` record a successful complete
`native/update.sh` under the whole-run build marker.

## Behavioral evidence

`before-native.json` versus `after-native.json` uses identical low-level
fixtures on the old and final addons. In both themes, the old addon fails the
offscreen cached-row leave, retained translation leave, retained transform
leave and custom document/code selection checks. The final addon passes all
14 checks in each theme: stationary enter/leave, layout reflow, retained
movement, body selection, control clearing and three idle checks. Captures
are `before-{dark,light}-*.png` and `after-{dark,light}-*.png`.
The held-press probe preserves hover before real movement; reconciliation also
keeps a live pressed owner while it remains under the cursor, matching GPUI's
ordinary paint policy. Capture/bubble order matches normal mouse dispatch.

`before-app/` uses the base sidebar/root/label source and old addon. Touching
six project disclosures leaves 1–2 project control pills after the pointer
leaves in each theme/motion combination. Candidate evidence is in
`after-app/`; matching actual desktop frontend captures are in
`desktop-normal/` and `desktop-reduced/` (headless WebKit, never Tauri).
The supplied stray-selection screenshot was not reproduced by the baseline
sidebar double-click sequence; the default-selection policy mismatch is
established by source, with candidate input tests and positive document/editor
selection checks guarding the correction.

<!-- generated-audit -->
**Items 6 and 7: fixed.** All 76 final native cases and 76 matching
headless WebKit references completed (19 surfaces × two themes ×
normal/reduced motion). Every sampled post-scroll/reflow background
matches the tiny mouse-move oracle. Every tested interactive target
keeps an empty text selection after AppKit double clicks and fast
click/short-drag sequences. All project-remnant counts are zero.

| Surface | Result in all four combinations | Additional coverage / scope |
| --- | --- | --- |
| Sidebar projects | Hover/reflow and clicks pass | 12 disclosure clicks |
| Sidebar threads | Hover/reflow and clicks pass | — |
| Nested thread groups | Hover/reflow and clicks pass | 2 disclosure clicks |
| Rail | Hover/reflow and clicks pass | Static; wheel probe |
| Composer project/workspace/branch chips | Hover/reflow and clicks pass | 3 chip double clicks |
| Notes list | Hover/reflow and clicks pass | — |
| Notes gallery | Hover/reflow and clicks pass | — |
| Tasks list/groups | Hover/reflow and clicks pass | 2 disclosure clicks |
| Tasks board | Hover/reflow and clicks pass | — |
| Notes rich editor | Selection retained | Positive native selection |
| Explorer tree | Hover/reflow and clicks pass | 3 folder disclosure clicks |
| Explorer source body | Selection retained | Positive code selection; short file |
| Dock Agents tab | Hover/reflow and clicks pass | Tab only; empty agent list |
| Dock notes list | Hover/reflow and clicks pass | — |
| Dock tasks list | Hover/reflow and clicks pass | — |
| Settings list | Hover/reflow and clicks pass | Static; wheel probe |
| Dock menu/popover | Hover/reflow and clicks pass | Static; wheel probe |
| Command palette | Hover/reflow and clicks pass | Wheel probe |
| Pull request list | Hover/reflow and clicks pass | — |

Static controls have wheel probes without content movement; the short
Explorer source and editor rows use positive selection checks rather
than interactive-label click assertions. The existing native updater
separately verifies code viewport scroll/wrap, Explorer motion and
cached/full PR list/summary/diff pixels in all four combinations.

## Before/after performance

The table uses the upper median of two independent runs, as the
benchmark report does. Max is the worst observed interval across both.

| Scenario | Submission p50/p95/p99 ms, before → after | Worst ms | CPU % | GPU ms/window | Footprint MiB |
| --- | --- | --- | --- | --- | --- |
| sidebar-scroll | 16.67 / 17.87 / 20.38 → 16.66 / 17.85 / 18.82 | 31.05 → 20.91 | 50.11 → 40.20 | 2840.50 → 2128.90 | 225.00 → 235.00 |
| thread-fling | 16.65 / 18.27 / 21.62 → 16.67 / 17.58 / 18.82 | 28.89 → 21.56 | 47.61 → 41.02 | 3284.80 → 2306.70 | 254.00 → 249.00 |
| idle-home | — / — / — → — / — / — | — → — | 3.45 → 4.12 | 0.00 → 0.00 | 230.00 → 230.00 |

| Scroll work / input probe | Before | After |
| --- | --- | --- |
| sidebar-scroll: React commits/window | 389.00 | 411.00 |
| sidebar-scroll: native render p95 ms | 9.09 | 5.97 |
| sidebar-scroll: native layout p95 ms | 1.21 | 0.77 |
| sidebar-scroll: next-submission proxy p95 ms | 17.28 | 16.85 |
| sidebar-scroll: first-packet dispatch-to-CPU-paint p95 ms | 16.71 | 16.84 |
| sidebar-scroll: last-packet dispatch-to-CPU-paint p95 ms | 15.02 | 10.38 |
| thread-fling: React commits/window | 153.00 | 142.00 |
| thread-fling: native render p95 ms | 7.89 | 6.50 |
| thread-fling: native layout p95 ms | 1.52 | 1.08 |
| thread-fling: next-submission proxy p95 ms | 17.25 | 16.61 |
| thread-fling: first-packet dispatch-to-CPU-paint p95 ms | 16.97 | 16.49 |
| thread-fling: last-packet dispatch-to-CPU-paint p95 ms | 15.72 | 8.57 |

All six candidate runs passed the screen, owned-window, process, build
overlap, input continuity and active-sample gates. Both baseline and
candidate idle windows submitted **zero frames**. Source-file hashes,
the 15 production-change hashes, render flags and dataset match.
Individual runs and all work/input distributions are in `summary.json`;
raw evidence is `bench/hr5-hover-paired-{before,after}/result.json`.
<!-- /generated-audit -->

## Method and limits

The native audit uses real pointer/wheel input through GPUIX automation,
process-local AppKit double-click events, and a real NSWindow resize. It
compares the parked-cursor row background against a 0.1/0.2-point real mouse
move after scrolling/reflow. Project controls additionally have a whole-tree
zero-remnants assertion after repeated expand/collapse. Three composer chips
receive separate AppKit double clicks. Notes rich-editor selection and
Explorer source selection have positive assertions. Static controls receive
wheel/reflow probes but have no collapsible content. This is a representative
surface audit, not an exhaustive enumeration of every menu item or setting.
Desktop captures compare corresponding surfaces and hover materials; they are
not whole-window pixel-equality tests (window chrome and draft preferences
differ between the clients).
The fixture explicitly populates the dock thread's `kybern-app` project with
32 notes, 32 tasks and 100 Explorer files. Native scroll anchors must change
on the sidebar, Notes, Tasks, Explorer, dock lists and PR list; merely sending
a wheel event to a short or empty list does not satisfy those checks. The
scroll-owner IDs are resolved before parking the pointer; direct native
scroll-offset getters verify movement without requesting another paint.
The owned audit window stays above background windows on the hidden display
without becoming key or activating the app. Every OS capture must also match
the requested 1280×820 or 1180×820 viewport at exactly 2x; transient scaled
WindowServer snapshots are rejected. Native checker fixes wait for visible,
presented content and compare decoded RGBA rather than compressed PNG bytes.
These are verification changes, with unchanged pixel-equality thresholds.

Benchmarks use Apple M1, macOS 27.0.1, Bun 1.4.0, the hidden 1440×900@2x/60 Hz
display, and the same seeded dataset and TypeScript sources for both addons.
Each scenario has two runs, 10 seconds warmup and a 15-second resource window.
Scroll input is a real AppKit 120 Hz contact/momentum sequence. Submission
intervals, process CPU, GPU time, physical footprint, React commits and native
render/layout work are separate measurements. Input probes report GPUI
dispatch-to-CPU-paint or a next-submission receipt proxy; neither is physical
presentation latency. GPU time is per resource window, not energy. An initial long-gap comparison crossed a lid/display-topology change. The
consecutive repeat used the same topology for both addons; resolution, scale,
hardware and guarded hidden-display identity remained the same throughout. Two samples
support regression checking, not a general battery/performance guarantee.

The process gate's only new overlap exemption is a verified windowless
`bun …/visual/fixture.*.ts --proxy` below 1% CPU. It remains tagged in inventory;
visible, busy or unverified helpers still invalidate a measurement.

Discarded captures and failed gate runs remain under `diagnostics/`. The
initial valid, long-gap timing comparison is retained separately at
`bench/hr5-hover-{before,after}/result.json`; it is not mislabeled as invalid.
It reported sidebar/thread p95 of 17.93/17.56 ms before versus 17.55/20.38 ms
after, CPU 38.28/38.17% versus 42.80/48.06%, and a worst sidebar interval of
35.08 ms. That apparent regression triggered one consecutive old/final-addon
repeat under a single quiet window (`bench-paired-final.log`). The old addon
itself then used up to 50.11/47.61% CPU and render p95 9.09/7.90 ms, showing
substantial host variation versus the earlier baseline. The paired table above
reports all twelve repeated runs: candidate scroll p95 stays within the prior
range, with no interval above 33 ms and zero idle submissions. Candidate idle
CPU was 4.12% versus 3.45% despite zero native work in both. These short runs
support the pacing check; they cannot isolate a small CPU or energy change.
Both comparisons are retained. The paired run changed only the native addon.

## Verification and handoff

Required checks passed: `pnpm typecheck`, `pnpm exec tsc -p
native/tsconfig.json`, `pnpm exec tsc -p perf/hover/tsconfig.json`, and
`bun test ./src` (340 passed, 0 failed, 6,926 assertions). Benchmark/capture
gate tests passed (14 tests, 71 assertions). The signed final addon verifies
with `codesign --verify --strict`.

`drag-final.log` records the existing `src/tasks/round7b-check.ts` passing
before and after: task board/list quick add, saved-card reachability, carried
ghost tracking, drop, Escape cancellation, edge autoscroll without accidental
commit, and project drag/drop. Each board/list/project tracking file has 60
real pointer samples per addon. Evidence is in `drag/`. The checker source was
restored after the comparison.

The complete native updater additionally passed geometry/content/input,
eight theme/motion/region transform/translate combinations, Markdown/code/
diff selection, clipped hit tests, Explorer motion, rounded pixels, cached/full
PR pixels, and the 120-packet scroll burst distance/order checks. All build,
UI and measurement helpers are task scoped; final cleanup is recorded below.

Cleanup is complete: no owned Bun app/proxy/daemon, port 4342 listener, UI
queue entry, quiet marker or pending build remains. Open-file checks preceded
removal of the 1.9 GiB Rust target, task dependency installs/source checkout,
baseline/test binaries, compiled input helpers, raw in-repository benchmark
results and all `hr5-hover*` scratch data. Source, evidence and the final signed
addon plus its paired WebView dylib remain. `cleanup-*.json` records the check.

Disk free was about 80 GiB at the initial survey; the final native build
receipt records 80,488,198,144 bytes before and 80,269,328,384 after. Final
cleanup leaves 100,722,900,992 bytes (93.81 GiB) free (`df` rounds to
94 GiB). This is a shared APFS volume; the change is not attributed entirely
to this lane, and deleting directory bytes is not claimed as reclaimed space.
