// A spinning glyph (`animate-spin`: 1 s linear infinite).
//
// Patched native build (`native/patches/rotate_gpui.py`): `paintAnimation: { kind: 'rotate', cycleMs }` on a passive
// fixed-size SVG. The renderer re-rotates the glyph's sprite at every presented frame without element render,
// layout or prepaint, so a spinner costs a scene replay per frame, not a window rebuild (measured on the PR page:
// ~41% CPU as a native motion tween, ~12% as a scoped paint animation). There is no JS clock and no React work.
// With the stock npm addon (`KYBERN_GPUIX_NATIVE=npm`) it falls back to one long linear native motion tween.
// While the window is hidden, covered or minimized (the poll in `native/visibility.ts`, which runs only while
// something spins) the glyph is replaced by a still one so no frames are requested; under Reduce Motion it is
// still. Rotation about the glyph's centre needs a square glyph: every kit icon is.
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { StyleDesc } from '@gpuix/react'
import { PATCHED_NATIVE } from '../native/local-build.ts'
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
    () => (run && !PATCHED_NATIVE ? { generation: ++generation, isExit: false, initial: { rotate: 0 }, animate: { rotate: 360 * TURNS }, transition: { duration: (TURNS * periodMs) / 1000, ease: LINEAR } } : null),
    [run, periodMs],
  )
  // The still glyph is the same element without the motion, so a test id and layout survive hiding.
  return <svg testId={testId} source={source} {...(motion ? ({ motion } as object) : run ? { paintAnimation: { kind: 'rotate', cycleMs: periodMs } } : {})} style={{ width: size, height: size, flexShrink: 0, color, ...style }} />
}
