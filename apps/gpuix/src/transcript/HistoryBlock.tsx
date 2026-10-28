// "Earlier on Mac · 12 messages": what a thread moved here with "Continue on…" said and did on its first machine
// (design §7.2), collapsed by default and shown ahead of the first turn. User messages and the agent's answers appear
// in full up to a cap; tool calls are one line each, without their output.
import { historyLabel } from '../../../../packages/kybern-client/src/continueOn.ts'
import type { Block } from '../../../../packages/kybern-client/src/transcript.ts'
import { Collapse } from '../motion/kit.tsx'
import { FONT_UI } from '../theme.ts'
import { useTheme } from '../ui.tsx'
import { Chevron, muted, Para, ROW_LINE, TEXT } from './kit.tsx'
import { useRowState } from './store.ts'

/** The most items an opened block lists; the rest stay in the log. */
const SHOWN = 120

export function HistoryRow({ block }: { block: Extract<Block, { kind: 'history' }> }) {
  const t = useTheme()
  const [open, setOpen] = useRowState(`history:${block.id}`, false)
  const items = open ? block.items.slice(-SHOWN) : []
  const hidden = block.items.length - items.length
  return (
    <div testId="history-block" style={{ display: 'flex', flexDirection: 'column', minWidth: 0, paddingTop: 4, paddingBottom: 4 }}>
      <div testId="history-toggle" role="button" aria-expanded={open} aria-label={historyLabel(block.fromMachineName, block.items, block.omitted)} tabIndex={0}
        onClick={() => setOpen(!open)} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') setOpen(!open) }}
        style={{ display: 'flex', alignItems: 'center', gap: 8, height: ROW_LINE, cursor: 'pointer' }}>
        <Para color={muted(t)} lineHeight={ROW_LINE} style={{ flexShrink: 1, hover: { color: t.text } }}>{historyLabel(block.fromMachineName, block.items, block.omitted)}</Para>
        <Chevron open={open} color={muted(t, 0.7)} />
      </div>
      <Collapse open={open}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, paddingTop: 8, marginLeft: 22 }}>
          {hidden > 0 && <Para color={muted(t, 0.8)} lineHeight={TEXT.lineHeight}>{`${hidden} earlier ${hidden === 1 ? 'item' : 'items'} not shown`}</Para>}
          {items.map((item, index) => item.role === 'tool'
            ? <Para key={index} color={muted(t, 0.8)} size={12} lineHeight={18} selectable>{item.text}</Para>
            : <text key={index} style={{ color: item.role === 'user' ? t.text : muted(t), fontSize: TEXT.size, lineHeight: TEXT.lineHeight, fontFamily: FONT_UI, userSelect: 'text', minWidth: 0 }}>{item.role === 'user' ? `You: ${item.text}` : item.text}</text>)}
        </div>
      </Collapse>
    </div>
  )
}
