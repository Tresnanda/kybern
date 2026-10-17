// A spinning glyph (`animate-spin`: 1 s linear infinite) on GPUIX's native SVG rotation.
//
// The rotation is one long linear native tween (`TURNS` full turns), so the renderer advances it every
// frame with no React or JS work per frame, and JS wakes once per `TURNS` seconds to restart it. There is
// no JS clock driving visible movement (the legacy `Spinner` in `shell/Connection.tsx` steps 8 frames at
// 5 Hz; its continuous variant commits React every frame). While the window is hidden, covered or
// minimized (the poll in `native/visibility.ts`, which runs only while something spins) the glyph is
// replaced by a still one so no frames are requested; under Reduce Motion it is still. Rotation about the
// glyph's centre needs a square glyph: every kit icon is.
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { StyleDesc } from '@gpuix/react'
import { isWindowVisible, onWindowVisibility } from '../native/visibility.ts'
import { REDUCED_MOTION } from '../ui.tsx'

/** Tailwind's `animate-spin`. */
export const SPIN_PERIOD_MS = 1000
/** Full turns in one tween: restarts (a one-frame hitch is possible there) happen about once an hour. */
const TURNS = 3600
const LINEAR: [number, number, number, number] = [0, 0, 1, 1]
let generation = 9_000_000

function subscribeVisible(listener: () => void) {
  return onWindowVisibility(listener)
}
/** Whether the window is on screen; polling runs only while a spinner is mounted. */
export function useWindowVisible() {
  return useSyncExternalStore(useCallback(subscribeVisible, []), isWindowVisible)
}

export function SpinIcon({
  source,
  size = 16,
  color,
  spinning = true,
  periodMs = SPIN_PERIOD_MS,
  style,
  testId,
}: {
  /** Glyph source, e.g. `N.loader`. */
  source: string
  size?: number
  color: string
  /** False holds the glyph still (the desktop shows the same glyph when a check is not running). */
  spinning?: boolean
  periodMs?: number
  style?: StyleDesc
  testId?: string
}) {
  const visible = useWindowVisible()
  const run = spinning && visible && !REDUCED_MOTION
  const motion = useMemo(
    () => (run ? { generation: ++generation, isExit: false, initial: { rotate: 0 }, animate: { rotate: 360 * TURNS }, transition: { duration: (TURNS * periodMs) / 1000, ease: LINEAR } } : null),
    [run, periodMs],
  )
  // The still glyph is the same element without the motion, so a test id and layout survive hiding.
  return <svg testId={testId} source={source} {...(motion ? ({ motion } as object) : {})} style={{ width: size, height: size, flexShrink: 0, color, ...style }} />
}
