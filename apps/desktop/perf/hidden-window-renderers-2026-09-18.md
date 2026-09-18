# Hidden-window renderer runtime release

Issue: [#33](https://github.com/Tresnanda/kybern/issues/33). Constraint: [#37](https://github.com/Tresnanda/kybern/issues/37) item 3 — occlusion ≠ focus.

## What this slice does

When an environment window is **occluded, minimized, or page-hidden**, the desktop app immediately releases reconstructible renderer runtimes that otherwise wait for idle:

- the mermaid **1024×768 nested document** (diagram engine module graph)
- the Shiki highlight worker
- the Markdown parser worker

Settled transcript markup, composer drafts, and attachment previews are untouched. Showing the window recreates a runtime only when the next diagram/highlight/parse job runs.

**Blur is not compact permission.** An unfocused window that is still on screen keeps renderer runtimes.

Page Visibility is the signal (WebKit maps it to occlusion on macOS). A 400 ms delay avoids Mission Control flashes.

Independent of transcript compact ([PR #44](https://github.com/Tresnanda/kybern/pull/44)) and xterm WebGL dispose ([PR #47](https://github.com/Tresnanda/kybern/pull/47)). Does not change `App.tsx` paint hosts, `kit.css`, or `ResponseImage`.

## What this VM could not prove

Linux cannot reproduce the Apple M1 two-window `vmmap` numbers. Verify on macOS 27 with a mermaid diagram (or highlighted code) in the hidden window: cover or minimize (do not only click away), then `vmmap -summary` on that WebContent pid; showing the window must keep drafts/attachments and restore diagrams from source.

## Tests here

`apps/desktop/rendererWindowHold.test.mjs` covers blur vs occlusion, the delay, that release runs only on hold, and that showing the window does not eagerly recreate runtimes.
