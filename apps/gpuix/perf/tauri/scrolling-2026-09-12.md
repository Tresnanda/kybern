# Scroll position and frame pacing

## Reproduction and fix

The active-work fixes did not establish smooth scrolling. A frame-only check
reported 18 ms p95 while visible content still jumped. The new `scrolling`
fixture tracks an intersecting paragraph, code block, or work label across
each requested movement. It samples again after the animation-frame callback
and a timer yield so ResizeObserver and paint work can finish. The residual
movement of the same DOM node measures a content jump; a change to `scrollTop`
alone can be legitimate compensation for newly measured offscreen content.

Three interacting problems affected `VirtualRows`:

- The library normally postpones mount measurements while scrolling. With
  rows in normal flow, a new overscan row already affects its neighbours at
  its actual height. Measure those mounts in the same React commit.
- Resize compensation could use a cached offset from before the latest user
  movement. Apply the delta to the current DOM offset and synchronize the
  library's cursor, preserving the latest movement.
- Cached row positions could lag newly inserted normal-flow siblings. A row
  still visible on screen was then treated as entirely above it. For an
  existing measurement, test the actual DOM bottom minus the size delta: this
  identifies where the row ended before the change. Observe sizes before paint
  and retain ordinary React updates rather than forcing a commit per resize.

Previously measured rows wholly above the viewport also compensate in both
scroll directions, including when asynchronous Markdown formatting changes
their height. Partially visible growing rows keep their top fixed. Normal-flow
layout still prevents read/edit overlap. Virtualization, selection/focus pins,
code formatting, transitions, scroll fades, and follow behaviour are retained.

The remount regression then exposed a separate auto-follow race. WebKit can
deliver a layout-generated scroll event at the same offset after an upward
gesture. If the conversation is short, treating every such event as a return
to the bottom resumes following and pulls the reader down when work arrives.
`MessageScroller` now requires downward input and movement before resuming,
including wheel, keyboard, scrollbar and touch handlers. Leaving the live edge
takes effect before a synchronous provider update can arrive. A pending virtual
scroll-to-index target must also be cancelled: otherwise it can reconcile to
the new bottom after following has already stopped. Manual gestures replace
that target with the current offset and cancel pending navigation alignment.
The work fixture interrupts a pending follow before a virtualization-threshold
crossing and checks both reading position and the full thinking text.

## Measurements

Apple M1, 16 GB RAM, macOS 27.0 (26A5416b), system WKWebView, production frontend
bundle at `tauri://localhost` under the production CSP. No live provider.
One fixture window runs at a time; the normal app/daemon stays untouched.

The cold-history comparison changes only `VirtualRows` against the rest of
the working tree. It uses 160 historical turns with paragraphs, highlighted
24-line code blocks, and tables. Two hundred frame steps request movement in
both directions, starting near the bottom. In the final comparison, 113 baseline
and 112 current steps actually moved; other steps were clamped at an edge.
Both runs retained a measurable anchor in 199 frames. The fixture reports
moving-frame p95 separately so clamped steps cannot hide slow movement.

| Cold-history implementation | Maximum visible jump | Frame interval p95 |
| --- | ---: | ---: |
| Original HEAD absolute rows | 28 px | 19 ms |
| Final mount, offset, and DOM anchoring | 1.04 px | 18 ms |

The anchor check includes partially visible paragraphs and code, not just
elements whose top edge remains on screen.

Keep whole turns in normal flow as well as nested work. Absolute positioning
failed the adjacent-turn expansion check (9 overlapping sampled frames).
Forcing React commits for every resize avoided jumps but raised the separate
401-turn teleport test from 26 ms p95 to 34–36 ms. DOM-based anchoring preserves
normal flow and measured 26 ms, matching the original code's 26 ms in that
paired check. The final full-suite repeat measured 24 ms. It retained 8 messages
and 454 DOM nodes, with 18 ms streaming intervals and a 15 ms synthetic
input-event-to-next-frame p95.

The final full 1100 × 720 run measured 200 frames per scenario:

| Scenario | Moving-frame p95 | Worst frame | Maximum visible jump |
| --- | ---: | ---: | ---: |
| Cold history | 18 ms | 20 ms | 1.04 px |
| Revisit history | 18 ms | 19 ms | 1.04 px |
| Fast history traversal | 18 ms | 44 ms | 1.04 px |
| 800 thinking/tool pairs | 18 ms | 18 ms | 0 px |
| Same work, with 32 ms stream updates | 19 ms | 21 ms | 0 px |
| Expanded thinking | 18 ms | 19 ms | 2.25 px |
| Expanded 800-tool group | 18 ms | 18 ms | 0 px |
| One 5,000-line code block | 18 ms | 20 ms | 0 px |

The fixture records actual moving-frame and retained-anchor counts and fails
if either is too small. Long code must retain its fenced structure and exact
text; its existing size limit intentionally skips syntax tokenization. Mounted
DOM peaks at 1,663 nodes in this run. Revisit and fast phases include previously
visited content but do not imply that every traversed row or highlight is cached.

The 480 × 720 run also passed all eight scenarios: moving-frame p95 was
18–20 ms, and maximum residual movement was 2.41 px. Both sizes had zero empty
viewports across 1,600 sampled frames and no reported browser errors. The
thinking/work fixture passed at both widths with zero tool or adjacent-turn
collisions, including expansion, collapse, remount and delayed measurements.

These are synthetic JavaScript scroll trajectories in native WebKit, not
physical trackpad or OS input-to-screen measurements. Most frame intervals
were already near the display cadence; the main measured improvement is
position stability. Uncached fast traversal still has occasional longer frames.
An earlier run recorded a 203 ms frame, and a later diagnostic run had a
27-second interval; neither is explained or evidence of universal stall removal.
The final repeat above passed without those outliers. Disabling the scroll fade
did not reliably improve timing, so its appearance and animation are unchanged.
Diagnostic memory samples reached approximately 1.7 GB physical-footprint peak;
no controlled memory reduction, CPU improvement, or energy saving is claimed.

## Running the checks

From `apps/desktop`:

```sh
node scripts/check-rendering.mjs scrolling
KYBERN_PERF_WIDTH=480 node scripts/check-rendering.mjs scrolling
node scripts/check-rendering.mjs work-stream
node scripts/check-rendering.mjs interaction
node scripts/check-rendering.mjs history
node scripts/check-rendering.mjs scaling
```

`KYBERN_SCROLL_SCENARIO` selects one named scenario;
`KYBERN_SCROLL_FRAMES` changes the frame steps per direction.
`KYBERN_SCROLL_MEMORY=1` records native memory outside the timed loops and the
runner prints the fixture's WebContent PID for optional profiling. This
diagnostic configuration should not be mixed into timing comparisons.

The broader checks cover delayed row measurements, repeated threshold
crossings, thinking collapse/reopen/remount, exact final text, navigation,
wrapping, focus/selection, reading position during prepends, and output follow.
Interaction, history, scaling, rendering and Activity fixtures passed. Returning
to the bottom through synthetic wheel, keyboard, scrollbar and touch events
resumed following. The 4,000-task Activity list kept 15 mounted rows and no active
timers while hidden.
The existing scaling fixture uses larger scroll teleports than this trajectory;
its separate timing should not be combined into a universal frame-rate claim.

These fixes are local source changes. The full native app build remains blocked
by the Rust E0463 proc-macro loading failure recorded in the
[active-work report](work-stream-2026-09-12.md); the installed app and its normal
daemon have not been replaced.

Final frontend validation: all 118 unit tests, typecheck, lint, production build,
and `git diff --check` passed. The production build retains its existing
large-chunk advisory. No Rust code changed in this scrolling follow-up; the
workspace tests, formatting and Clippy results are recorded in the active-work
report.
