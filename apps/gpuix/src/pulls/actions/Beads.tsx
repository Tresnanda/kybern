// A workflow's recent runs on one branch as a string of beads (ADE-97, "C · Pipeline"), oldest first: a filled dot per finished
// run in its status colour, a hollow amber ring while one runs, a hollow neutral ring while one waits or after a cancel, the
// selected run ringed. Each bead opens its run. Beads are interned per run and attempt (`bead` in actionsPipeline.ts) and the
// row is memoized on them, so a refresh that changes nothing renders nothing.
//
// Motion: a run that appears while the row is on screen slides in 8 px (native spring, 0.3 s, no bounce) as it fades in; a
// bead whose status changes cross-fades (`SwapOnChange`). Reduce Motion keeps the fades and drops the slide.
import { memo, useRef } from 'react'
import { RUN_WORDS, type RunBucket } from '../../../../../packages/kybern-client/src/actions.ts'
import { sameRow, type Bead, type BeadRow } from '../../../../../packages/kybern-client/src/actionsPipeline.ts'
import { PaintTranslate } from '../../drag/PaintTranslate.tsx'
import { toneColor } from '../../kit/tone.ts'
import { DURATION, EASE, SwapOnChange } from '../../motion/kit.tsx'
import { PATCHED_NATIVE } from '../../native/local-build.ts'
import { ink, REDUCED_MOTION, useTheme } from '../../ui.tsx'
import { BUCKET_TONE } from '../../../../../packages/kybern-client/src/actions.ts'

/** Distance between bead centres; a bead's hit area is this wide. */
export const BEAD_PITCH = 12
const DOT = 8
const SLIDE = { type: 'spring', duration: 0.3, bounce: 0 } as const

// A click reaches every element under the pointer, so the branch row a bead sits in would open its latest run right after
// the bead opened its own. A bead (or a workflow label) notes its click; the row skips one that lands within 50 ms.
let innerClickAt = -Infinity
export const noteInnerClick = () => { innerClickAt = performance.now() }
export const innerClicked = () => performance.now() - innerClickAt < 50

function Dot({ bucket }: { bucket: RunBucket }) {
  const t = useTheme()
  const color = toneColor(t, BUCKET_TONE[bucket])
  const hollow = bucket === 'running' || bucket === 'queued' || bucket === 'cancelled'
  return <div style={{ width: DOT, height: DOT, borderRadius: DOT / 2, flexShrink: 0, ...(hollow ? { borderWidth: 1.5, borderColor: color } : { backgroundColor: bucket === 'skipped' ? ink(t, .22) : color }) }} />
}

const BeadView = memo(function BeadView({ bead, workflow, selected, slide, onOpen }: { bead: Bead; workflow: string; selected: boolean; slide: boolean; onOpen: (runId: number) => void }) {
  const t = useTheme()
  const body = <div testId={`actions-bead-${bead.runId}`} role="button" tabIndex={-1} aria-label={`${workflow} #${bead.number}, ${RUN_WORDS[bead.bucket]}`} aria-current={selected ? 'true' : undefined}
    onClick={() => { noteInnerClick(); onOpen(bead.runId) }}
    style={{ width: BEAD_PITCH, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, cursor: 'pointer' }}>
    <div style={{ width: 14, height: 14, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: selected ? ink(t, .62) : 'transparent', hover: { borderColor: selected ? ink(t, .62) : ink(t, .22) } }}>
      <SwapOnChange kind="icon" active={bead.bucket} style={{ width: DOT, height: DOT }}><Dot bucket={bead.bucket} /></SwapOnChange>
    </div>
  </div>
  if (!slide || !PATCHED_NATIVE) return body
  const fade = { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: DURATION.quick, ease: [...EASE.smoothOut] as [number, number, number, number] } }
  if (REDUCED_MOTION) return <div paintTransform={fade} style={{ display: 'flex', flexShrink: 0 }}>{body}</div>
  return <PaintTranslate initial={{ translateX: 8 }} animate={{ translateX: 0 }} transition={SLIDE} style={{ display: 'flex', flexShrink: 0 }}>
    <div paintTransform={fade} style={{ display: 'flex' }}>{body}</div>
  </PaintTranslate>
})

/** One workflow's bead string. `selected` is the open run's id, if it is in this row. */
export const BeadString = memo(function BeadString({ row, selected, onOpen }: { row: BeadRow; selected: number | null; onOpen: (runId: number) => void }) {
  // Runs the row has drawn: only a run that arrives after the row mounted slides in (scrolling a row back in doesn't).
  const seen = useRef<Set<number> | null>(null)
  const first = seen.current === null
  if (first) seen.current = new Set(row.beads.map(b => b.runId))
  const fresh = new Set<number>()
  if (!first) for (const b of row.beads) if (!seen.current!.has(b.runId)) { fresh.add(b.runId); seen.current!.add(b.runId) }
  // A bead keeps its slide wrapper once it had one, so a later render doesn't remount it mid-spring.
  const slid = useRef(new Set<number>())
  for (const id of fresh) slid.current.add(id)
  return <div testId={`actions-beads-${row.workflowId}`} style={{ display: 'flex', alignItems: 'center', flexShrink: 1, minWidth: 0, overflow: 'hidden' }}>
    {row.beads.map(b => <BeadView key={b.runId} bead={b} workflow={row.workflow} selected={b.runId === selected} slide={slid.current.has(b.runId)} onOpen={onOpen} />)}
  </div>
}, (a, b) => a.onOpen === b.onOpen && a.selected === b.selected && sameRow(a.row, b.row))
