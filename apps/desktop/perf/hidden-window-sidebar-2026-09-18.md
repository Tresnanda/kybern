# Hidden-window sidebar list release

Issue: [#33](https://github.com/Tresnanda/kybern/issues/33). Constraint: [#37](https://github.com/Tresnanda/kybern/issues/37) item 3 — occlusion ≠ focus.

## What this slice does

When an environment window is **occluded, minimized, or page-hidden**, the desktop app unmounts reconstructible sidebar project/thread rows (and the environment switcher). The **drag-region header, app menu, search, and footer stay** so traffic lights and window chrome remain.

**Blur is not compact permission.** An unfocused window that is still on screen keeps the thread list. This is not a sidebar paint-host or stacking-context change.

Page Visibility is the signal (WebKit maps it to occlusion on macOS). A 400 ms delay avoids Mission Control flashes.

Independent of [PR #44](https://github.com/Tresnanda/kybern/pull/44) (transcript compact), [PR #47](https://github.com/Tresnanda/kybern/pull/47) (xterm dispose), and [PR #50](https://github.com/Tresnanda/kybern/pull/50) (dock pane bodies). Showing the window remounts the list from the store (collapsed projects, selection, notifications).

## What this VM could not prove

Linux cannot reproduce the Apple M1 two-window `vmmap` numbers. Verify on macOS 27 with two environment windows: cover or minimize the background one (do not only click away), then `vmmap -summary` on that WebContent pid; showing the window must restore the same projects, selection, and collapsed state.

## Tests here

`apps/desktop/sidebarWindowHold.test.mjs` covers blur vs occlusion, the delay, and that the list unmounts only while held.
