# Hidden-window dock pane release

Issue: [#33](https://github.com/Tresnanda/kybern/issues/33). Constraint: [#37](https://github.com/Tresnanda/kybern/issues/37) item 3 — occlusion ≠ focus.

## What this slice does

When an environment window is **occluded, minimized, or page-hidden**, the desktop app unmounts reconstructible right-dock pane bodies: explorer (file tree + up to 256 KiB highlighted preview), changes/diffs, artifacts, activity, and collaboration. The **tab strip stays**, and the **terminal pane stays mounted** so PTY ownership is unchanged here.

**Blur is not compact permission.** An unfocused window that is still on screen keeps those panes. Inactive dock tabs still use opacity/z-index (xterm mis-measures if `visibility: hidden`).

Page Visibility is the signal (WebKit maps it to occlusion on macOS). A 400 ms delay avoids Mission Control flashes.

Independent of [PR #44](https://github.com/Tresnanda/kybern/pull/44) (transcript compact) and [PR #47](https://github.com/Tresnanda/kybern/pull/47) (xterm dispose). Together they drop reconstructible DOM in a hidden WebContent process.

Showing the window remounts the open panes. Selected explorer path, right-tab set, and diffs stay in the store. Expanded folders, search text, and in-progress collaboration dialog fields are not in the #37 restore list and reload from the daemon.

## What this VM could not prove

Linux cannot reproduce the Apple M1 two-window `vmmap` numbers. Verify on macOS 27 with explorer/diff/artifacts open in the background window: cover or minimize (do not only click away), then `vmmap -summary` on that WebContent pid; showing the window must restore the same tabs, selected explorer file, and reconstructed pane bodies.

## Tests here

`apps/desktop/dockWindowHold.test.mjs` covers blur vs occlusion, the delay, and that only the terminal body stays mounted while held.
