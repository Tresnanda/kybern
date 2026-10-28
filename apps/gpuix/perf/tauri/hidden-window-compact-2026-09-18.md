# Hidden environment-window transcript compact

Issue: [#33](https://github.com/Tresnanda/kybern/issues/33). Constraint: [#37](https://github.com/Tresnanda/kybern/issues/37) item 3 — measure occlusion separately from focus.

## What shipped

When an environment window is **occluded, minimized, or page-hidden**, the desktop app reuses `compactThreadState` / `releaseCachedData` so that WebContent can drop reconstructible transcript DOM, diffs, and highlight/Markdown caches. A lightweight loading placeholder stays mounted. Showing the window rehydrates the open thread(s) and restores:

- reading position (follow vs saved turn/message)
- composer drafts and attachments
- queued prompts
- pending approvals and questions
- terminal tab ownership
- composer vs transcript focus

**Blur is not compact permission.** An unfocused window that is still on screen keeps its transcript mounted.

Native `apps/desktop/src-tauri/src/window_surface.rs` emits `{ occluded, minimized, focused }` per webview. React also listens to Page Visibility (WebKit maps that to occlusion on macOS, not to key-window focus).

## What this VM could not prove

Linux cannot reproduce the Apple M1 `vmmap` WebContent footprints from #33 (window A 409.8 MB / window B 417.6 MB). Two-window verification is still required on macOS 27, release Tauri:

1. Open two environment windows with a heavy transcript.
2. Cover or minimize the background window (do not only click away).
3. `vmmap -summary <webcontent-pid>` on the hidden window should fall toward the idle floor (~130 MB in the original report).
4. Show the window: reading position, drafts, attachments, queued prompts, approvals/questions, focus, and terminal tabs must match what was there.

Do not treat a Linux RSS sample as that result.

## Tests here

`apps/desktop/windowSurface.test.mjs` and `window_surface` Rust unit tests cover blur-vs-occlusion, pending-user-data survival, and restore hydration. They are not whole-app physical-footprint evidence.
