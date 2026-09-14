# Rendered-history memory

Follow-up to [issue #14](https://github.com/Tresnanda/kybern/issues/14), tested
against v0.3.9 (`ad6d0bc`) in an isolated worktree. The installed app and the
other agent's development session were not replaced or restarted.

## Reproduction

The earlier [memory comparison](memory-before-after-2026-09-07.md) exercised
stores and workers without a rendered transcript. Those protections still pass:
the native fixture retained no background text, released cached histories on
environment changes, and recreated workers after idle. This run measured
37.0 MiB at startup, 96.3 MiB after history visits, 43.3 MiB after changing
environment, and 57.1 MiB after worker idle.

The rendered scrolling fixture reproduces a separate graphics allocation spike
despite a bounded DOM. Its 160 historical turns contain prose, 24-line highlighted
code blocks and tables. Fast traversal mounts about 1,670 nodes but previously
reached 1.7–1.9 GiB peak physical footprint. A passive sample of the installed
app's associated WebContent process also showed 1.1 GiB current / 1.5 GiB peak;
that live sample was uncontrolled and is not the before/after comparison.

Experiments in fresh native processes isolated the relevant boundary:

| Fast-history experiment | Peak physical footprint |
| --- | ---: |
| Original rendering | 1.7 GiB |
| Scroll fade disabled | 1.8 GiB |
| Filters, transitions and promotion hints disabled | 1.9 GiB |
| Layout/style containment on rows | 1.6 GiB |
| Paint containment on the scroll viewport | 1.7 GiB |
| Paint containment on individual rows | 439.8 MiB |

`vmmap` reported roughly 2 GiB of owned graphics mappings during the original
fast traversal, versus about 215 MiB with row paint containment. Mapping sizes
are not interchangeable with physical footprint. These interventions identify a
reproducible paint-boundary problem; they do not identify every WebKit allocation
or prove the cause of the issue reporter's two-hour resting footprint.

## Change

Large outer virtual lists give each mounted row a paint boundary. Small lists
and nested tool lists retain their existing paint context: applying containment
to every nested row increased the cost of the dense work fixture. The wrapper
stays mounted as a list crosses the virtualization threshold, preserving DOM
identity. Its 8px padding and negative margin leave room for gutter controls,
focus rings and entry motion without changing text positions or measured heights.

[Paint containment clips descendants to a box](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/contain),
so the interaction fixture also checks the outside edge of the actual message
copy action. Selection, keyboard focus, wrapping, disclosures, navigation and
scroll anchoring retain their existing tests. No visual effects were removed.

## Comparison

Apple M1, 16 GiB, macOS 27.0 (26A5416b), system WKWebView, 1100 × 720 viewport,
production frontend/CSP at `tauri://localhost`. Fresh processes, synthetic data,
no live provider. `vmmap -summary` samples run outside the timed scroll loops;
the peak column is the process lifetime peak. No explicit GC was forced.

The clean baseline and final implementation run the same eight scenarios, with
200 frame steps per scenario. One complete sample per version is shown below;
the preliminary experiments above used separate processes. Normal user activity
and other development work continued, so these are regression measurements, not
an idle-machine benchmark or a confidence interval.

| Stage | Baseline current | Final current | Baseline lifetime peak | Final lifetime peak |
| --- | ---: | ---: | ---: | ---: |
| Cold history | 285.8 MiB | 330.7 MiB | 378.1 MiB | 331.7 MiB |
| Revisited history | 345.1 MiB | 248.8 MiB | 532.0 MiB | 348.5 MiB |
| Fast history | 1.3 GiB | 389.0 MiB | 1.8 GiB | 426.0 MiB |
| Mixed work | 528.8 MiB | 601.0 MiB | 1.8 GiB | 739.8 MiB |
| Mixed work streaming | 523.2 MiB | 571.0 MiB | 1.8 GiB | 745.8 MiB |
| Expanded thinking | 491.1 MiB | 578.5 MiB | 1.8 GiB | 789.5 MiB |
| Expanded tools | 549.7 MiB | 530.2 MiB | 1.8 GiB | 789.5 MiB |
| Long code | 342.9 MiB | 361.9 MiB | 1.8 GiB | 789.5 MiB |

Fast-history peak falls approximately 77%; the full sequence peak falls about
57%. Current memory did not improve at every stage. The final sequence preserves
all 1,600 nonempty sampled viewports, 17–19 ms frame p95, and at most 2.25px
visible anchor movement. Earlier diagnostic runs had timing/anchor outliers on
both the baseline and candidates. This change does not claim a fix for every
scrolling stall, whole-app RAM, CPU or energy use.

A subsequent unchanged candidate run measured 417.7 MiB history peak and
931.4 MiB full-sequence peak. Its memory budgets passed, but one expanded-tool
frame took 116 ms and failed the existing 100 ms worst-frame assertion. The
runner reports memory and rendering verdicts separately and still fails if
either fails. The dense-work measurements and frame outlier remain evidence of
work outside the fast-history allocation fix.

The final repeat passed both rendering and memory assertions: 412.5 MiB history
peak, 801.5 MiB full-sequence peak, and no frame above 20 ms in that run. The
116 ms sample above is retained rather than excluded from the findings.

## Regression check

From `apps/desktop` on macOS:

```sh
node scripts/check-rendering-memory.mjs
node scripts/check-rendering.mjs interaction
KYBERN_PERF_WIDTH=480 node scripts/check-rendering.mjs interaction
node scripts/check-rendering.mjs scaling
node scripts/check-rendering.mjs work-stream
```

The new runner keeps all scrolling/content assertions and requires native peak
measurements. History stages have a 768 MiB guard; the subsequent 800-tool stages
have a separate 1 GiB guard. These are fixture budgets with headroom above the
observed candidate, not application memory caps. The original implementation
fails both budgets at 1.8 GiB while passing the existing scrolling assertions.

The standalone store/worker memory fixture remains useful but cannot substitute
for this rendered workload. Long-session resting memory and large visible tool
payloads remain outside the controlled comparison; this report does not close
the broader investigation in issue #14.

Frontend validation: 132 unit tests, typecheck, lint and production build pass.
Native interaction checks pass at 1100px and 480px, including the message-action
edge hit test, selection/focus, wrapping, disclosure state, thread switching and
all follow gestures. Scaling, work-stream, history paging and rendering fixtures
pass: exact formatted output, 30/30 retained historical code wrappers, no mixed
work collisions, and bounded mounted history/work are preserved. Screenshots
were inspected locally. The build retains its existing chunk-size and mixed
static/dynamic import advisories. No Rust or shared-client code changed.

Removing the 8px bleed in a throwaway copy makes the narrow interaction test
fail at the copy action's outside edge; restoring it passes. This guards the
actual interactive overflow rather than only asserting a CSS property.
