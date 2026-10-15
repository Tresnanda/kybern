// Native GFM keeps prose, tables and syntax highlighting in single bounded
// nodes. Code expansion contributes rows to the OUTER transcript virtual list.
import { memo, useMemo, useState } from 'react'
import { spawn } from 'node:child_process'
import { chatLink, kybernRefsIn } from '../../../../packages/kybern-client/src/chatLinks.ts'
import { TOOL_RESULT_CHAR_LIMIT, TOOL_RESULT_LINE_LIMIT } from '../../../desktop/src/lib/toolResultText.ts'
import { getClient, getState } from '../state.ts'
import { Label, useTheme } from '../ui.tsx'
import { Dialog, DialogHeader } from '../nav/overlay.tsx'
import { Button, cachedMarkdownTheme, CODE, muted } from './kit.tsx'
import { CopyAction } from './bubble.tsx'
import { reportError } from './store.ts'

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

export const CodeHeader = memo(function CodeHeader({ part, expanded, wrap, onExpand, onWrap }: {
  part: MarkdownPart; expanded: boolean; wrap: boolean; onExpand?: () => void; onWrap: () => void
}) {
  const t = useTheme()
  return <div testId="code-header" style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 36, paddingLeft: 12, paddingRight: 8, borderTopLeftRadius: 10, borderTopRightRadius: 10, backgroundColor: t.codeSurface, borderWidth: 1, borderColor: t.border }}>
    <Label color={muted(t)} size={11.52} style={{ flexGrow: 1 }}>{part.language || 'text'}</Label>
    {onExpand && <Button testId="code-expand" variant="ghost" onClick={onExpand}>{expanded ? 'Show less' : 'Show more'}</Button>}
    <Button testId="code-wrap" variant={wrap ? 'subtle' : 'ghost'} onClick={onWrap}>Wrap</Button>
    <CopyAction text={part.text} testId="code-copy" />
  </div>
})

export const CodeChunk = memo(function CodeChunk({ text, language, wrap }: { text: string; language?: string; wrap: boolean }) {
  const t = useTheme()
  // Native <code> never wraps (host.d.ts). A single native text node supplies
  // wrapping by default so narrow panes never hide long lines. Turning Wrap
  // off restores native syntax highlighting until native code supports wrapping.
  return <div style={{ display: 'flex', flexDirection: 'column', padding: 12, paddingTop: 4, paddingBottom: 4, backgroundColor: t.codeSurface, minWidth: 0 }}>
    {wrap ? <text style={{ color: t.text, fontFamily: CODE.font, fontSize: CODE.size, lineHeight: CODE.lineHeight, userSelect: 'text', minWidth: 0 }}>{text.replace(/\n$/, '')}</text>
      : <code code={text.replace(/\n$/, '')} language={language} theme={cachedMarkdownTheme(t)} style={{ minWidth: 0, userSelect: 'text' }} />}
  </div>
})

export const Prose = memo(function Prose({ text }: { text: string }) {
  const t = useTheme()
  const refs = useMemo(() => kybernRefsIn(text), [text])
  const [preview, setPreview] = useState<{ title: string; text: string; code: boolean } | null>(null)
  const open = async (href: string) => {
    const link = chatLink(href)
    const client = getClient()
    if (!client) return
    try {
      if (link.kind === 'external') { spawn('open', [link.url]).on('error', e => reportError('Unable to open link', e)); return }
      if (link.kind === 'file') {
        const threadId = getState().selectedId
        if (!threadId) return
        const file = await client.call('threads.files.read', { thread_id: threadId, path: link.path })
        setPreview({ title: link.path, text: file.content, code: true })
      } else if (link.kind === 'kybern') {
        if (link.target === 'note') {
          const { note } = await client.call('notes.get', { id: link.id })
          if (note) setPreview({ title: note.title, text: note.body, code: false })
        } else {
          const { task } = await client.call('tasks.items.get', { id: link.id })
          if (task) setPreview({ title: task.title, text: task.body, code: false })
        }
      }
    } catch (e) { reportError('Unable to open link', e) }
  }
  return <>
    <markdown source={text} theme={cachedMarkdownTheme(t)} onLinkClick={e => { if (e.value) void open(e.value) }} style={{ color: t.text, userSelect: 'text' }} />
    {!!refs.length && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', paddingTop: 4 }}>
      {refs.map(ref => <Button key={ref.id} variant="subtle" onClick={() => void open(`kybern://${ref.target}/${ref.id}`)}>{ref.target === 'note' ? 'Open note' : 'Open task'}</Button>)}
    </div>}
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

export function BoundedMarkdown({ text, tone = 'bright' }: { text: string; tone?: 'bright' | 'muted' }) {
  const t = useTheme()
  const chunks = useMemo(() => textChunks(text), [text])
  const [expanded, setExpanded] = useState(false)
  return <div style={{ display: 'flex', flexDirection: 'column' }}>
    <markdown source={chunks[0]} theme={cachedMarkdownTheme(t, tone)} style={{ color: tone === 'bright' ? t.text : muted(t), userSelect: 'text' }} />
    {chunks.length > 1 && <Button variant="ghost" onClick={() => setExpanded(true)}>Show more</Button>}
    {expanded && <TextDetail text={text} title="Agent response" onClose={() => setExpanded(false)} />}
  </div>
}
