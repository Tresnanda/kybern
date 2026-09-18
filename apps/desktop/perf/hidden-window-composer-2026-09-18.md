# Hidden-window composer stacked-panel release

Issue: [#33](https://github.com/Tresnanda/kybern/issues/33). Constraint: [#37](https://github.com/Tresnanda/kybern/issues/37) item 3 — occlusion ≠ focus.

## What this slice does

When an environment window is **occluded, minimized, or page-hidden**, the desktop app unmounts reconstructible composer **`above` stacked panels**: queued follow-ups, approvals, questions, coordinator/helper/activity rails, and the empty-landing tray. The **composer input stays mounted** so drafts and attachment previews are not discarded (preview blob URLs are not in the store).

**Blur is not compact permission.** An unfocused window that is still on screen keeps stacked panels. Showing the window remounts them from the store.

Page Visibility is the signal (WebKit maps it to occlusion on macOS). A 400 ms delay avoids Mission Control flashes.

Independent of [PR #44](https://github.com/Tresnanda/kybern/pull/44), [PR #47](https://github.com/Tresnanda/kybern/pull/47), [PR #50](https://github.com/Tresnanda/kybern/pull/50), [PR #51](https://github.com/Tresnanda/kybern/pull/51), and [PR #54](https://github.com/Tresnanda/kybern/pull/54). Does not change composer glass CSS.

## What this VM could not prove

Linux cannot reproduce the Apple M1 two-window `vmmap` numbers. Verify on macOS 27 with queued prompts or an approval open: cover or minimize (do not only click away), then `vmmap -summary` on that WebContent pid; showing the window must restore the same queued prompts, approvals, and questions, and keep the draft plus attachment chips.

## Tests here

`apps/desktop/composerWindowHold.test.mjs` covers blur vs occlusion, the delay, and that stacked panels unmount only while held.
