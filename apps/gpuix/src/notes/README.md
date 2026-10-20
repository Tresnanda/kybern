# Native Notes

The desktop gallery model (`state/notesModel`) and conservative line merge
(`state/noteLines`) are imported directly. Geometry follows desktop `notes.css`:
248 px minimum cards, 20 px column gaps, 156/184 px thumbnails, a 640 px
document column, 12/13/15/28 px type scale. Thumbnails use summary text.

`NotesPage` mounts the gallery or `NoteEditor`; leaving Notes unmounts the page.
`store` owns the notification feed, display preferences and overlay requests.
`NotesOverlays`, mounted with the existing palette, registers ⌘⇧N and the
Notes-specific ⌘N, and renders quick capture and the save picker only when open.

The transcript's entry point can call:

```ts
import { openSaveToNote } from '../notes/store.ts'
openSaveToNote({ text, threadTitle, threadId })
```

The picker quotes the text and appends the desktop's original-thread link. It
uses expected revisions; a conflict keeps the picker and original capture open.
The transcript-owned button is deliberately left to that surface's owner.

## Editing and persistence

The note body is the shared formatted editor (`../editor/`, README there): one
native `<rich-editor>` for the whole document, edited in place with the reading
look, the desktop's toolbar (`Toolbar.tsx`, desktop `NoteToolbar`), slash menu,
link bubble, live task references, images and "Make task" on checklist lines.
The page is one scrolling column (meta line, title, body, the blank space below
that focuses the end); the outline reads heading positions from the editor's
state. Quick capture and the compact thread/dock note use the same editor.
Markdown is written back losslessly: unchanged blocks keep their exact source.
The title and body save after 500 ms, on blur, window hiding and unmount.

`session` serializes writes, retains newer typing during an in-flight request,
persists unsaved drafts, merges only unambiguous remote line edits, and offers
Use theirs / Keep mine for overlap. Network errors retry only while an edited
session is mounted, with a 1–15 s backoff. Idle saved sessions have no timers.
Drafts remain after failures. Deleted notes are read-only until restored.

Display choices use `kybern.notes.display`; quick drafts use
`kybern.notes.quick`; note drafts use `kybern.notes.draft:env:note:<id>` in the
per-environment store. Desktop's `lastOpenId` is memory-only on this base;
GPUIX additionally persists it as `kybern.notes.lastOpenId`.

## Verification

From `apps/gpuix`, export the patched library specified by `PORTING.md`:

```sh
pnpm typecheck
KYBERN_DATA_DIR=/Users/mymac/projects/ade-gpuix-scratch/data bun src/notes/session.verify.ts
bun src/notes/verify.ts
```

The integration scripts refuse or explicitly select the scratch daemon, remove
only their created notes and close their native windows. `NOTES_SKIP_PERF=1`
omits the three 15 s samples. Screenshots are outside the worktree, in
`/Users/mymac/projects/ade/previews/gpuix/notes/`.

October 15, 2026: Apple M1, macOS 27.0, Bun 1.4.0, patched GPUIX 0.10.0,
1280×820 background window; six fixture notes plus the scratch project's notes.
Initial screenshot/interaction session, 15 s samples using `perf/sample.ts`
(daemon excluded; capture buffers inflate the footprint):

| Workload | CPU | Physical footprint | Metal GPU time |
| --- | ---: | ---: | ---: |
| Gallery idle | 2.67% | 280 MiB | 3.3 ms |
| Document idle | 2.40% | 298 MiB | 1.0 ms |
| Active block, 70 single keys over 15 s | 10.73% | 298 MiB | 0.0 ms |

Single-key automation round-trip: p50 13.34 ms, p95 21.86 ms, max 25.21 ms.
These include locator/IPC overhead, not hardware-to-photon latency. Whole-string
`fill()` takes 1–2 s and can finish before the final JS change callback; tests
wait for the expected saved content. Background-window GPU values are lower
bounds. No energy measurement or equivalent Tauri comparison was made.

Passed: lossless segmentation, remote line merge, overlapping conflict and both
choices, recovered drafts, in-flight typing plus unmount, network retry, native autosave,
Gallery/List and search, Pin/Delete/Restore, quick capture, palette results,
dark/light screenshots. No native build or dependency installation was needed.

### Fresh memory follow-up

`bun src/notes/memory.verify.ts` launches two fresh background windows with the
same six short notes and existing scratch project, visits the same four scenes,
and measures each for 15 s without taking screenshots:

| Scene | Run 1 footprint / CPU / GPU ms | Run 2 footprint / CPU / GPU ms |
| --- | --- | --- |
| Fresh Home, Notes never opened | 176 MiB / 2.53% / 0.8 | 163 MiB / 3.00% / 0.6 |
| Gallery | 180 MiB / 3.20% / 0.0 | 174 MiB / 1.93% / 0.0 |
| Document, five native blocks | 186 MiB / 2.80% / 0.0 | 200 MiB / 2.73% / 4.7 |
| Back Home, Notes unmounted | 189 MiB / 2.53% / 0.5 | 195 MiB / 2.33% / 0.0 |

Gallery adds 4/11 MiB, below the 30 MiB review threshold. No additional preview
truncation was necessary: cards already render the daemon's ≤240-character
plain-text summary, never the body, and native virtual lists contain both gallery
rows and document blocks. This small-note workload does not certify giant-block
or image-heavy documents.

After the four-scene comparison, four screenshots of the same Home raised run
1 from 189 to 256 MiB (2.67% CPU, 0.4 ms GPU). Capture allocation explains much
of the initial 280–298 MiB measurement. The numbers above compare the existing
implementation before/after opening Notes, not an invented optimization delta.

## Visual parity with the desktop

`visual/README.md` describes the side-by-side tool. The gallery, list, editor
chrome and the Tasks screens were matched to desktop measurements:

- The title bar carries the surface header (`nav/TitleBar.tsx` → `notes/Header.tsx`,
  `notes/EditorBar.tsx`, `tasks/Header.tsx`), as `SurfaceHeader` does on the
  desktop; the search text lives in the Notes store (`query`) so the header can own
  the field.
- Gallery tokens are `notes/kit.tsx` (`--n-*` mixes of the ink, `ProjectDot`,
  `Ring`). Thumbnails (`NoteThumb.tsx`, `thumbs.ts`) draw the desktop's pure
  `miniMarkdown` blocks at `--n-read` (16.15 px) times 0.6 / 0.66 / 0.74 / 0.8.
- The editor column is 640 px with the desktop's `.note-prose` rhythm: .93 em
  between blocks, 2.25 / 2 em (of the 18.3 px heading) above h1 / h2, 1.6 em above
  h3, .53 em below a heading.

Not expressible without native work (GPUIX 0.10.0 markdown theme): list marker
colour/size and indent (desktop 22.6 px, dim 5 px dot / dim ordinal), a flat
block quote (2 px bar, no fill), hiding the code block header, letter-spacing
(`-0.022em` titles) and inline `strong`/`code` spans inside thumbnails.
