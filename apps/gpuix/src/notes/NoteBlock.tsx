import { notesMarkdownStyle } from '../native/markdown.ts'
import { memo, useEffect, useMemo, useState } from 'react'
import type { TaskItem } from '../../../../packages/kybern-client/src/types.ts'
import { httpBase } from '../../../../packages/kybern-client/src/address.ts'
import { StatusGlyph } from '../tasks/Glyphs.tsx'
import { ink, Label, useTheme } from '../ui.tsx'
import { over } from '../theme.ts'
import type { SyntaxTheme } from '@gpuix/react'
import { cachedMarkdownTheme } from '../transcript/kit.tsx'
import { rpc } from './store.ts'
import { notesTokens } from './kit.tsx'
import { openLink } from './NoteEditor.tsx'

export const NoteBlock = memo(function NoteBlock({ body, noteId, tasks, width }: { body: string; noteId: string; tasks: TaskItem[]; width: number }) {
  const t = useTheme()
  const theme = useMemo(() => { const base = cachedMarkdownTheme(t); const k = notesTokens(t)
    const fill = over(k.fill, t.surface)
    const plain: SyntaxTheme = Object.fromEntries(['comment', 'keyword', 'string', 'stringSpecial', 'escape', 'number', 'boolean', 'typeName', 'typeBuiltin', 'constructor', 'function', 'functionBuiltin', 'macroName', 'property', 'constant', 'variable', 'variableSpecial', 'parameter', 'operator', 'punctuation', 'tag', 'attribute', 'label'].map((key) => [key, k.fg1])) as unknown as SyntaxTheme
    // `.note-prose pre`: a filled card with plain ink, no border, no syntax colours (the desktop does not highlight here).
    return { ...base, accent: t.textTertiary, bg: fill, border: fill, codeText: k.fg, codeWash: k.fill, markdown: {...notesMarkdownStyle(k.fg, k.fg2, k.fg4, k.fill, 16.1538, k.fg3),link:{color:t.v('--color-token-text-link-foreground'),underline:'always' as const}}, syntax: plain, text: t.variant === 'dark' ? 'rgba(252, 252, 252, 0.86)' : 'rgba(13, 13, 13, 0.86)', metrics: { ...base.metrics, mdTextSize: 16.1538, mdLineHeight: 25.846, mdBlockGap: 15.02, mdHeadingSizes: [18.3077, 18.3077, 16.1538, 16.1538], mdHeadingLineHeights: [23.8, 23.8, 23.4, 23.4], codeTextSize: 13.46, codeLineHeight: 22.6, mdCodePaddingX: 16, mdCodePaddingY: 14, mdCodeRadius: 10, mdInlineCodeRadius: 5, mdCodeHeaderTextSize: 0.01, mdCodeHeaderPaddingY: 0 } } }, [t])
  // Atom-only blocks preserve their exact Markdown in the editor. Inline references
  // keep the surrounding Markdown and gain live, actionable status chips below it.
  const image = /^!\[((?:\\.|[^\]])*)\]\((kybern:\/\/asset\/[a-f\d-]{36}|https?:\/\/[^\s)]+)\)\s*$/i.exec(body)
  if (image) return <NoteImage width={width} noteId={noteId} source={image[2]!} label={image[1]!} />
  const referenced = tasks.filter((task) => body.includes(`kybern://task/${task.id}`))
  const atomOnly = referenced.length === 1 && /^\[[^\]]+\]\(kybern:\/\/task\/[a-f\d-]{36}\)\s*$/i.test(body)
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    {!atomOnly && (body.trim() ? <markdown source={body} theme={theme} onLinkClick={(e) => { if (e.value) openLink(e.value, noteId) }} style={{ color: t.variant === 'dark' ? 'rgba(252, 252, 252, 0.86)' : 'rgba(13, 13, 13, 0.86)', userSelect: 'text' }} /> : <Label color={t.textSecondary} size={15}>Start writing, or type / for blocks…</Label>)}
    {referenced.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{referenced.map((task) => <div key={task.id} testId={`note-inline-task-${task.id}`} tabIndex={0} onClick={() => openLink(`kybern://task/${task.id}`, noteId)} onKeyDown={(e) => { if (e.key === 'enter') openLink(`kybern://task/${task.id}`, noteId) }} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: 6, borderRadius: 6, backgroundColor: t.buttonSecondary, cursor: 'pointer' }}><StatusGlyph status={task.status} /><Label color={t.text} size={12}>{`${task.key} · ${task.title}`}</Label></div>)}</div>}
  </div>
})

/** Natural size from a PNG, GIF or JPEG header; null for anything else. */
function imageSize(bytes: Uint8Array): { w: number; h: number } | null {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length > 24 && v.getUint32(0) === 0x89504e47) return { w: v.getUint32(16), h: v.getUint32(20) }
  if (bytes.length > 10 && bytes[0] === 0x47 && bytes[1] === 0x49) return { w: v.getUint16(6, true), h: v.getUint16(8, true) }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let at = 2; at + 9 < bytes.length;) {
      if (bytes[at] !== 0xff) { at++; continue }
      const marker = bytes[at + 1]!
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { h: v.getUint16(at + 5), w: v.getUint16(at + 7) }
      at += 2 + v.getUint16(at + 2)
    }
  }
  return null
}

function NoteImage({ noteId, source, label, width }: { noteId: string; source: string; label: string; width: number }) {
  const t = useTheme()
  const [loaded, setLoaded] = useState<string | null>(source.startsWith('http') ? source : null)
  const [error, setError] = useState(false)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  useEffect(() => {
    if (!source.startsWith('kybern://asset/')) { setLoaded(source); return }
    const abort = new AbortController()
    setLoaded(null); setError(false)
    const { url, token } = rpc(noteId).endpoint
    void (async () => {
      const response = await fetch(`${httpBase(url)}/assets/${source.slice('kybern://asset/'.length)}`, { headers: { authorization: `Bearer ${token}` }, signal: abort.signal })
      if (!response.ok) throw Error('Image unavailable')
      const blob = await response.blob()
      if (!blob.type.startsWith('image/') || blob.size > 12 * 1024 * 1024) throw Error('Image too large')
      const bytes = await blob.arrayBuffer()
      if (!abort.signal.aborted) { setSize(imageSize(new Uint8Array(bytes))); setLoaded(`data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`) }
    })().catch(() => { if (!abort.signal.aborted) setError(true) })
    return () => abort.abort()
  }, [noteId, source])
  // `.note-image`: the natural size, at most the column, 8px corners and a 1px ink ring.
  const w = Math.min(width, size?.w ?? width)
  const h = size ? Math.round(w * size.h / size.w) : Math.round(w * 9 / 16)
  return loaded ? <div style={{ width: w, height: h, flexShrink: 0, overflow: 'hidden', borderRadius: 8, borderWidth: 1, borderColor: ink(t, 0.07) }}><img testId="note-image" src={loaded} alt={label} objectFit="contain" style={{ width: w, height: h, borderRadius: 8 }} /></div> : <Label color={t.textSecondary} size={13}>{error ? 'Image unavailable. Reopen the note to retry.' : 'Loading image…'}</Label>
}
