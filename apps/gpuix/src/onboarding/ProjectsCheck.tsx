// The box on a project row: the kit Checkbox's look (16 px, radius 5, 1.5 px ink ring, accent fill, white tick that strokes in), as a
// controlled, display-only box. The kit Checkbox draws only for its own click; here the box also changes from Select all, from a
// row arriving pre-checked and from the import, so it animates on any change after mount (SPEC §4). Paint-only: the fill is a
// `paintTransform`, the tick a native `strokeDraw`, the done pop a keyframe scale. The row owns the click and the keyboard.
import { useRef } from 'react'
import { useControls } from '../kit/controls.ts'
import { EASE } from '../motion/tokens.ts'
import { strokeDraw } from '../motion/success.ts'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { REDUCED_MOTION, useTheme } from '../ui.tsx'
import { bez } from './motion.tsx'

const CHECK = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-linecap="round" stroke-linejoin="round" stroke-width="3"><path d="M5.252 12.7 10.2 18.63 18.748 5.37"/></svg>'

export function ProjectsCheck({ checked, done = false, animateFirst = false, delay = 0 }: {
  checked: boolean
  /** The project is imported: a green box that pops once. */
  done?: boolean
  /** Fill and draw on the first paint (a row arriving pre-checked). */
  animateFirst?: boolean
  /** Seconds before that first fill. */
  delay?: number
}) {
  const t = useTheme()
  const c = useControls()
  const motion = PATCHED_NATIVE && !REDUCED_MOTION
  // Only a change made while mounted animates (a box that starts checked shows its check at rest), except an arrival.
  const last = useRef<{ checked: boolean; done: boolean; fill: number; pop: number; wait: number } | null>(null)
  if (last.current === null) last.current = { checked, done, fill: animateFirst && checked ? 1 : 0, pop: 0, wait: delay }
  else {
    const was = last.current
    if (was.checked !== checked) { was.fill += checked ? 1 : 0; was.wait = 0 }
    if (was.done !== done) { was.pop += done ? 1 : 0; was.wait = 0 }
    was.checked = checked
    was.done = done
  }
  const { fill, pop, wait } = last.current
  const on = done ? t.green : c.check.on
  const play = motion && fill > 0
  const draw = play ? strokeDraw(24, 40 + Math.round(wait * 1000), { cycleMs: 260 }) : undefined
  return (
    <div
      paintTransform={motion && pop > 0
        ? { initial: { scale: 1 }, keyframes: [{ offset: 0.4, scale: 1.25 }], animate: { scale: 1 }, transition: { duration: 0.5, ease: bez(EASE.out) }, generation: pop }
        : undefined}
      style={{ position: 'relative', display: 'flex', width: 16, height: 16, flexShrink: 0, borderRadius: 5, borderWidth: 1.5, borderColor: checked ? 'rgba(0, 0, 0, 0)' : c.check.edge, pointerEvents: 'none' }}
    >
      {checked && (
        <div
          key={`fill${fill}`}
          paintTransform={play ? { initial: { opacity: 0, scale: 0.8 }, animate: { opacity: 1, scale: 1 }, transition: { duration: 0.15, delay: wait, ease: bez(EASE.smoothOut) } } : undefined}
          style={{ position: 'absolute', left: -1.5, top: -1.5, width: 16, height: 16, borderRadius: 5, backgroundColor: on, pointerEvents: 'none' }}
        />
      )}
      {checked && (
        <svg
          key={`tick${fill}`}
          source={CHECK}
          {...(draw ? { paintAnimation: draw } : {})}
          style={{ position: 'absolute', left: 0.5, top: 0.5, width: 12, height: 12, color: c.check.tick, pointerEvents: 'none' }}
        />
      )}
    </div>
  )
}
