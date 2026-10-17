# Shared editor

One formatted editor for the Notes page, the dock's Notes tab and thread notes
(`NoteEditor`, with `compact` for panels), quick capture, and task descriptions
(`tasks/Content.tsx`). It edits in place with the reading look of the desktop's
`NoteBody` (`views/notes/NoteBody.tsx`, `.note-prose` in `styles/notes.css`): no
Markdown source view, no edit mode.

| File | What |
| --- | --- |
| `RichEditor.tsx` | The component: feeds the native element, reads Markdown back, slash menu, caret follow |
| `FormatBar.tsx` | Selection bar (compact surfaces), link field, link bubble, `FormatButton` |
| `markdown.ts` | Markdown ⇄ blocks, lossless write back (`markdown.test.ts`) |
| `slash.ts`, `icons.ts` | Slash and Turn into items, search ranking and icons (desktop `slashItems.ts`) |
| `images.ts` | Image loading (`kybern://asset/…` from the note's daemon) and upload |
| `lab.tsx`, `check.ts`, `perf.ts`, `samples.ts` | Lab window, four-mode behaviour check, typing latency |
| `../../native/patches/rich_doc.rs` | Document model: blocks, runs, ProseMirror-style rules, history |
| `../../native/patches/rich_editor.rs` | The `<rich-editor>` element: layout, paint, keys, mouse, IME, clipboard |
| `../../native/patches/text_scale_gpui.py` | GPUI patch: per-run font size in one shaped line |

## Using it

```tsx
const editor = useRef<RichEditorHandle>(null)
<RichEditor
  ref={editor}
  value={markdown}            // shown when `epoch` changes
  epoch={snapshot.epoch}      // bump to replace the text (remote edit, reload); typing never needs it
  onChange={md => session.edit({ body: md })}   // throttled 120 ms, flushed on blur and unmount
  variant="page"              // or "compact" (14px, 1.55, selection format bar)
  size={15} lineHeight={24} color={ink(t, 0.86)}  // optional overrides (task description)
  images={{ endpoint: () => rpc(noteId).endpoint }}  // null keeps the editor text-only (no Image item)
  scroller={scrollRef}        // scrolling ancestor that keeps the caret in view
  onOpenLink={openLink}       // ⌘-click on a link, click on a task chip
  onBackspaceAtStart={() => focusTitle()}
  onState={setState}          // formatting state for a toolbar (see EditorState)
  interceptKeys={['escape']} onKeyDown={e => { if (e.key === 'escape') { e.preventDefault(); done() } }}
/>
```

`RichEditorHandle`: `read()` (current Markdown), `focus('start' | 'end')`,
`command(…)`, `state()`, `addImages(paths)`.

`EditorState` (from the native element on every change): `focused`, `collapsed`,
`block` (turn-into id), `inCode`, `quote`, `marks`, `link` (href and rect),
`caret`, `selection`, `slash` (query and rect), `canUndo`/`canRedo`, `empty`,
`headings` (level, text, y, block index) and `height`. Rects are
`[x, y, width, height]` relative to the editor, so scrolling does not emit state.

## Commands

`handle.command({ cmd, … })` calls `renderer.richEditorCommand(id, command)`:

| `cmd` | Arguments | Does |
| --- | --- | --- |
| `getDoc`, `getState`, `getSelection` | | Block JSON, `EditorState`, `{anchor, head, composing}` (UTF-16 offsets) |
| `select` | `anchor`, `head` | `{ block, offset }` positions |
| `focus` | `at?: 'start' \| 'end'` | Focus (and move the caret) |
| `mark` | `mark: bold \| italic \| strike \| code` | Toggle on the selection, or store for typing |
| `turnInto` | `block` | The format bar's Turn into (clears to paragraphs first, like `clearNodes`) |
| `toggle` | `block` | The toolbar's list, code and quote buttons (TipTap toggles) |
| `slash` | `item` | Delete `/query`, run the item; one undo step |
| `link` | `href \| null`, `text?` | Set or remove a link on the selection or the link at the caret; inserts `text` when nothing is selected |
| `selectLink` | | Select the link around the caret |
| `insertImage` | `src`, `alt` | Image block after the caret |
| `insertTaskRef` | `id`, `label` | Task reference atom |
| `insertText` | `text`, `rules?` | Typing from code (input rules optional) |
| `undo`, `redo`, `toggleTask` | `block` for `toggleTask` | |
| `layout`, `stats`, `ime` | | Checks only: block geometry, reshape counter, the input-method path |

`renderer.setRichEditorImage(src, bytes)` hands every editor showing `src` its
decoded image (empty bytes: "Image unavailable"); `images.ts` calls it.

## Element props and events

`<rich-editor>` props: `doc` (`{ blocks }` JSON string) and `docEpoch`, `theme`
(`editorTheme()`: the `.note-prose` tokens and sizes), `placeholder`, `readOnly`,
`interceptKeys`, `tasks` (id → key, status, label, state), `taskKeys` (key → id,
so typed and pasted keys link), `glyphs` (status SVGs, `pending`, the checklist
`tick`). Events: `change` (`value` is JSON: `{t:'edit'}`, `{t:'state', …}`,
`{t:'backspaceAtStart'}`), `keyDown` (intercepted keys), `focus`, `blur`,
`linkClick` (`value` = href), `fileDrop` (dropped or pasted image files).

## Blocks

A flat list; nesting is attributes. `type`: `paragraph`, `heading` (`level`),
`bullet`, `ordered` (`start`), `task` (`checked`), `code` (`lang`, `text`),
`rule`, `image` (`src`, `alt`, `title`), `raw` (`text`: tables, HTML, definitions,
kept and edited as source). `depth` is the list level, `quote` the quote level,
`cont` marks a list item's later paragraph. Inline `content` is pieces:
`{ text, marks?, link? }` or `{ atom: taskRef | image | raw }`.

`markdown.ts` maps the desktop parser's mdast to blocks and remembers each block's
source span. Writing back copies an unchanged block, and the text between
unchanged neighbours, byte for byte; a changed block is written like
TipTap/@tiptap/markdown writes it (`- ` bullets, `- [ ] `, two-space hard breaks,
`&nbsp;` for a second empty paragraph), keeping its original line prefix when its
kind did not change. Untouched documents round-trip exactly (CRLF included).

## Behaviour (desktop TipTap 3 / ProseMirror)

- Enter splits (lists continue, an empty item leaves the list, Enter at the end of a
  heading starts body text, three Enters leave a code block); Shift-Enter and
  ⌘-Enter insert a hard break; Backspace at a block start lifts, unquotes or joins;
  Tab/Shift-Tab nest and lift list items.
- Input rules: `#`–`###`, `-`/`+`/`*`, `1.`, `[ ]`/`[x]`, `>`, ` ``` `, `---`,
  `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``; Backspace right after a rule
  puts back what was typed. Autolinks and pasted URLs link; typed and pasted task
  keys become references.
- History: typing within 500 ms at the caret is one step; formatting, paste, Enter
  and commands are their own steps; an IME composition is one step. 200 steps.
- Selection across blocks; word (⌥←/→), line (⌘←/→) and document (⌘↑/↓)
  movement; double-click selects a word, triple-click the block; a click selects an
  image or rule.
- Copy writes plain text (blocks joined by a blank line, as ProseMirror does) plus
  the block slice as metadata, so a paste into an editor keeps formatting;
  ⌘⇧V pastes plain text. Pasted and dropped image files are uploaded and inserted.
- IME: marked text is painted underlined in place; while marked, keys go to the
  input method (Enter commits); the commit is one undo step.

## Verification

```sh
bun test src/editor                  # Markdown round trip and edit locality
bun src/editor/check.ts              # four modes, real key/mouse input against the lab
bun src/editor/perf.ts               # typing latency in a 2,000-word note, idle frames
bun scripts/visual-pair.ts editor9-note editor9-note-slash … --theme both
```

The input-method check drives `EntityInputHandler` (the path NSTextInputClient
uses) through the `ime` command; switching a real input source would change the
user's global keyboard settings, so a manual Japanese/Chinese pass is still owed.
