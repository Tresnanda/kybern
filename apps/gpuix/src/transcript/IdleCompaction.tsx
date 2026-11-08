// Kybern's compaction of an idle thread (issue #295): the context-refresh row's look (`Rotation.tsx`), a hairline
// row with the label between the lines. It says "Compacting…" with a shimmer while the turn runs, then settles in
// place ("Compacted while you were away · 14:58") with a chevron that opens a small card: sizes before and after,
// how early it ran, what it means for the next message, and a way to the setting. It stands for the whole turn:
// the `/compact` message and the harness's own compaction notices are folded into it by the shared projection.
import { memo, useMemo } from 'react'
import { IDLE_COMPACTION_COPY, idleCompactionMeta, idleCompactionRowLabel } from '../../../../packages/kybern-client/src/compaction.ts'
import type { IdleCompactionBlock } from '../../../../packages/kybern-client/src/transcript.ts'
import { Button } from '../kit/Button.tsx'
import { useControls } from '../kit/controls.ts'
import { Collapse, enterTransform, lineEnterTransform } from '../motion/kit.tsx'
import { Label, useTheme } from '../ui.tsx'
import { clockTime } from './clock.ts'
import { Chevron, muted, Para } from './kit.tsx'
import { Shimmer, SwapOnChange, useFresh } from './motion.tsx'
import { useRowState } from './store.ts'

const LABEL = { size: 12, lineHeight: 16 }
const BODY = { size: 13, lineHeight: 19.5 }

function openCompactionSettings() {
  void import('../settings/SettingsScreen.tsx').then((m) => m.openSettingsTab('agents'))
}

export const IdleCompactionRow = memo(function IdleCompactionRow({ block }: { block: IdleCompactionBlock }) {
  const t = useTheme()
  const c = useControls()
  // Decided once on mount: only a row that just arrived plays its entrance.
  const fresh = useFresh(block.at)
  const [open, setOpen] = useRowState(`idle-compaction:${block.id}`, false)
  const arrival = useMemo(() => fresh ? { left: lineEnterTransform([1, 0.5]), label: enterTransform('label'), right: lineEnterTransform([0, 0.5]) } : null, [fresh])
  const pending = !block.finishedAt
  const label = idleCompactionRowLabel(block, clockTime(block.finishedAt ?? block.at))
  const toggle = () => { if (!pending) setOpen(!open) }
  return (
    <div testId={`idle-compaction-${block.turnId}`} style={{ display: 'flex', flexDirection: 'column', paddingTop: 8, paddingBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div paintTransform={arrival?.left} style={{ height: 1, flexGrow: 1, backgroundColor: t.border }} />
        <div paintTransform={arrival?.label} style={{ display: 'flex', alignItems: 'center', flexShrink: 1, minWidth: 0 }}>
          <div
            testId={`idle-compaction-toggle-${block.turnId}`}
            role="button"
            tabIndex={pending ? -1 : 0}
            aria-label={label}
            aria-expanded={open}
            onClick={toggle}
            onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') toggle() }}
            style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 8, paddingRight: 8, paddingTop: 3, paddingBottom: 3, borderRadius: 7, minWidth: 0, cursor: pending ? 'default' : 'pointer', ...(pending ? {} : { hover: { backgroundColor: t.hover } }) }}
          >
            <SwapOnChange kind="state" active={pending ? 'pending' : 'settled'} style={{ justifyContent: 'flex-start' }} innerStyle={{ minWidth: 0 }}>
              {pending
                ? <Shimmer text={label} color={muted(t)} size={LABEL.size} lineHeight={LABEL.lineHeight} />
                : <Label color={muted(t)} size={LABEL.size} lineHeight={LABEL.lineHeight} truncate style={{ hover: { color: t.text } }}>{label}</Label>}
            </SwapOnChange>
            {!pending && <Chevron open={open} size={12} color={muted(t, 0.7)} />}
          </div>
        </div>
        <div paintTransform={arrival?.right} style={{ height: 1, flexGrow: 1, backgroundColor: t.border }} />
      </div>
      <Collapse open={open && !pending} testId={`idle-compaction-panel-${block.turnId}`}>
        <div testId={`idle-compaction-card-${block.turnId}`} style={{ display: 'flex', flexDirection: 'column', marginTop: 10, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: t.border, backgroundColor: c.ink(t.variant === 'dark' ? 0.03 : 0.04) }}>
          <Label color={t.text} size={12} lineHeight={16} weight={500}>{block.failed ? IDLE_COMPACTION_COPY.failedTitle : IDLE_COMPACTION_COPY.title}</Label>
          <Para color={muted(t)} size={11.5} lineHeight={16} style={{ marginTop: 2 }}>{idleCompactionMeta(block)}</Para>
          <Para color={t.text} size={BODY.size} lineHeight={BODY.lineHeight} selectable style={{ marginTop: 8 }}>{block.failed ? IDLE_COMPACTION_COPY.failedBody : IDLE_COMPACTION_COPY.body}</Para>
          <div style={{ display: 'flex', marginTop: 10 }}>
            <Button variant="ghost" size="sm" testId="idle-compaction-settings" onClick={openCompactionSettings}>{IDLE_COMPACTION_COPY.settings}</Button>
          </div>
        </div>
      </Collapse>
    </div>
  )
})
