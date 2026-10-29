# Frame stalls: "the whole UI is stuck until I move or minimize the window"

User report (0.19.1, MacBook built-in Retina plus a 1x 60 Hz GA271, macOS 27): at random the whole Kybern
window stops updating; minimizing and restoring it, switching Space, or dragging it brings it back.

## Where frames can stop

The window draws only when its display's `CVDisplayLink` calls `step` (`gpui_macos/src/display_link.rs`,
`window.rs`). On macOS the link runs for as long as the window is visible, even when idle (about 58 frames/s on an
idle lab window), and the JS loop pumps AppKit at least every 100 ms through its fallback timer. A frozen but
responsive window is therefore in one of these states:

| State | Cleared by | Watchdog |
| --- | --- | --- |
| The display's link stopped calling back, the registry still says it runs | minimize, Space switch, a move to another display (measured below), becoming key (by the code: each drops the last subscriber, which stops and restarts the link) | restart, then replace the link |
| Window visible but subscribed to no link (`start_display_link` found no screen while displays were reconfigured, or an occlusion read was stale) | the same | re-subscribe |
| Subscribed to a display it has left | a move or screen change | re-subscribe to the current screen |
| A draw got no drawable (`nextDrawable` waits up to 1 s; seen 130 ms–1.15 s under GPU load in an earlier session) | anything that draws again | present the scene again after 100 ms, backing off to 1.6 s |

The registry keeps one immortal link per display (Zed's fix for the teardown crashes), so a link that dies stays dead
until every window on that display unsubscribes. CoreVideo links that silently stop calling back have been reported on
Apple silicon ([Apple Developer Forums 706910](https://developer.apple.com/forums/thread/706910)).

## What did not reproduce it

All with the watchdog in `KYBERN_FRAME_WATCHDOG=log` (report only), on hidden virtual displays (1440×900 @2x, 60 Hz):

- `CVDisplayLinkStop` immediately followed by `CVDisplayLinkStart` on the same link: 5,600 cycles on the built-in and
  the GA271 displays, gaps 0–100 µs, run 1–20 ms. No link went dead.
- 12, then 80, mode changes of the window's display (60↔30 Hz, 2x↔1x, 1440×900↔1280×800), the last 80 while the window
  hopped between two virtual displays every 400 ms: no stall.
- Removing and re-adding a second display 15 times (new display ids each time): no stall.

Real display sleep and wake was not tried: it would have slept the user's own screens.

## Fault injection (`native/frame-stall-check.ts`)

`KYBERN_FRAME_STALL_TEST` puts the lab window into each state; the lab samples the served-frame counter every 20 ms
and counts a gap over 200 ms as a stall, apart from the watchdog's own verdict.

| Fault | Watchdog `log` (old behaviour) | Watchdog on |
| --- | --- | --- |
| `silent-link` every 2 s, 60 s | frozen for good after the first one (180 frames, then none for 15 s) | 29/29 repaired, ~304 ms each (250 ms threshold + up to 100 ms check interval) |
| `unsubscribe` every 2 s, 60 s | frozen for good | 29/29 repaired, ~304 ms each |
| `dead-link` (restart does not help) every 4 s, 40 s | — | 10/10 recovered: restart at ~300 ms, replacement at ~800 ms |
| `drop-drawable` on each 1 s color change, window captures 400 ms after each | 4/8 captures show the previous frame | 0/8, twice |

With a silenced link and the watchdog reporting only, four moves within the same display over 6 s left the window
frozen (1795 → 1795 frames); hopping to the other display revived it (1880 → 2239). So if the user's freeze is a dead
link, a drag that stays on one display would not clear it, while minimize, Space switch and re-focusing would.

## Cost

Idle lab window (no redraws), process CPU time over 30 s, two rounds: watchdog off 0.47 and 0.53 s, on 0.52 and 0.44 s
(≈1.6% either way). The check reads two AppKit properties per visible window at most every 100 ms, only from the pump
that already runs. No stall was reported in any run without an injected fault.

## Limits

The trigger in the field is still unproven: each state above was injected, not observed. When it happens again,
`~/.kybern/gpuix-frames.log` names the state (`SilentLink`, `Unsubscribed`, `StaleDisplay`, or dropped drawables)
with the link's registry and CoreVideo state. If the log stays empty during a freeze, the cause is outside these states
(a missed invalidation or a stale cached view, which a same-display move's `refresh()` would also clear) and needs a
`sample` of the app while stuck.

## Drawable starvation (the sampled freeze)

A `sample` of the installed 0.17.0 while frozen (16:58, one 1440×900 window on the built-in Retina display) showed
none of the states above. The `CVDisplayLink` thread was healthy (idle in `CVDisplayLink::waitUntil`), and the main
thread was in `step` → `Window::present` → `MetalRenderer::draw` → `-[CAMetalLayer nextDrawable]` →
`semaphore_timedwait` in 995 of 2041 samples on one pump path and most of the other; render and present appeared in
about 15. So every frame waited about a second for a drawable and then drew. Input and JS run on that thread, so
nothing else happened. The power log puts the display dimming and turning off a few minutes before (keep-awake
assertion released 16:52:57, `delayDisplayOff` timed out 16:57:57); not confirmed.

What a standalone harness showed (an embedded pump like `pump_app_nonblocking`, a `CAMetalLayer` drawn from a
display-link dispatch source, 3 drawables, `allowsNextDrawableTimeout` NO as in GPUI, on the hidden test display):

- `nextDrawable` with the compositor holding the pool waits about 1 s (1002–1028 ms measured) and then returns a
  drawable, not nil. The 0.19.2 dropped-drawable re-present therefore never runs in this state, and the 0.19.2 log
  writes nothing for it (only nil drawables and display-link stalls raise an event).
- Rejected: drawables presented with `presentsWithTransaction` inside a `CATransaction` that has not committed do
  not starve the layer. Five such frames inside an open outer transaction got their drawables in 1–9 ms, and so did
  three more after each of flush, `drawableSize` nudge, `presentsWithTransaction` off and the outer commit.
- Drawables the app retains without presenting never count against the pool (6 handed out with a limit of 3).
- No condition tried makes the compositor stop taking a visible window's drawables for longer than one wait: a
  covering window (1 s wait in 2 of 6 occlusions, before AppKit reported the occlusion; 0 in 60 more), miniaturize,
  window alpha 0, a hidden layer, layer opacity 0, `presentDrawable:atTime:` 4–30 s ahead (later presents
  supersede the queued ones), `NSDisableScreenUpdates` held, and virtual-display rates down to 24 Hz (the lowest
  `CGVirtualDisplay` accepts). Real display sleep was not tried: it sleeps the user's screens.

So the trigger is unproven. The cause of the freeze itself is that GPUI blocks the main thread in `nextDrawable` for
as long as the compositor keeps the pool, about a second per frame for every frame.

### Fix: the drawable gate (`gpui_apple/src/drawable_gate.rs`)

See the README's frame watchdog section. A draw with two presented drawables still unshown (their presented
handlers have not run) waits at most until the older is 100 ms old, then is skipped instead of calling
`nextDrawable`; the window presents the scene again later. The layer is kicked (CA flush, `presentsWithTransaction`
off, `drawableSize` nudged) at 100 ms, backing off to 3.2 s, and a draw is retried as soon as a handler runs.
Each episode's start and end go to `gpuix-frames.log` with its length, skipped draws, kicks and what cleared it.

`KYBERN_FRAME_STALL_TEST=starve-drawables:5000` emulates the stalled compositor (handlers held back for 3 s after
every 5 s of normal drawing, `nextDrawable` blocking 1 s while the pool is empty) under the lab's 20 Hz redraw;
`labMaxLateMs` is the lateness of a 20 ms JS timer, which runs on the main thread. 17 s runs of `frame-stall-check.ts`
(two stalled periods each), five runs per row:

| | timer delays over 200 ms | longest delay | episodes (ended in the run) | draws skipped |
| --- | --- | --- | --- | --- |
| gate off (`KYBERN_DRAWABLE_GATE=0`, as 0.19.2) | 3–8 per run | 997–1001 ms | none detected | 0 |
| gate on | 0 | 2–9 ms | 10 (9; the last of one run was still open) | 102–117 per run |

With the gate on the window shows the current frame again after an episode: 12 of 12 captures 400 ms after a color
change, 1–3 s after the emulated stall ended (four runs). The no-fault run reports no starvation and skips no draw.

Normal pacing, lab window on the hidden display, process CPU over 30 s after a 5 s settle, two rounds:

| | gate off | gate on |
| --- | --- | --- |
| idle (no redraws) | 0.51, 0.34 s | 0.48, 0.38 s |
| 20 Hz redraw | 2.14, 2.18 s | 2.17, 2.11 s |

No starvation, skipped draw or slow drawable in any of them. The compositor-loop lab (`perf/motion-fps/lab-check.ts`,
dark, light, reduced and `KYBERN_COMPOSITOR_LOOPS=0`) and the other on-screen checks in `check-update.sh` pass, except
`font-weight-check.ts`, which needs Playwright's WebKit (not installed on this machine). Two checks failed once
and pass on rerun, with the gate off as well as on: `drop-drawable` with the watchdog on (1/8 captures stale, also
in 1 of 3 gate-off runs) and `dead-link` (gate on: once 0 stall reports and one 10.9 s gap in 5 runs; gate off: once
a 1452 ms gap in 3).

### Real display sleep (not run)

With the user's consent, on the built-in display, gate off and then on:

```sh
cd apps/gpuix
D=$(mktemp -d /private/tmp/kyb-sleep.XXXX)
for gate in 0 1; do
  KYBERN_DRAWABLE_GATE=$gate KYBERN_DRAWABLE_TIMES=1 KYBERN_DATA_DIR=$D KYBERN_URL= KYBERN_NO_ACTIVATE=1 \
    bun native/frame-stall-lab.tsx 2> "$D/lab-$gate.log" &
  sleep 8; pmset displaysleepnow; sleep 90; caffeinate -u -t 2; sleep 30
  kill $!; wait
done
grep -hE 'frame-drawable|frame-watchdog' "$D"/lab-*.log
grep -h labBlocks "$D"/lab-*.log | tail -2
```

Expected if display sleep is the trigger: with the gate off, `[frame-drawable] ~1000 ms` lines during the sleep,
`labBlocks` climbing, and (if the freeze outlives the wake) the lab's tick counter stuck on screen until the window
is moved. With the gate on: a `DrawableStarved` start and end line instead, `labBlocks` flat, and the end line
naming what cleared it (the compositor resuming, or a kick).
