# Hidden-window terminal view release

Issue: [#33](https://github.com/Tresnanda/kybern/issues/33). Constraint: [#37](https://github.com/Tresnanda/kybern/issues/37) item 3 — occlusion ≠ focus.

## What this slice does

When an environment window is **occluded, minimized, or page-hidden**, the desktop app disposes that window's xterm views and WebGL addons (the 5,000-line local scrollback). **Tab ownership and the daemon PTY stay.** Showing the window recreates xterm and refills it with `terminals.subscribe` replay (daemon 512 KiB ring).

**Blur is not compact permission.** An unfocused window that is still on screen keeps xterm mounted. Inactive dock tabs still use opacity (xterm mis-measures if `visibility: hidden`).

Page Visibility is the signal (WebKit maps it to occlusion on macOS). A 400 ms delay avoids Mission Control flashes.

Independent of [PR #44](https://github.com/Tresnanda/kybern/pull/44) (transcript compact). Together they drop reconstructible DOM in a hidden WebContent process.

## What this VM could not prove

Linux cannot reproduce the Apple M1 two-window `vmmap` numbers. Verify on macOS 27 with a terminal open in the background window: cover or minimize (do not only click away), then `vmmap -summary` on that WebContent pid; showing the window must restore the same tabs and a replayed PTY view.

## Tests here

`apps/desktop/physicalWindow.test.mjs` covers blur vs occlusion and the delay. Native `terminal-memory` still checks inactive-tab WebGL release.
