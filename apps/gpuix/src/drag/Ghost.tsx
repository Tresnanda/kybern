// The lifted item and the slot it will land in.
//
// Carry: the ghost starts exactly on the source rect and follows the pointer from the grab offset
// (an instantaneous native translation of the fixed source box; no list layout is touched).
// Lift: GPUIX has no subtree scale, so the
// ghost grows a few px (width/height tween) while a soft shadow fades in behind it.
// Settle: the frozen outer box stays put and an inner translation springs to the slot, starting with
// the release velocity; Escape or an invalid drop springs back to the source rect instead.
import { motion, type MotionTransition } from '@gpuix/react'
import { AnimatePresence } from '@gpuix/react'
import { useEffect, useRef, type ReactNode } from 'react'
import { alpha } from '../transcript/kit.tsx'
import { REDUCED_MOTION, useTheme } from '../ui.tsx'
import { LIFT, SPRING } from './spring.ts'

export type Rect = { x: number; y: number; width: number; height: number }
export type Settle = { to: { x: number; y: number }; vx: number; vy: number; home: boolean }

export function DragGhost({ rect, grab, x, y, settle, onSettled, radius = 10, pacing, bare, landing, testId, children }: {
  /** Source rect in layer coordinates: where the ghost appears. */
  rect: Rect
  /** Pointer offset inside the item at pickup. */
  grab: { x: number; y: number }
  /** Pointer, in layer coordinates (frozen by the caller at release). */
  x: number
  y: number
  settle: Settle | null
  onSettled: () => void
  radius?: number
  pacing?: (node: never) => void
  /** The children draw the held item themselves (fill, radius, shadow): no lift growth, shadow layer or surface of its own. */
  bare?: boolean
  /** Replaces the landing and return springs (a tween, for a surface that lands on a fixed curve). */
  landing?: MotionTransition
  testId?: string
  children: ReactNode
}) {
  const t = useTheme()
  const left = x - grab.x, top = y - grab.y
  const done = useRef(false)
  useEffect(() => {
    done.current = false
    // Reduce Motion stays instant and functional: the item is simply placed.
    if (settle && REDUCED_MOTION) { done.current = true; onSettled(); return }
    // A hidden or occluded window can pause the animation clock; the ghost must still land.
    if (!settle) return
    const timer = setTimeout(() => { if (!done.current) { done.current = true; onSettled() } }, 900)
    return () => clearTimeout(timer)
  }, [settle])
  const finish = () => { if (settle && !done.current) { done.current = true; onSettled() } }
  const grow = REDUCED_MOTION || bare ? 0 : LIFT.grow
  const growY = REDUCED_MOTION || bare ? 0 : LIFT.growY
  const lifted = !settle
  return (
    <motion.div ref={pacing as never} testId={testId} initial={false} animate={{ translateX: left - rect.x, translateY: top - rect.y }} transition={{ duration: 0 }} style={{ position: 'absolute', left: rect.x, top: rect.y, width: rect.width, height: rect.height, pointerEvents: 'none' }}>
      <motion.div
        initial={false}
        animate={settle ? { translateX: settle.to.x - left, translateY: settle.to.y - top } : { translateX: 0, translateY: 0 }}
        transition={settle && !REDUCED_MOTION ? (landing ?? { ...(settle.home ? SPRING.home : SPRING.land), velocityX: settle.vx, velocityY: settle.vy }) : { duration: 0 }}
        onMotionComplete={finish}
        style={{ position: 'absolute', left: 0, top: 0, width: rect.width, height: rect.height, pointerEvents: 'none' }}
      >
        {bare ? children : <>
        {/* Shadow: fades in at pickup, out as the item lands. */}
        <motion.div
          initial={{ opacity: REDUCED_MOTION ? 1 : 0 }}
          animate={{ opacity: lifted ? 1 : 0 }}
          transition={{ duration: REDUCED_MOTION ? 0 : lifted ? LIFT.shadowMs : 0.22, ease: [0.23, 1, 0.32, 1] }}
          style={{ position: 'absolute', left: -grow / 2, top: -growY / 2, width: rect.width + grow, height: rect.height + growY, borderRadius: radius, boxShadow: { offsetX: 0, offsetY: 10, blurRadius: 28, spreadRadius: 0, color: 'rgba(0, 0, 0, 0.32)' }, pointerEvents: 'none' }}
        />
        <motion.div
          initial={{ left: 0, top: 0, width: rect.width, height: rect.height }}
          animate={lifted ? { left: -grow / 2, top: -growY / 2, width: rect.width + grow, height: rect.height + growY } : { left: 0, top: 0, width: rect.width, height: rect.height }}
          transition={{ duration: REDUCED_MOTION ? 0 : lifted ? 0.14 : 0.2, ease: [0.23, 1, 0.32, 1] }}
          style={{ position: 'absolute', display: 'flex', flexDirection: 'column', justifyContent: 'center', overflow: 'hidden', borderRadius: radius, backgroundColor: t.surface, borderWidth: 1, borderColor: alpha(t.border, 1), pointerEvents: 'none' }}
        >
          {children}
        </motion.div>
        </>}
      </motion.div>
    </motion.div>
  )
}

/** Where the item will land. It fades and scales in on the first target, then springs between targets. */
export function DropSlot({ rect, tone, testId }: { rect: Rect | null; tone: 'ok' | 'none'; testId?: string }) {
  const t = useTheme()
  const color = tone === 'none' ? t.red : t.v('--color-border-focus')
  return (
    <AnimatePresence>
      {rect && (
        <motion.div
          key="slot"
          testId={testId}
          initial={{ opacity: 0, translateX: rect.x, translateY: rect.y + (REDUCED_MOTION ? 0 : 4) }}
          animate={{ opacity: 1, translateX: rect.x, translateY: rect.y }}
          exit={{ opacity: 0 }}
          transition={REDUCED_MOTION ? { duration: 0 } : { type: 'spring', duration: 0.3, bounce: 0.05 }}
          style={{ position: 'absolute', left: 0, top: 0, width: rect.width, height: rect.height, borderRadius: 10, borderWidth: 1, borderColor: alpha(color, 0.5), backgroundColor: alpha(color, 0.1), pointerEvents: 'none' }}
        />
      )}
    </AnimatePresence>
  )
}
