import { useTranscriptRowLease } from './Window.tsx'
// Native GFM keeps prose, tables and syntax highlighting in single bounded
// nodes. Code expansion contributes rows to the OUTER transcript virtual list.
import { memo, useMemo, useState, type ReactNode } from 'react'
import { spawn } from 'node:child_process'
import { chatLink } from '../../../../packages/kybern-client/src/chatLinks.ts'
import { TOOL_RESULT_CHAR_LIMIT, TOOL_RESULT_LINE_LIMIT } from '../../../desktop/src/lib/toolResultText.ts'
import { getClient, usePaneAccess } from '../state.ts'
import { Label, useTheme } from '../ui.tsx'
import { FONT_MONO } from '../theme.ts'
import { Dialog, DialogHeader } from '../nav/overlay.tsx'
import { Button, cachedCodeTheme, cachedMarkdownTheme, CODE, muted, TEXT } from './kit.tsx'
import { CopyAction } from './bubble.tsx'
import { Icon } from '../icons.tsx'
import { T } from './glyphs.ts'
import { reportError } from './store.ts'
import { chipifyKybernRefs } from './refs.ts'
import { useNotes, openNote } from '../notes/store.ts'
import { useTasks, openTask } from '../tasks/store.ts'
import { goPage } from '../nav/history.ts'
import type { NoteSummary, TaskItem } from '../../../../packages/kybern-client/src/types.ts'
import type { MarkdownStream } from '../native/markdown.ts'

export type MarkdownPart = { kind: 'prose' | 'code'; text: string; language?: string; key: string }
const cache = new Map<string, MarkdownPart[]>()
/** Top-level fences only: nested list/quote fences remain native Markdown. */
export function markdownParts(source: string): MarkdownPart[] {
  const hit = cache.get(source)
  if (hit) return hit
  const parts: MarkdownPart[] = []
  const lines = source.split('\n')
  let prose: string[] = [], code: string[] = [], fence = '', language = ''
  const push = (kind: MarkdownPart['kind'], text: string, lang?: string) => {
    if (text) parts.push({ kind, text, language: lang, key: String(parts.length) })
  }
  const flush = () => { push('prose', prose.join('\n')); prose = [] }
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
  if (!part || part.kind === 'code') return BLOCK_MARGIN
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

/** Bound lines and characters, including a pathological single long line. */
export function textChunks(text: string): string[] {
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

/** `.chat-markdown-codeblock__header` / `__action` (kit.css): 1.6px 6.4px 1.6px 9.6px
 *  around 24px square, 8px-radius buttons; no border or rule under the header. */
function HeaderButton({ testId, label, active, onClick, children }: { testId: string; label: string; active?: boolean; onClick: () => void; children: ReactNode }) {
  const t = useTheme()
  return <div testId={testId} role="button" aria-label={label} onClick={onClick} style={{ display: 'flex', width: 24, height: 24, alignItems: 'center', justifyContent: 'center', borderRadius: 8, cursor: 'pointer', flexShrink: 0, backgroundColor: 'rgba(0, 0, 0, 0)', hover: { backgroundColor: t.v('--color-background-button-secondary-hover') } }}>{children}</div>
}

export const CodeHeader = memo(function CodeHeader({ part, expanded, wrap, onExpand, onWrap }: {
  part: MarkdownPart; expanded: boolean; wrap: boolean; onExpand?: () => void; onWrap: () => void
}) {
  const t = useTheme()
  return <div testId="code-header" style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 1.6, paddingBottom: 1.6, paddingLeft: 9.6, paddingRight: 6.4, borderTopLeftRadius: CODE.radius, borderTopRightRadius: CODE.radius, overflow: 'hidden', backgroundColor: t.codeSurface }}>
    <Label color={muted(t)} size={11.52} lineHeight={16.128} font={FONT_MONO} style={{ flexGrow: 1 }}>{part.language === 'mermaid' ? 'Mermaid source' : part.language || 'text'}</Label>
    {onExpand && <Button testId="code-expand" variant="ghost" onClick={onExpand}>{expanded ? 'Show less' : 'Show more'}</Button>}
    <HeaderButton testId="code-wrap" label={wrap ? 'Disable line wrap' : 'Wrap lines'} onClick={onWrap}>
      <Icon source={T.textWrap} size={12} color={wrap ? t.text : muted(t)} />
    </HeaderButton>
    <CopyAction text={part.text} testId="code-copy" />
  </div>
})

/** `pre` is padded .5rem .6rem; the body continues the header's surface. */
export const CodeChunk = memo(function CodeChunk({ text, language, wrap, first = true, last = true }: { text: string; language?: string; wrap: boolean; first?: boolean; last?: boolean }) {
  const t = useTheme()
  return <div testId="code-body" style={{ display: 'flex', flexDirection: 'column', paddingLeft: 9.6, paddingRight: 9.6, paddingTop: first ? 8 : 0, paddingBottom: last ? 8 : 0, backgroundColor: t.codeSurface, minWidth: 0, borderBottomLeftRadius: last ? CODE.radius : 0, borderBottomRightRadius: last ? CODE.radius : 0, overflow: 'hidden' }}>
    <code softWrap={wrap} code={text.replace(/\n$/, '')} language={language} theme={cachedCodeTheme(t, language)} style={{ minWidth: 0, userSelect: 'text' }} />
  </div>
})

const NO_NOTES: NoteSummary[] = []
const NO_TASKS: Record<string, TaskItem> = {}

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
  const source = useMemo(() => (refs ? chipifyKybernRefs(text, id => notes.find(n => n.id === id), id => tasks[id]) : text), [text, refs, notes, tasks])
  const [preview, setPreview] = useState<{ title: string; text: string; code: boolean } | null>(null)
  useTranscriptRowLease(preview !== null)
  const open = async (href: string) => {
    const link = chatLink(href)
    const client = getClient()
    if (!client) return
    try {
      if (link.kind === 'external') { spawn('open', [link.url]).on('error', e => reportError('Unable to open link', e)); return }
      if (link.kind === 'file') {
        const threadId = pane.get().selectedId
        if (!threadId) return
        const file = await client.call('threads.files.read', { thread_id: threadId, path: link.path })
        setPreview({ title: link.path, text: file.content, code: true })
      } else if (link.kind === 'kybern') {
        // A chip opens the note or task page, as on the desktop.
        if (link.target === 'note') openNote(link.id)
        else { goPage('tasks'); openTask(link.id) }
      }
    } catch (e) { reportError('Unable to open link', e) }
  }
  return <>
    <markdown source={source} theme={cachedMarkdownTheme(t)} onLinkClick={e => { if (e.value) void open(e.value) }} style={{ color: t.text, userSelect: 'text' }} />
    {preview && <Dialog width={720} onClose={() => setPreview(null)} testId="chat-link-preview">
      <DialogHeader title={preview.title} onClose={() => setPreview(null)} />
      <virtual-list style={{ height: 480 }} estimatedItemHeight={300} overdraw={240}>
        {textChunks(preview.text).map((chunk, i) => <div key={i} style={{ padding: 16 }}>{preview.code ? <CodeChunk text={chunk} wrap={true} /> : <markdown source={chunk} theme={cachedMarkdownTheme(t)} style={{ color: t.text, userSelect: 'text' }} />}</div>)}
      </virtual-list>
    </Dialog>}
  </>
})

/** Work rows cannot become nested vertical scrollers. Their expanded output
 * opens a separate virtual surface; short output keeps the same native node. */
export function TextDetail({ text, title, code = false, onClose }: { text: string; title: string; code?: boolean; onClose: () => void }) {
  useTranscriptRowLease(true)
  const t = useTheme()
  const chunks = useMemo(() => textChunks(text), [text])
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

export const BoundedMarkdown = memo(function BoundedMarkdown({ text, tone = 'bright', stream }: { text: string; tone?: 'bright' | 'muted'; stream?: MarkdownStream }) {
  const t = useTheme()
  const chunks = useMemo(() => textChunks(text), [text])
  const [expanded, setExpanded] = useState(false)
  return <div style={{ display: 'flex', flexDirection: 'column' }}>
    <markdown source={chunks[0]} theme={withStream(cachedMarkdownTheme(t, tone), stream)} style={{ color: tone === 'bright' ? t.text : muted(t), userSelect: 'text' }} />
    {chunks.length > 1 && <Button variant="ghost" onClick={() => setExpanded(true)}>Show more</Button>}
    {expanded && <TextDetail text={text} title="Agent response" onClose={() => setExpanded(false)} />}
  </div>
})
