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

Editable prose stays in a formatted native input (`RichTextarea`); focusing it
does not reveal Markdown delimiters or link destinations. `rich-text.ts` maps
the visible UTF-16 text and semantic ranges to source-positioned CommonMark/GFM
from the desktop parser. Text edits patch source ranges; only a formatting action
serializes its touched parsed block with the standard mdast serializer. Unchanged
source round-trips exactly, including images, titled/reference links, arbitrary
code fences/spans, tables, definitions and entities. A reparse verifies visible
text before a source change can be published. Selection marks and links change the selection;
block formatting still applies to the current virtual block. Image blocks retain the existing native image host. `RichDocument` keeps mixed
code and following paragraphs editable, and renders table cells as formatted
native inputs in a native grid. An edited paragraph keeps its scope stable across
source echoes when Return creates another paragraph. Dividers keep their display host. The slash chooser is a floating native layer.
The title and body save after 500 ms, on blur, window hiding and unmount.

The formatted editor keeps a 200-entry history including formatting-only
changes and saved selections, with 800ms typing groups. Marked IME text stays
in the native editor; formatting and history shortcuts do not consume composition
keys. A committed composition publishes one document history entry. A real input
method still needs a manual integration check.

Round 5 references: desktop `NoteBody.tsx`, `FormatBar.tsx`, `editorExtensions.ts`,
`slashItems.ts`, `components/kit/chat/ComposerEditor.tsx`, and
`views/tasks/TaskDetail.tsx`. Tasks use the same formatted buffer. Composer tokens
use `composer/TokenTextarea.tsx` and `token-text.ts`: inline atomic display labels,
source/display selection conversion, raw-token keyboard copy/cut, and completion
transactions with their own history. They no longer duplicate mentions above
the editor.

`bun scripts/rich-editor-check.ts` and `bun scripts/rich-document-check.ts` each passed in four native configurations (dark/light, Reduce Motion off/on), using the integration native binary read-only.
It checks actual painted formatted text, selection formatting and restored
selection on undo, redo, atomic token movement/deletion, raw source offsets,
undo of mention insertion and reversed selection restoration. The mixed-document fixture also checks a real native image, literal code, editable later prose, formatted table cells and undo, exact untouched image/code source, and Return+typing across source echoes. Screenshots are in the original conversation at
`previews/gpuix/round5/rich/`. These are GPUIX fixtures compared with desktop
source; no matching live Tauri screenshot or 1:1 visual certification was made.

Remaining editor parity work: one native document selection and history across
virtual Notes blocks; exact list/quote/nested-block layout and mixed heading
sizes and code-block wash/metrics; native inline token icons and full layout padding; selection and link
bubbles; task-description slash commands and image insertion/resizing; formatted clipboard HTML and native
Edit-menu commands; a real IME and clipboard integration pass. Current inline
code has a wash but not its own monospace run, and strike is retained in Markdown
but only dimmed by the current decoration primitive. The CommonMark/GFM source model preserves document nodes, while the native
presentation still lacks some ProseMirror behaviors. Complex inline images
retain a native image host below their containing paragraph rather than exact
inline geometry. Images and tables are not replaced by source text. Do not treat
typecheck or the fixture's successful checks as complete editor parity.

`session` serializes writes, retains newer typing during an in-flight request,
persists unsaved drafts, merges only unambiguous remote line edits, and offers
Use theirs / Keep mine for overlap. Network errors retry only while an edited
session is mounted, with a 1–15 s backoff. Idle saved sessions have no timers.
Drafts remain after failures. Deleted notes are read-only until restored.

Display choices use `kybern.notes.display`; quick drafts use
`kybern.notes.quick`; note drafts use `kybern.notes.draft:env:note:<id>` in the
per-environment store. Desktop's `lastOpenId` is memory-only on this base;
GPUIX additionally persists it as `kybern.notes.lastOpenId`.

## Initial GPUIX 0.10.0 investigation (historical)

The initial investigation below predates the input API/decorations patches and
the formatted editing work above. It was verified against installed `@gpuix/native/dist/host.d.ts`, `index.d.ts`, and
`@gpuix/react/dist/types/host.d.ts` (plus current Context7 docs):

- Inputs expose `value`, `onChange`, `readOnly`, theme and focus/blur/key events.
  Textareas add `minRows`/`maxRows`; edits apply in native code immediately.
- Markdown exposes `source`, theme and `onLinkClick`; it is not editable.
- Renderer selection APIs return joined selected text and clear the selection.
  There is no input caret range, selection setter, replacement transaction,
  editable rich-text tree, or cancellable before-input event.
- Export uses the native save panel (`platform/files.ts` `saveTextFile`, the
  desktop's `save_text_file`); the panel asks before replacing a file.
- `slashItems`, `outlineHeadings`, `noteLinks` and `taskRef` contain editor,
  browser or Tauri runtime dependencies, so they are not safe pure imports.

For faithful WYSIWYG, the patched module would need:

1. `getInputSelection(id)` and `setInputSelection(id, {anchor, head})` using
   documented UTF-16 offsets; `onSelectionChange` with input id, offsets,
   caret/selection rectangles, and composition state.
2. Atomic `replaceInputRange(id, {from, to, text, selection, undoGroup})`, with
   native undo/redo and IME preservation, plus cancellable `beforeInput`/key
   handling. This enables precise formatting, slash acceptance, links and
   cross-block caret navigation without rewriting the whole field value.
3. An editable attributed/block document host with source ranges, styled text
   runs, inline task/image atoms, transaction events, selection and native IME.
   Read-only Markdown source rendering alone cannot supply ProseMirror parity.

The current remaining differences are listed above. This historical investigation
does not describe the current input-selection API, formatted editor, image upload
or shared-note routing. Task-reference status and save-picker placement still
need their own current parity checks.

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
