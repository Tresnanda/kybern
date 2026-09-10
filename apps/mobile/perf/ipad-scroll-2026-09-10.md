# iPad thread scroll verification — 2026-09-10

Thread browsing intermittently jumped to the beginning of the loaded history on
an iPad Pro 11-inch (M4), running iPadOS 26.6.1. The user reproduced it while
streaming and while idle, in both a narrow window and full-screen. Android did
not show the same problem.

## Captured failure

A signed Release build, compiled with Xcode 27 beta 4 / the iOS 27 SDK, recorded
temporary numeric-only scroll, layout, follow-mode, and lifecycle events. It did
not record message content or credentials. Dependencies remained Expo 57.0.21,
React Native 0.86.3, and LegendList 3.3.10.

The user reproduced the failure on the physical iPad. With a 375 × 779-point
viewport, the trace captured two discontinuities:

| Previous offset | Next offset | Interval | List data rows |
| ---: | ---: | ---: | ---: |
| 10,057.5 | 0 | 34 ms | 76, unchanged |
| 8,091 | −9,988,930 | 16 ms | 85, unchanged |

The list did not remount at either discontinuity. There was no native
`onScrollToTop` event. Requests for earlier history followed the bad offsets;
they did not trigger the resets. Both resets followed changes between following
the end and browsing away from it.

## Cause and change

The thread disabled `maintainVisibleContentPosition` while following and enabled
it when the user dragged. In the installed React Native source, this also toggles
the scroll content's `collapsableChildren` setting. iOS captures a native anchor
before a mounting transaction and adjusts the offset after that transaction.
Changing anchoring and native child retention at this boundary can leave the
adjustment referring to a stale anchor.

LegendList's `ScrollAdjust` uses a 10,000,000-point bias. The magnitude of the
captured negative offset matches that internal anchor, rather than a user gesture
or a request to scroll to the beginning.

On iOS, the thread now keeps both data and size anchoring enabled continuously.
`maintainScrollAtEnd` still follows the existing follow-mode state. Android keeps
its previous configuration. Stable row keys, virtualization, history paging,
expansion state, and the existing visual materials remain intact.

## Verification

The same physical-device check with continuous anchoring captured 2,082 scroll
events, 111 drag starts and ends, and six explicit Latest actions over 78.9
seconds. A replay assertion that failed on both baseline discontinuities passed
with zero resets on the fixed trace. The captured fixed viewport was 375 × 779
points. The user confirmed that the requested repeated scrolling, Latest, and
window/full-screen check no longer teleported to the top.

An isolated iOS 27 iPad simulator also exercised the 400-turn synthetic fixture,
including paged history and browsing away from streamed text. Ordinary simulator
swipes did not reproduce the original failure, so simulator success alone is not
the evidence for this fix. A JavaScript mock cannot establish UIKit's native
mounting and anchoring behavior; the physical before/after traces cover that seam.

All temporary app instrumentation and the synthetic follow-mode timer were
removed before the final signed build. The narrow-window trace is a functional
regression check, not a frame-time, CPU, energy, or all-device performance claim.

The clean signed Release build, TypeScript check, all 83 mobile tests, Expo Doctor
(21 checks), and iOS and Android production exports passed. The final clean build
was installed and launched on the same iPad. No native dependency changed for
this scroll fix.

To repeat manually: open a long thread at Latest, repeatedly scroll away and back
with short and long gestures, use Latest again, and cross an earlier-history
boundary. Repeat while idle and streaming, in narrow and full-screen layouts.
Reading should stay at the selected messages; Latest should return to the end.
