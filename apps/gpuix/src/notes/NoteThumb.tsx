// A gallery card's miniature: the note's first blocks drawn small (desktop
// `NoteThumb.tsx` + `.mini` in notes.css). Sizes are ems of one base size.
import { memo, type ReactNode } from 'react'
import type { MiniBlock, MiniDoc, MiniSpan } from '@/state/miniMarkdown'
import type { NoteSummary } from '../../../../packages/kybern-client/src/types.ts'
import { FONT_MONO } from '../theme.ts'
import { Label, useTheme } from '../ui.tsx'
import { clear, notesTokens } from './kit.tsx'
import { thumbLift } from './motion.ts'
import { useNoteThumb } from './thumbs.ts'

const SHORT_LINES = 4
export { NOTE_EASE, NOTE_LIFT_MS, NOTE_LIFT_PX } from './motion.ts'
/** The desktop thumbnail's tick (`Tick` in NoteThumb.tsx). */
const TICK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M2.2 5.2 4.1 7.1 7.9 3" fill="none" stroke="#000" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const text = (spans: MiniSpan[]) => spans.map((s) => s.text).join('')

function Block({ block, fs, k }: { block: MiniBlock; fs: number; k: ReturnType<typeof notesTokens> }) {
  const lh = fs * 1.6
  switch (block.kind) {
    case 'heading':
      return <Label color={k.fg} size={fs * 1.133} lineHeight={fs * 1.133 * 1.3} weight={block.level === 1 ? 700 : 600}>{text(block.spans)}</Label>
    case 'paragraph':
      return <Label color={k.fg1} size={fs} lineHeight={lh}>{text(block.spans)}</Label>
    case 'quote':
      return <div style={{ display: 'flex', paddingLeft: fs * 1.07, borderLeftWidth: fs * 0.13, borderColor: k.fg4 }}><Label color={k.fg2} size={fs} lineHeight={lh}>{text(block.spans)}</Label></div>
    case 'checklist':
      return <div style={{ display: 'flex', flexDirection: 'column', gap: fs * 0.27 }}>{block.items.map((item, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: fs * 0.8, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: fs * 1.067, height: fs * 1.067, borderRadius: fs * 0.3, flexShrink: 0, ...(item.done ? { backgroundColor: k.checkOn } : { borderWidth: fs * 0.1, borderColor: k.fg4 }) }}>
            {item.done && <svg source={TICK} style={{ width: fs * 0.67, height: fs * 0.67, color: k.card }} />}
          </div>
          <Label color={item.done ? k.fg3 : k.fg1} size={fs} lineHeight={lh} truncate style={item.done ? { textDecoration: 'line-through' } : undefined}>{text(item.spans)}</Label>
        </div>))}</div>
    case 'list':
      return <div style={{ display: 'flex', flexDirection: 'column', gap: fs * 0.27 }}>{block.items.map((spans, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: fs * 0.8, minWidth: 0 }}>
          <Label color={k.fg3} size={fs} lineHeight={lh} style={{ minWidth: fs * 0.6 }}>{block.ordered ? `${i + 1}.` : '•'}</Label>
          <Label color={k.fg1} size={fs} lineHeight={lh} truncate>{text(spans)}</Label>
        </div>))}</div>
    case 'code':
      return <div style={{ display: 'flex', flexDirection: 'column', paddingTop: fs * 0.8, paddingBottom: fs * 0.8, paddingLeft: fs * 0.93, paddingRight: fs * 0.93, borderRadius: fs * 0.67, backgroundColor: k.fill, overflow: 'hidden' }}>
        {block.lines.map((line, i) => <Label key={i} color={k.fg1} size={fs * 0.87} lineHeight={fs * 0.87 * 1.54} font={FONT_MONO} style={{ whiteSpace: 'nowrap' }}>{line || ' '}</Label>)}</div>
    case 'rule':
      return <div style={{ height: fs * 0.07, backgroundColor: k.fg4 }} />
  }
}

function gap(prev: MiniBlock | undefined, block: MiniBlock, fs: number): number {
  if (!prev) return 0
  if (block.kind === 'heading') return fs * 1.06
  if (prev.kind === 'heading') return fs * 0.4
  // Paragraphs and quotes carry no margin (`.mini p`); every other block follows at .53em.
  return block.kind === 'paragraph' || block.kind === 'quote' ? 0 : fs * 0.53
}

export const NoteThumb = memo(function NoteThumb({ note, big, active, lift, pressed = false }: { note: NoteSummary; big: boolean; active: boolean; lift: boolean; pressed?: boolean }) {
  const t = useTheme()
  const k = notesTokens(t)
  const loaded = useNoteThumb(note)
  const preview = note.preview.trim()
  const doc: MiniDoc = loaded ?? { blocks: preview ? [{ kind: 'paragraph', spans: [{ text: preview }] }] : [], lines: Math.ceil(preview.length / 64) }
  const empty = doc.blocks.length === 0
  const short = !empty && doc.lines <= SHORT_LINES
  // `--n-read` (16.15px) times the thumbnail scale: .6, .66 (pinned), .74 (short), .8 (pinned and short).
  const fs = 16.1538 * (short ? (big ? 0.8 : 0.74) : big ? 0.66 : 0.6)
  const pad = short ? { v: fs * 1.2, h: fs * 2 } : { v: fs * (big ? 1.73 : 1.87), h: fs * 2 }
  const body: ReactNode = doc.blocks.map((block, i) => <div key={i} style={{ marginTop: gap(doc.blocks[i - 1], block, fs) }}><Block block={block} fs={fs} k={k} /></div>)
  return (
    <div testId={`note-thumb-${note.id}`} style={{ position: 'relative', borderRadius: 12 }}>
    <div paintTransform={thumbLift(lift, pressed)} style={{ position: 'relative', height: big ? 184 : 156, borderRadius: 12, backgroundColor: k.card, overflow: 'hidden', display: 'flex', flexDirection: 'column', justifyContent: short || empty ? 'center' : 'flex-start', boxShadow: k.cardShadow, borderWidth: t.variant === 'dark' ? 0 : 0.5, borderColor: k.ring, ...(active ? { borderWidth: 2, borderColor: t.composerFocusBorder } : {}), pointerEvents: 'none' }}>
      {empty ? <div style={{ display: 'flex', justifyContent: 'center' }}><Label color={k.fg4} size={13}>No text yet</Label></div>
        : <div style={{ display: 'flex', flexDirection: 'column', paddingTop: pad.v, paddingBottom: pad.v, paddingLeft: pad.h, paddingRight: pad.h, ...(big ? { maxWidth: fs * 56 + pad.h * 2 } : {}) }}>{body}</div>}
      {!short && !empty && <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 40, borderBottomLeftRadius: 12, borderBottomRightRadius: 12, background: { type: 'linear-gradient', angle: 180, stops: [{ color: clear(k.card), position: 0 }, { color: k.card, position: 1 }] } }} />}
    </div>
    </div>
  )
})
