/** Pointer velocity over the last 100 ms, in logical px/s, for a spring that carries a release. */
export function createVelocityTracker() {
  let samples: { x: number; y: number; t: number }[] = []
  return {
    reset(x: number, y: number) { samples = [{ x, y, t: performance.now() }] },
    push(x: number, y: number) {
      const t = performance.now()
      samples = [...samples.filter((s) => t - s.t <= 100), { x, y, t }].slice(-24)
    },
    /** Zero when the pointer rested before release: a stale flick must not throw the item. */
    velocity(max = 3500) {
      const first = samples[0], last = samples.at(-1)
      if (!first || !last || performance.now() - last.t > 60) return { x: 0, y: 0 }
      const span = last.t - first.t
      if (span < 8) return { x: 0, y: 0 }
      const clamp = (v: number) => Math.max(-max, Math.min(max, v))
      return { x: clamp(((last.x - first.x) * 1000) / span), y: clamp(((last.y - first.y) * 1000) / span) }
    },
  }
}
