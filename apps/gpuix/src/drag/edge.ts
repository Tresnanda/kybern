/** Edge auto-scroll speed in px/s, growing with how deep the pointer is in the zone (and past the edge). */
import { onFrame } from '../native/frame.ts'
export const EDGE_ZONE = 56
export const EDGE_MAX = 900
export function edgeSpeed(pos: number, start: number, end: number, zone = EDGE_ZONE, max = EDGE_MAX): number {
  const above = start + zone - pos
  const below = pos - (end - zone)
  if (above > 0) return -max * Math.min(1, above / (zone + 12)) ** 1.5
  if (below > 0) return max * Math.min(1, below / (zone + 12)) ** 1.5
  return 0
}
/** Integrate edge scrolling with the window's shared frame delivery. */
export function startFrameLoop(tick: (dt: number) => void) {
  let last = performance.now()
  return onFrame(now => {
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    tick(dt)
  })
}
