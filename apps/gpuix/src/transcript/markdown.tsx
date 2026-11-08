import { N } from '../nav/glyphs.ts'
import { DOCK_ICONS } from '../dock/icons.ts'
import { useLinkIcons } from './linkIcons.ts'
import { actOnThreadFile, showThreadFile } from './threadFiles.ts'
import { osLabels } from '../platform/os.ts'
import { ContextMenu, MenuItem } from '../nav/overlay.tsx'
import { knownPullTarget } from '../pulls/OpenPullRequest.tsx'
import { knownRunTarget, openRunTarget } from '../pulls/openRun.ts'
import { knownIssueTarget, openIssueTarget } from '../pulls/openIssue.ts'
import { openTabFromPane } from '../tabs/open.ts'
import { resolveWorkspaceFile } from './fileLinks.ts'
import { allowOutsideFile, useRefusedFileLinks } from './outsideFile.ts'
import { useTranscriptRowLease } from './Window.tsx'
// Native GFM keeps prose, tables and syntax highlighting in single bounded
// nodes. Code expansion contributes rows to the OUTER transcript virtual list.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useGpuix, type MarkdownProps, type PublicInstance } from '@gpuix/react'
import { chatLink } from '../../../../packages/kybern-client/src/chatLinks.ts'
import { fileRefCandidates, linkifyFileRefs } from '../../../../packages/kybern-client/src/fileRefs.ts'
import { absoluteFileLinks, unlinkFileLinks } from '../../../../packages/kybern-client/src/outsideLinks.ts'
import { TOOL_RESULT_CHAR_LIMIT, TOOL_RESULT_LINE_LIMIT } from '../shared/lib/toolResultText.ts'
import { threadClient, usePaneAccess } from '../state.ts'
import { Label, useTheme } from '../ui.tsx'
import { FONT_MONO } from '../theme.ts'
import { Dialog, DialogHeader } from '../nav/overlay.tsx'
import { cachedCodeTheme, cachedMarkdownTheme, CODE, muted, TEXT } from './kit.tsx'
import { CopyAction } from './bubble.tsx'
import { Button } from '../kit/Button.tsx'
import { IconButton } from '../kit/IconButton.tsx'
import { T } from './glyphs.ts'
import { reportError, useRowState } from './store.ts'
import { chipifyKybernRefs } from './refs.ts'
import { useFileRefs } from './fileRefs.ts'
import { useNotes, openNote } from '../notes/store.ts'
import { useTasks, openTask } from '../tasks/store.ts'
import { goPage, openThread } from '../nav/history.ts'
import type { NoteSummary, TaskItem } from '../../../../packages/kybern-client/src/types.ts'
import type { MarkdownStream } from '../native/markdown.ts'
import { StreamMarkdown } from './StreamMarkdown.tsx'
import { DiffChunk } from './DiffChunk.tsx'
import { hasDiffFence, isDiffLanguage, splitDiffFences } from './diffFence.ts'
import { DocumentMarkdown } from '../native/markdownDocument.tsx'
import { ThreadImage, ThreadImagePreview } from './ThreadImage.tsx'
import { localImageLink } from '../../../../packages/kybern-client/src/responseImages.ts'
import { observeElementBounds, type ElementBoundsEvent } from '../native/layout.ts'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { openTarget } from '../platform/os.ts'

/** `image`: a Markdown image on a line of its own (`text` is its source as written, `alt` its caption). */
export type MarkdownPart = { kind: 'prose' | 'code' | 'image'; text: string; language?: string; alt?: string; key: string }

// Bare destinations may hold spaces: agents write `![x](/path/Booking form.png)` without the `<…>` CommonMark wants.
const IMAGE = /!\[([^\]\n]*)\]\((?:<([^>\n]+)>|([^()\s](?:[^()\n]*?(?:\([^()\n]*\))?)*?))(?:\s+"[^"\n]*")?\s*\)/g
const IMAGE_LINE = new RegExp(`^ {0,3}(?:${IMAGE.source}\\s*)+$`)
export type TextSegment = { kind: 'text'; text: string } | { kind: 'image'; source: string; alt: string }
/** Split images that stand on their own lines out of Markdown text (outside fences), so they render as images: native
 *  Markdown paints them as links. Inline images inside a sentence stay where they are. */
export function splitImages(text: string): TextSegment[] {
  if (!text.includes('![')) return [{ kind: 'text', text }]
  const out: TextSegment[] = []
  let lines: string[] = [], fence = ''
  const flush = () => { const joined = lines.join('\n'); if (joined.trim()) out.push({ kind: 'text', text: joined }); lines = [] }
  for (const line of text.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) { if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length) fence = ''; lines.push(line); continue }
    if (marker) { fence = marker[1]!; lines.push(line); continue }
    if (!IMAGE_LINE.test(line)) { lines.push(line); continue }
    flush()
    for (const m of line.matchAll(IMAGE)) out.push({ kind: 'image', alt: m[1]!.trim(), source: (m[2] ?? m[3])! })
  }
  flush()
  return out.length ? out : [{ kind: 'text', text }]
}
const cache = new Map<string, MarkdownPart[]>()
/** Top-level fences only: nested list/quote fences remain native Markdown. */
export function markdownParts(source: string): MarkdownPart[] {
  const hit = cache.get(source)
  if (hit) return hit
  const parts: MarkdownPart[] = []
  const lines = source.split('\n')
  let prose: string[] = [], code: string[] = [], fence = '', language = ''
  const push = (kind: MarkdownPart['kind'], text: string, lang?: string, alt?: string) => {
    if (text) parts.push({ kind, text, language: lang, ...(alt !== undefined ? { alt } : {}), key: String(parts.length) })
  }
  const flush = () => {
    for (const segment of splitImages(prose.join('\n'))) segment.kind === 'image' ? push('image', segment.source, undefined, segment.alt) : push('prose', segment.text)
    prose = []
  }
  for (const line of lines) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) {
        push('code', code.join('\n'), language); code = []; fence = ''
      } else code.push(line)
    } else if (marker && !(marker[1]![0] === '`' && marker[2]!.includes('`'))) {
      flush(); fence = marker[1]!; language = marker[2]!.trim().split(/\s+/)[0] ?? ''
    } else prose.push(line)
  }
  if (fence) push('code', code.join('\n'), language)
  flush()
  // Cache only small answers; retained source strings must remain bounded.
  if (source.length <= 32_768) {
    if (cache.size >= 64) cache.delete(cache.keys().next().value!)
    cache.set(source, parts)
  }
  return parts
}

const BLOCK_MARGIN = 10.4 // kit.css `.chat-markdown p, ul, ol, blockquote, pre, table { margin: 0.65rem 0 }`
const RULE_MARGIN = 24 // `.chat-markdown hr { margin: 1.5rem 0 }`
const HEADING_SCALE = [1.75, 1.55, 1.35, 1.2, 1.1, 1] // `.chat-markdown h1..h6` font sizes, in em
/**
 * The margin a part's outer block contributes at one of its edges. Parts are
 * separate virtual rows, but the desktop lays them out as siblings of one block
 * flow where adjoining margins collapse to the larger: a rule is 1.5rem, a
 * heading `1.1em` above and `.35em` below, everything else .65rem.
 */
export function edgeMargin(part: MarkdownPart | undefined, edge: 'start' | 'end'): number {
  if (!part || part.kind !== 'prose') return BLOCK_MARGIN
  const lines = part.text.split('\n')
  const line = (edge === 'start' ? lines.find(l => l.trim()) : [...lines].reverse().find(l => l.trim())) ?? ''
  if (/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line)) return RULE_MARGIN
  const heading = /^ {0,3}(#{1,6})(?:[ \t]|$)/.exec(line)
  if (heading) {
    const size = HEADING_SCALE[heading[1]!.length - 1]! * TEXT.size
    return Math.max(BLOCK_MARGIN, edge === 'start' ? 1.1 * size : 0.35 * size)
  }
  return BLOCK_MARGIN
}
/** The collapsed gap between two neighbouring parts. */
export const partGap = (before: MarkdownPart, after: MarkdownPart) => Math.max(edgeMargin(before, 'end'), edgeMargin(after, 'start'))

/** Bound lines and characters, including a pathological single long line. It splits anywhere, so it is for code and
 *  plain text; Markdown prose goes through `textChunks`. */
const MARKDOWN_FILE = /\.(md|mdx|markdown)$/i

export function lineChunks(text: string): string[] {
  const chunks: string[] = []
  let start = 0, lines = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') lines++
    if (lines >= TOOL_RESULT_LINE_LIMIT || i - start + 1 >= TOOL_RESULT_CHAR_LIMIT) {
      // Do not split a surrogate pair at the character boundary.
      if (text.charCodeAt(i) >= 0xd800 && text.charCodeAt(i) <= 0xdbff) i++
      chunks.push(text.slice(start, i + 1)); start = i + 1; lines = 0
    }
  }
  if (start < text.length || !chunks.length) chunks.push(text.slice(start))
  return chunks
}

/** Past this a piece splits inside a block (only pathological answers: a 256-line table, one giant list). */
const HARD_LINES = TOOL_RESULT_LINE_LIMIT * 8
const HARD_CHARS = TOOL_RESULT_CHAR_LIMIT * 8
const TABLE_DELIMITER = /^ {0,3}\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/

/** A fence marker at any indentation (list items nest fences deeper than CommonMark's three spaces): indent, marker, rest. */
const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/

/**
 * Markdown prose in bounded pieces that are each a whole run of blocks. A piece ends only before a line that starts a
 * new top-level block after a blank line (column 0: not an indented continuation or code), so a table, list, quote or
 * paragraph is never cut in two; cutting between a table's header and delimiter rows turned the rest of the table into
 * a paragraph of pipes. Inside a fenced code block nothing is a block start (a `def` after a blank line is code), at
 * any indentation and with either marker. A piece aims for 32 lines or 8 KB, takes the last boundary in reach, else
 * grows to the next one, and only past 8x that splits inside a block, repeating a table's header and delimiter so the
 * rest stays a table, or closing a fence and opening it again in the next piece so both halves stay code.
 * Every piece but the last ends with its newline; joined (minus repeated headers and fences) they are the source.
 * Prefix-stable: appending text never moves an earlier cut, so streamed pieces keep their identity.
 */
export function textChunks(text: string): string[] {
  if (text.length < TOOL_RESULT_CHAR_LIMIT && lineCount(text) <= TOOL_RESULT_LINE_LIMIT) return [text]
  const lines = text.split('\n')
  const out: string[] = []
  let first = 0, carried = '', chars = 0, cut = -1
  let table: { header: string; at: number } | null = null
  let fence: { marker: string; opener: string; indent: string } | null = null
  const close = (end: number, carry = '', closing = '') => {
    out.push(carried + lines.slice(first, end).join('\n') + '\n' + closing)
    carried = carry
    first = end
    cut = -1
    chars = carry.length
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!fence) {
      if (table && (!line.trim() || !line.includes('|'))) table = null
      if (!table && i > 0 && line.includes('-') && lines[i - 1]!.includes('|') && TABLE_DELIMITER.test(line)) table = { header: `${lines[i - 1]}\n${line}\n`, at: i }
      if (i > first && !lines[i - 1]!.trim() && /^\S/.test(line)) cut = i
    }
    const size = i - first
    if ((size >= TOOL_RESULT_LINE_LIMIT || chars >= TOOL_RESULT_CHAR_LIMIT) && cut > first) {
      close(cut)
      for (let j = first; j < i; j++) chars += lines[j]!.length + 1
    } else if (size >= HARD_LINES || chars >= HARD_CHARS) {
      if (fence) close(i, `${fence.opener}\n`, `${fence.indent}${fence.marker}\n`)
      else close(i, table && i > table.at ? table.header : '')
    }
    const marker = FENCE.exec(line)
    if (fence) {
      if (marker && marker[2]![0] === fence.marker[0] && marker[2]!.length >= fence.marker.length && !marker[3]!.trim()) fence = null
    } else if (marker && !(marker[2]![0] === '`' && marker[3]!.includes('`'))) {
      fence = { marker: marker[2]!, opener: line, indent: marker[1]! }
      table = null
    }
    chars += line.length + 1
  }
  out.push(carried + lines.slice(first).join('\n'))
  // A single line longer than any bound (a pasted blob) still splits, by characters.
  return out.some(piece => piece.length > HARD_CHARS * 2) ? out.flatMap(piece => (piece.length > HARD_CHARS * 2 ? lineChunks(piece) : [piece])) : out
}

function lineCount(text: string) {
  let n = 1
  for (let i = text.indexOf('\n'); i >= 0 && n <= TOOL_RESULT_LINE_LIMIT; i = text.indexOf('\n', i + 1)) n++
  return n
}

/** `.chat-markdown-codeblock__header`: 1.6px 6.4px 1.6px 9.6px around 24px kit buttons; no border or rule under the header. */
export const CodeHeader = memo(function CodeHeader({ part, expanded, wrap, onExpand, onWrap }: {
  part: MarkdownPart; expanded: boolean; wrap: boolean; onExpand?: () => void; onWrap: () => void
}) {
  const t = useTheme()
  return <div testId="code-header" style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 1.6, paddingBottom: 1.6, paddingLeft: 9.6, paddingRight: 6.4, borderTopLeftRadius: CODE.radius, borderTopRightRadius: CODE.radius, overflow: 'hidden', backgroundColor: t.codeSurface }}>
    <Label color={muted(t)} size={11.52} lineHeight={16.128} font={FONT_MONO} style={{ flexGrow: 1 }}>{part.language === 'mermaid' ? 'Mermaid source' : part.language || 'text'}</Label>
    {onExpand && <Button testId="code-expand" variant="ghost" size="sm" onClick={onExpand}>{expanded ? 'Show less' : 'Show more'}</Button>}
    <IconButton testId="code-wrap" label={wrap ? 'Disable line wrap' : 'Wrap lines'} icon={T.textWrap} glyph={13} size="sm" active={wrap} onClick={onWrap} />
    <CopyAction text={part.text} testId="code-copy" />
  </div>
})

/** `pre` is padded .5rem .6rem; the body continues the header's surface. */
export const CodeChunk = memo(function CodeChunk({ text, language, wrap, first = true, last = true }: { text: string; language?: string; wrap: boolean; first?: boolean; last?: boolean }) {
  const t = useTheme()
  // `diff` and `patch` fences get the diff view's line styling (#294).
  if (isDiffLanguage(language)) return <DiffChunk text={text} wrap={wrap} first={first} last={last} />
  return <div testId="code-body" style={{ display: 'flex', flexDirection: 'column', paddingLeft: 9.6, paddingRight: 9.6, paddingTop: first ? 8 : 0, paddingBottom: last ? 8 : 0, backgroundColor: t.codeSurface, minWidth: 0, borderBottomLeftRadius: last ? CODE.radius : 0, borderBottomRightRadius: last ? CODE.radius : 0, overflow: 'hidden' }}>
    <code softWrap={wrap} code={text.replace(/\n$/, '')} language={language} theme={cachedCodeTheme(t, language)} style={{ minWidth: 0, userSelect: 'text' }} />
  </div>
})

const NO_NOTES: NoteSummary[] = []
const NO_TASKS: Record<string, TaskItem> = {}

/** Lines shown above a linked line, so the preview starts with some context. */
const LINE_CONTEXT = 3
/** The file from a little above `line` (1-based), and the line it starts at. */
export function fromLine(text: string, line: number | undefined): { text: string; start: number } {
  if (!line || line <= LINE_CONTEXT + 1) return { text, start: 1 }
  let start = 1, index = 0
  while (start < line - LINE_CONTEXT) {
    const next = text.indexOf('\n', index)
    if (next < 0) return { text, start: 1 }
    index = next + 1; start++
  }
  return { text: text.slice(index), start }
}

/** `withStream`: the live answer's caret and fading words go in the cached theme's `markdown` block. */
export function withStream<T extends { markdown: object }>(theme: T, stream: MarkdownStream | undefined): T {
  return stream ? { ...theme, markdown: { ...theme.markdown, stream } } : theme
}

export const Prose = memo(function Prose({ text }: { text: string }) {
  const pane = usePaneAccess()
  const t = useTheme()
  const refs = text.includes('kybern://')
  const notes = useNotes(s => (refs ? s.notes : NO_NOTES))
  const tasks = useTasks(s => (refs ? s.tasks : NO_TASKS))
  // Inline code that names a workspace file reads as a link once the daemon confirms it.
  const threadId = pane.get().selectedId
  const candidates = useMemo(() => fileRefCandidates(text), [text])
  const fileOf = useFileRefs(threadId, candidates)
  // A link to a file this client cannot open (outside the workspace, on a machine that did not allow it) reads as plain text.
  const fileLinks = useMemo(() => absoluteFileLinks(text), [text])
  const refused = useRefusedFileLinks(threadId, () => threadClient(threadId, pane.get().selectedMachineId), fileLinks)
  const source = useMemo(() => {
    const chips = refs ? chipifyKybernRefs(text, id => notes.find(n => n.id === id), id => tasks[id]) : text
    const linked = chips.includes('`') ? linkifyFileRefs(chips, fileOf) : chips
    return unlinkFileLinks(linked, refused)
  }, [text, refs, notes, tasks, fileOf, refused])
  const [preview, setPreview] = useState<{ title: string; text: string; code: boolean; line?: number; whole?: boolean; markdown?: boolean; raw?: boolean } | null>(null)
  useTranscriptRowLease(preview !== null)
  const linkIcons = useLinkIcons(source, threadId, t)
  const theme = useMemo(() => { const base = cachedMarkdownTheme(t); return { ...base, markdown: { ...base.markdown, linkIcons: [...linkIcons, ...base.markdown.linkIcons] } } }, [t, linkIcons])
  const [fileMenu, setFileMenu] = useState<{ path: string; at: { x: number; y: number } } | null>(null)
  const [image, setImage] = useState<string | null>(null)
  const open = async (href: string) => {
    const link = chatLink(href)
    // An image link (or an inline image native Markdown paints as a link) opens the image, wherever its folder is.
    if (localImageLink(href) || (link.kind === 'file' && /\.(?:png|jpe?g|gif|webp|avif)$/i.test(link.path))) { setImage(href); return }
    try {
      if (link.kind === 'external') {
        const target = await knownPullTarget(link.url)
        if (target && openTabFromPane(pane.id, {kind:'pr', ...target})) return
        // A GitHub Actions run or job of a known repository opens in the Actions view; other links go to the browser.
        const run = await knownRunTarget(link.url)
        if (run) { openRunTarget(run); return }
        // An issue of a known repository opens in the Issues view too.
        const issue = await knownIssueTarget(link.url)
        if (issue) { openIssueTarget(issue); return }
        openTarget(link.url).catch(e => reportError('Unable to open link', e)); return
      }
      const client = threadClient(threadId, pane.get().selectedMachineId)
      if (!client) return
      // From inside a thread, files, notes and tasks open as permanent tabs beside the chat (ADE-54); the page is a click away.
      if (link.kind === 'file') {
        const threadId = pane.get().selectedId
        if (!threadId) return
        // The path as the workspace spells it (an agent writes from its shell's folder); one the daemon cannot place opens as written,
        // and the tab says why.
        let path = await resolveWorkspaceFile(client, threadId, link.path)
        if (!path) {
          // Outside the workspace: it opens read-only once the daemon (and, on this machine, the user) allows it.
          const outside = await allowOutsideFile(client, threadId, link.path)
          if (outside === 'cancelled') return
          path = outside ?? link.path
        }
        if (/\.(?:pdf|mp4|mov|mkv|webm|avi|zip|docx?|xlsx?|pptx?)$/i.test(path)) { void actOnThreadFile(threadId, path, 'open'); return }
        const header = await client.call('threads.files.read', { thread_id: threadId, path, max_bytes: 512 })
        if (header.binary) { void actOnThreadFile(threadId, path, 'open'); return }
        if (!openTabFromPane(pane.id, { kind: 'file', path, root: 'thread', ...(link.line ? { line: link.line } : {}) })) {
          const file = await client.call('threads.files.read', { thread_id: threadId, path })
          setPreview({ title: link.line ? `${path}:${link.line}` : path, text: file.content, code: true, line: link.line, markdown: MARKDOWN_FILE.test(path) })
        }
      } else if (link.kind === 'thread') {
        // A thread of another machine (`kybern://thread/<machine>/<thread>`), e.g. the fork this thread started.
        openThread(link.threadId, link.machineId)
      } else if (link.kind === 'kybern') {
        if (link.target === 'note') { if (!openTabFromPane(pane.id, { kind: 'note', id: link.id })) openNote(link.id) }
        else if (!openTabFromPane(pane.id, { kind: 'task', id: link.id })) { goPage('tasks'); openTask(link.id) }
      }
    } catch (e) { reportError('Unable to open link', e) }
  }
  // A Markdown file opens rendered, whole (`ChatFileLink.tsx`); "Show source" goes back to the numbered code view.
  const rendered = !!preview?.markdown && !preview.raw
  const shown = preview && fromLine(preview.text, preview.whole || rendered ? undefined : preview.line)
  return <>
    <markdown testId="reply-prose" source={source} theme={theme} onLinkClick={e => { if (e.value) void open(e.value) }} onLinkContextMenu={e => { if (!e.value) return; const target = chatLink(e.value); if (target.kind === 'file') setFileMenu({ path: target.path, at: { x: e.x ?? 0, y: e.y ?? 0 } }) }} style={{ color: t.text, userSelect: 'text' }} />
    {fileMenu && threadId && <ContextMenu testId="reply-file-menu" at={fileMenu.at} onClose={() => setFileMenu(null)}>
      <MenuItem id="reveal" label={osLabels().reveal} icon={N.folder} onSelect={() => void actOnThreadFile(threadId, fileMenu.path, 'reveal')} />
      <MenuItem id="open" label="Open" icon={N.external} onSelect={() => void actOnThreadFile(threadId, fileMenu.path, 'open')} />
      <MenuItem id="explorer" label="Show in Kybern Explorer" icon={DOCK_ICONS.explorer} onSelect={() => showThreadFile(threadId, fileMenu.path)} />
    </ContextMenu>}
    {image && threadId && <ThreadImagePreview threadId={threadId} source={image} onClose={() => setImage(null)} />}
    {preview && shown && <Dialog width={720} onClose={() => setPreview(null)} testId="chat-link-preview">
      <DialogHeader title={preview.title} onClose={() => setPreview(null)} />
      {(shown.start > 1 || preview.markdown) && <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 16, paddingRight: 16 }}>
        <Label color={muted(t)} style={{ flexGrow: 1 }}>{shown.start > 1 ? `From line ${shown.start}` : ''}</Label>
        {shown.start > 1 && <Button testId="chat-link-whole-file" variant="ghost" size="sm" onClick={() => setPreview({ ...preview, whole: true })}>Show whole file</Button>}
        {preview.markdown && <Button testId="chat-link-markdown-source" variant="ghost" size="sm" onClick={() => setPreview({ ...preview, raw: !preview.raw })}>{preview.raw ? 'Show preview' : 'Show source'}</Button>}
      </div>}
      <virtual-list style={{ height: 480 }} estimatedItemHeight={300} overdraw={240}>
        {(preview.code && !rendered ? lineChunks(shown.text) : textChunks(shown.text)).map((chunk, i) => <div key={i} style={{ padding: 16 }}>{preview.code && !rendered ? <CodeChunk text={chunk} wrap={true} /> : <markdown source={chunk} theme={cachedMarkdownTheme(t)} style={{ color: t.text, userSelect: 'text' }} />}</div>)}
      </virtual-list>
    </Dialog>}
  </>
})

/** Work rows cannot become nested vertical scrollers. Their expanded output
 * opens a separate virtual surface; short output keeps the same native node. */
export function TextDetail({ text, title, code = false, onClose }: { text: string; title: string; code?: boolean; onClose: () => void }) {
  useTranscriptRowLease(true)
  const t = useTheme()
  const chunks = useMemo(() => (code ? lineChunks(text) : textChunks(text)), [text, code])
  return <Dialog width={760} onClose={onClose} testId="text-detail">
    <DialogHeader title={title} onClose={onClose} />
    <div style={{ display: 'flex', justifyContent: 'flex-end', paddingRight: 16 }}><CopyAction text={text} /></div>
    <virtual-list style={{ height: 480 }} estimatedItemHeight={400} overdraw={240}>
      {chunks.map((chunk, i) => <div key={i} style={{ padding: 12 }}>
        {code ? <CodeChunk text={chunk} wrap={true} /> : <markdown source={chunk} theme={cachedMarkdownTheme(t)} style={{ color: t.text, userSelect: 'text' }} />}
      </div>)}
    </virtual-list>
  </Dialog>
}

/** `KYBERN_REPLY_CULL=0` keeps every piece of a long reply mounted (the A/B control for `BoundedMarkdown`'s culling). */
const REPLY_CULL = PATCHED_NATIVE && process.env.KYBERN_REPLY_CULL !== '0'
/** Pieces stay mounted this far above and below the visible part of a reply, so a scroll finds them painted. */
const OVERSCAN = Number(process.env.KYBERN_REPLY_OVERSCAN ?? 600)

type Piece = { kind: 'text'; text: string } | { kind: 'image'; source: string; alt: string }
type Measured = { piece: Piece; width: number; height: number }

/**
 * A `diff` or `patch` fence drawn as a diff (#294) inside Markdown that native `<markdown>` or a worker-parsed document
 * draws: the header with its Copy and wrap buttons, then `DiffChunk`s of at most one chunk of lines each. Wrap starts on
 * (diff lines are long and the pieces sit in a column of prose); the reader can switch it off. Wrap and Show more are row
 * state (`useRowState`) keyed by the fence's content, so a reply piece culled offscreen, or a transcript row scrolled out of
 * the virtual list, comes back as the reader left it. Copy reads the fence's raw body (`raw`, CRLF kept).
 */
const DiffFence = memo(function DiffFence({ text, raw = text, language }: { text: string; raw?: string; language: string }) {
  const key = useMemo(() => `diff-fence:${language}:${text.length}:${contentHash(text)}`, [text, language])
  const [wrap, setWrap] = useRowState(`${key}:wrap`, true)
  const [expanded, setExpanded] = useRowState(`${key}:expanded`, false)
  const part = useMemo<MarkdownPart>(() => ({ kind: 'code', text: raw, language, key: 'diff' }), [raw, language])
  const chunks = useMemo(() => lineChunks(text), [text])
  const shown = expanded ? chunks : chunks.slice(0, 1)
  return <div testId="diff-fence" style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
    <CodeHeader part={part} expanded={expanded} wrap={wrap} onWrap={() => setWrap(!wrap)} onExpand={chunks.length > 1 ? () => setExpanded(!expanded) : undefined} />
    {shown.map((chunk, i) => <CodeChunk key={i} text={chunk} language={language} wrap={wrap} first={i === 0} last={i === shown.length - 1} />)}
  </div>
})

/** 32-bit FNV-1a of `text`: an identity for a diff fence's row state that survives remounts. */
function contentHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193)
  return (hash >>> 0).toString(36)
}

/**
 * Drop-in for `<markdown>` (and, with `document`, a worker-parsed `DocumentMarkdown`) that also draws the `diff` / `patch`
 * fences it contains as diffs. Markdown without one is the same single element as before. With one, the document is cut at
 * the fence: prose pieces stay native Markdown (same props, so links, themes and selection are unchanged) and the fence is a
 * `DiffFence`, separated by the margin native blocks keep between each other. A streaming reply uses `StreamMarkdown`
 * instead and keeps native fences until it is whole.
 */
export const FencedMarkdown = memo(function FencedMarkdown({ document = false, ...props }: MarkdownProps & { document?: boolean }) {
  const source = props.source ?? ''
  const segments = useMemo(() => (hasDiffFence(source) ? splitDiffFences(source) : null), [source])
  const Prose = document ? DocumentMarkdown : 'markdown'
  if (!segments || !segments.some(segment => segment.kind === 'diff')) return <Prose {...props} />
  // The caller's box (a capped height that scrolls, margins, size) belongs to the whole document; the pieces keep the
  // text style (colour, selection), or each prose piece would be capped and scroll on its own.
  const [box, text] = splitBoxStyle(props.style)
  const { ref: _ref, ...rest } = props as MarkdownProps & { ref?: unknown }
  const firstProse = segments.findIndex(segment => segment.kind === 'markdown')
  return <div style={{ display: 'flex', flexDirection: 'column', gap: BLOCK_MARGIN, minWidth: 0, ...box }}>
    {segments.map((segment, i) => segment.kind === 'diff'
      ? <DiffFence key={i} text={segment.text} raw={segment.raw} language={segment.language} />
      : <div key={i} style={{ display: 'flex', flexDirection: 'column' }}><Prose {...(i === firstProse ? props : rest)} style={text} source={segment.text} /></div>)}
  </div>
})

const BOX_STYLE = new Set(['height', 'minHeight', 'maxHeight', 'width', 'minWidth', 'maxWidth', 'overflow', 'overflowX', 'overflowY', 'flexGrow', 'flexShrink', 'flexBasis', 'alignSelf', 'margin', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'padding', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight'])
/** `style` as the layout of the box around a split document and the text style its pieces keep. */
function splitBoxStyle(style: MarkdownProps['style']): [Record<string, unknown>, MarkdownProps['style']] {
  const box: Record<string, unknown> = {}
  const text: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(style ?? {})) (BOX_STYLE.has(key) ? box : text)[key] = value
  return [box, text as MarkdownProps['style']]
}

/** An agent's reply, always whole: `textChunks` pieces (whole blocks each) stacked with the margin the blocks would have
 *  between them in one document. Only the last piece streams, so a live reply re-parses its tail only. GPUIX lays out
 *  every mounted element each frame and native Markdown builds an element per block, so a long reply that grows (or
 *  just follows the tail) re-lays out all of it; pieces well outside the visible part are therefore spacers of their
 *  measured height, and a frame lays out what is on screen. Clamping is the caller's choice (`ClampedMarkdown` for
 *  agent-to-agent messages), never a cut here. */
export const BoundedMarkdown = memo(function BoundedMarkdown({ text, tone = 'bright', stream, at }: { text: string; tone?: 'bright' | 'muted'; stream?: MarkdownStream; at?: string }) {
  const t = useTheme()
  const threadId = usePaneAccess().get().selectedId
  // Text pieces and the images that stand on their own lines between them, in order.
  const pieces = useMemo(() => splitImages(text).flatMap((segment): Piece[] =>
    segment.kind === 'image' ? [segment] : textChunks(segment.text).map(chunk => ({ kind: 'text', text: chunk }))), [text])
  const gaps = useMemo(() => pieces.map((piece, i) => {
    const before = pieces[i - 1]
    return !before ? 0 : before.kind === 'text' && piece.kind === 'text' ? chunkGap(before.text, piece.text) : BLOCK_MARGIN
  }), [pieces])
  const theme = cachedMarkdownTheme(t, tone)
  // One style object per colour: a new object every streamed render would update every piece's node.
  const color = tone === 'bright' ? t.text : muted(t)
  const style = useMemo(() => ({ color, userSelect: 'text' as const }), [color])
  const renderer = useGpuix()?.renderer as { addLayoutObserver?: unknown; getWindowSize?: () => { height: number } } | undefined
  const cull = REPLY_CULL && pieces.length > 2 && typeof renderer?.addLayoutObserver === 'function'
  // Heights of mounted pieces (at the width they painted at), the reply's last bounds, and the pieces drawn as spacers.
  const heights = useRef(new Map<number, Measured>())
  const bounds = useRef<ElementBoundsEvent | null>(null)
  const [culled, setCulled] = useState<{ key: string; set: ReadonlySet<number> }>({ key: '', set: new Set() })
  const latest = useRef({ pieces, gaps })
  latest.current = { pieces, gaps }
  const recompute = useCallback(() => {
    const rect = bounds.current?.rect, clip = bounds.current?.clippedRect
    if (!rect) return
    const { pieces, gaps } = latest.current
    // The visible part in reply coordinates; offscreen, the window stands in for the transcript viewport.
    const view = clip && clip.height > 0 && clip.width > 0 ? { top: clip.y - rect.y, bottom: clip.y + clip.height - rect.y } : { top: -rect.y, bottom: (renderer?.getWindowSize?.().height ?? 0) - rect.y }
    const next: number[] = []
    let y = 0
    for (let i = 0; i < pieces.length - 1; i++) {
      y += gaps[i]!
      const known = heights.current.get(i)
      // From the first piece without a current height on, offsets are unknown: keep the rest mounted.
      if (!known || known.piece !== pieces[i] && !samePiece(known.piece, pieces[i]!) || Math.abs(known.width - rect.width) >= 0.5) break
      if (y + known.height < view.top - OVERSCAN || y > view.bottom + OVERSCAN) next.push(i)
      y += known.height
    }
    const key = next.join(',')
    setCulled(old => (old.key === key ? old : { key, set: new Set(next) }))
  }, [renderer])
  const column = useRef<PublicInstance | null>(null)
  useEffect(() => {
    if (!cull || !column.current) return
    return observeElementBounds(renderer!, column.current.id, event => { bounds.current = event; recompute() })
  }, [renderer, cull, recompute])
  const measure = useCallback((index: number, piece: Piece, width: number, height: number) => {
    const old = heights.current.get(index)
    if (old && old.piece === piece && old.width === width && old.height === height) return
    heights.current.set(index, { piece, width, height })
    recompute()
  }, [recompute])
  return <div ref={column} style={{ display: 'flex', flexDirection: 'column' }}>
    {pieces.map((piece, i) => {
      const last = i === pieces.length - 1, gap = gaps[i]!
      const spacer = cull && culled.set.has(i) ? heights.current.get(i) : undefined
      if (spacer) return <div key={i} style={{ height: spacer.height, flexShrink: 0, ...(gap ? { marginTop: gap } : {}) }} />
      const body = piece.kind === 'image'
        ? <ThreadImage threadId={threadId} source={piece.source} alt={piece.alt} at={at} />
        : (stream && last ? <StreamMarkdown source={piece.text} theme={withStream(theme, stream)} style={style} /> : <FencedMarkdown source={piece.text} theme={last ? withStream(theme, stream) : theme} style={style} />)
      const flex = piece.kind === 'image' ? { display: 'flex' as const } : { display: 'flex' as const, flexDirection: 'column' as const }
      if (!cull || last) return <div key={i} style={{ ...flex, ...(gap ? { marginTop: gap } : {}) }}>{body}</div>
      return <MeasuredPiece key={i} index={i} piece={piece} gap={gap} flex={flex} onMeasure={measure}>{body}</MeasuredPiece>
    })}
  </div>
})

const samePiece = (a: Piece, b: Piece) => a.kind === 'text' ? b.kind === 'text' && a.text === b.text : b.kind === 'image' && a.source === b.source && a.alt === b.alt

/** A mounted piece that reports its painted height whenever it changes (a first paint can still be short). */
function MeasuredPiece({ index, piece, gap, flex, onMeasure, children }: { index: number; piece: Piece; gap: number; flex: { display: 'flex'; flexDirection?: 'column' }; onMeasure: (index: number, piece: Piece, width: number, height: number) => void; children: ReactNode }) {
  const renderer = useGpuix()?.renderer
  const ref = useRef<PublicInstance | null>(null)
  const report = useRef({ index, piece, onMeasure })
  report.current = { index, piece, onMeasure }
  useEffect(() => {
    if (!renderer || !ref.current) return
    return observeElementBounds(renderer, ref.current.id, event => {
      const rect = event.rect
      if (rect && rect.height > 0) report.current.onMeasure(report.current.index, report.current.piece, rect.width, rect.height)
    })
  }, [renderer])
  return <div ref={ref} style={{ ...flex, ...(gap ? { marginTop: gap } : {}) }}>{children}</div>
}

/** The collapsed margin between two neighbouring prose pieces, as between parts (`partGap`). */
export const chunkGap = (before: string, after: string) => partGap({ kind: 'prose', text: before, key: '' }, { kind: 'prose', text: after, key: '' })
