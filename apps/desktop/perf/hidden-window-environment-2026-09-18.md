# Hidden-window environment card release

Issue: [#33](https://github.com/Tresnanda/kybern/issues/33). Constraint: [#37](https://github.com/Tresnanda/kybern/issues/37) item 3 — occlusion ≠ focus.

## What this slice does

When an environment window is **occluded, minimized, or page-hidden**, the desktop app unmounts the reconstructible **environment card body** (git/diff rows, finder actions, thread notes). The **wrapper stays** so the existing opacity/translate hide for an unfocused-but-visible window is unchanged.

**Blur is not compact permission.** Thread.tsx already passes `open={false}` when unfocused; that only fades the card. This slice does not unmount on that signal. Notes drafts live in localStorage and remount with the body.

Page Visibility is the signal (WebKit maps it to occlusion on macOS). A 400 ms delay avoids Mission Control flashes.

Independent of [PR #44](https://github.com/Tresnanda/kybern/pull/44), [PR #47](https://github.com/Tresnanda/kybern/pull/47), [PR #50](https://github.com/Tresnanda/kybern/pull/50), and [PR #51](https://github.com/Tresnanda/kybern/pull/51).

## What this VM could not prove

Linux cannot reproduce the Apple M1 two-window `vmmap` numbers. Verify on macOS 27 with the environment card requested open: cover or minimize (do not only click away), then `vmmap -summary` on that WebContent pid; showing the window must restore git/diff rows and any unsaved notes draft.

## Tests here

`apps/desktop/environmentWindowHold.test.mjs` covers blur vs occlusion, the delay, and that the body unmounts only while held.
