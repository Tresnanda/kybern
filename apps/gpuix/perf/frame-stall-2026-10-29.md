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
