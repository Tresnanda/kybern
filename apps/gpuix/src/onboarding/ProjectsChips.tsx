// The harness chips under the lede (SPEC §4): mark · name · rolling count · a matrix loader while that agent's history is read,
// then a check that draws in and the chip swells once (1 → 1.06 → 1). A failed read is a red dot and "Couldn’t read" with the error
// in a tooltip; agents that are not installed share one quiet chip. Chips rise in 80 ms apart. The loader exists only while an
// agent is scanning, so nothing loops once the scan is over.
import { useRef } from 'react'
import { MatrixLoader } from '../MatrixLoader.tsx'
import { Swap } from '../motion/kit.tsx'
import { SuccessCheck } from '../motion/SuccessCheck.tsx'
import { EASE } from '../motion/tokens.ts'
import { Tip } from '../nav/overlay.tsx'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { Label, ProviderMark, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { bez, riseTransform, Roll } from './motion.tsx'
import { list } from './model.ts'
import type { ChipInfo, Chips } from './projects.ts'

const CHIP: import('@gpuix/react').StyleDesc = { display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, height: 32, paddingLeft: 10, paddingRight: 12, borderRadius: 16, flexShrink: 0 }

/** Seconds until the scene's chip moment (700 ms after it mounted), counted from when this chip mounts. */
const lead = (since: number) => Math.max(0, (since + 700 - Date.now()) / 1000)

function Chip({ chip, index, since }: { chip: ChipInfo; index: number; since: number }) {
  const t = useTheme()
  // The swell plays when the chip turns done while it is on screen, once; a chip that is already done shows its check at rest.
  const seen = useRef<{ state: ChipInfo['state']; swell: number; drew: boolean }>({ state: chip.state, swell: 0, drew: false })
  if (seen.current.state !== chip.state) {
    if (chip.state === 'done' && seen.current.state === 'scanning') { seen.current.swell++; seen.current.drew = true }
    seen.current.state = chip.state
  }
  const { swell, drew } = seen.current
  const motion = PATCHED_NATIVE && !REDUCED_MOTION
  const failed = chip.state === 'failed'
  const body = (
    <div
      paintTransform={swell > 0 && motion ? { initial: { scale: 1 }, keyframes: [{ offset: 0.45, scale: 1.06 }], animate: { scale: 1 }, transition: { duration: 0.5, ease: bez(EASE.out) }, generation: swell, retain: true } : undefined}
      style={{ ...CHIP, backgroundColor: t.surface, borderWidth: 1, borderColor: t.cardEdge }}
    >
      <ProviderMark kind={chip.provider} size={15} />
      <Label color={t.text} size={13} lineHeight={18} weight={500} style={{ whiteSpace: 'nowrap', pointerEvents: 'none' }}>{chip.name}</Label>
      {failed
        ? <Label color={t.textSecondary} size={13} lineHeight={18} style={{ whiteSpace: 'nowrap', pointerEvents: 'none' }}>Couldn’t read</Label>
        : <Roll value={chip.sessions} size={13} lineHeight={18} color={t.textSecondary} weight={500} />}
      <Swap active={chip.state} kind="icon" still blur={false} style={{ width: 14, height: 14, flexShrink: 0 }}>
        {chip.state === 'scanning'
          ? <MatrixLoader variant="orbit" />
          : failed
            ? <div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: t.red, pointerEvents: 'none' }} />
            : <SuccessCheck size={14} color={t.green} play={drew && motion} />}
      </Swap>
    </div>
  )
  const wait = useRef<number | null>(null)
  if (wait.current === null) wait.current = lead(since)
  const risen = riseTransform({ delay: wait.current + index * 0.08, duration: 0.45, y: 10 })
  return (
    <div paintTransform={risen} style={{ display: 'flex', flexShrink: 0 }}>
      {failed && chip.error ? <Tip label={chip.error} side="bottom">{body}</Tip> : body}
    </div>
  )
}

/** One quiet chip for every agent that is not installed: its marks dimmed to 55 %, "Not installed". */
function MissingChip({ missing, index, since }: { missing: Chips['missing']; index: number; since: number }) {
  const t = useTheme()
  const names = list(missing.map((m) => m.name))
  const wait = useRef<number | null>(null)
  if (wait.current === null) wait.current = lead(since)
  const risen = riseTransform({ delay: wait.current + index * 0.08, duration: 0.45, y: 10 })
  return (
    <div paintTransform={risen} style={{ display: 'flex', flexShrink: 0 }}>
      <Tip label={`Not installed: ${names}`} side="bottom">
        <div style={{ ...CHIP, backgroundColor: t.surface, borderWidth: 1, borderColor: t.cardEdge, opacity: 0.55 }}>
          {missing.slice(0, 3).map((m) => <ProviderMark key={m.provider} kind={m.provider} size={13} />)}
          <Label color={t.textTertiary} size={13} lineHeight={18} weight={500} style={{ whiteSpace: 'nowrap', pointerEvents: 'none' }}>Not installed</Label>
        </div>
      </Tip>
    </div>
  )
}

/** The chips row. It wraps and centres; with no harness known yet it keeps its height so nothing below moves. */
export function ProjectsChips({ data, since }: { data: Chips; since: number }) {
  return (
    <div testId="projects-chips" style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: 8, minHeight: 32 }}>
      {data.chips.map((chip, i) => <Chip key={chip.provider} chip={chip} index={i} since={since} />)}
      {data.missing.length > 0 && <MissingChip missing={data.missing} index={data.chips.length} since={since} />}
    </div>
  )
}
