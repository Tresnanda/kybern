// The status glyph (or priority glyph) and the selection checkbox share one slot and cross-fade on hover and selection
// (`tasks.css` 1608-1656: 80 ms opacity, `--duration-micro`). Both stay in the slot: the base layer fades out, the checkbox layer
// mounts on demand (`Presence`) and fades in, then unmounts after its exit, so a long list carries no extra nodes at rest. Hover on
// dense rows is tens of times a day, hence the near-imperceptible 80 ms; Reduce Motion switches at once.
import type { ReactNode } from 'react'
import { EASE, DURATION } from '../motion/tokens.ts'
import { EXIT, Presence } from '../motion/Presence.tsx'
import { fadeTo } from '../shell/motion.ts'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { REDUCED_MOTION } from '../ui.tsx'

const ENTER = { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: DURATION.micro, ease: [...EASE.out] as [number, number, number, number] } }
const OUT = { to: EXIT.reveal.to, duration: DURATION.micro }

export function CheckSlot({ show, base, over, width = 26, height = 30, align = 'start' }: { show: boolean; base?: ReactNode; over: ReactNode; width?: number; height?: number; align?: 'start' | 'end' }) {
  const instant = REDUCED_MOTION || !PATCHED_NATIVE
  const dim = fadeTo(show ? 0 : 1, DURATION.micro)
  const layer = { position: 'absolute', left: 0, top: (height - 30) / 2, display: 'flex' } as const
  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: align === 'end' ? 'flex-end' : 'flex-start', width, height, flexShrink: 0 }}>
      {base && <div paintTransform={dim.paintTransform} style={{ display: 'flex', ...dim.style, ...(show ? { pointerEvents: 'none' } : {}) }}>{base}</div>}
      <Presence show={show} enter={instant ? undefined : ENTER} exit={instant ? { ...OUT, duration: 0 } : OUT} style={layer}>{over}</Presence>
    </div>
  )
}
