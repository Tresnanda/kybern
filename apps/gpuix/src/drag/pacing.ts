// Opt-in measurement of how often a dragged element is really painted.
// `KYBERN_DRAG_PACING=<dir>` records one JSON per drag with the intervals between
// native bounds notifications (one per painted frame in which the box changed).
// Without the variable nothing is subscribed.
import { useEffect, useState } from 'react'
import { useGpuixRequired, type PublicInstance } from '@gpuix/react'
import { writeFileSync, mkdirSync } from 'node:fs'
import { observeElementBounds } from '../native/layout.ts'

const dir = process.env.KYBERN_DRAG_PACING
const inputs = new Map<string, {time: number; x: number; y: number}>()
/** Opt-in JS event → matching post-paint native bounds probe, not display latency. */
export function recordDragPointer(label: string, x: number, y: number) {
  if (dir) inputs.set(label, {time: performance.now(), x, y})
}
const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
export function summarize(times: number[]) {
  const intervals = times.slice(1).map((t, i) => t - times[i]!)
  const sorted = [...intervals].sort((a, b) => a - b)
  return { frames: times.length, p50: +pct(sorted, 0.5).toFixed(2), p95: +pct(sorted, 0.95).toFixed(2), max: +(sorted.at(-1) ?? 0).toFixed(2), intervals: intervals.map((v) => +v.toFixed(1)) }
}
/** Pass the returned ref to the element that follows the pointer. */
export function usePacing(label: string) {
  const renderer = useGpuixRequired()
  const [node, ref] = useState<PublicInstance | null>(null)
  useEffect(() => {
    if (!dir || !node) return
    const times: number[] = []
    const probes: {input: number; painted: number; delay: number; x: number; y: number}[] = []
    const stop = observeElementBounds(renderer, node.id, ({rect}) => {
      const now = performance.now()
      times.push(now)
      const input = inputs.get(label)
      if (input && rect && Math.abs(rect.x - input.x) < 1 && Math.abs(rect.y - input.y) < 1) probes.push({input:input.time,painted:now,delay:now-input.time,x:rect.x,y:rect.y})
    })
    return () => {
      stop()
      console.error('[pacing]', label, times.length)
      if (times.length < 3) return
      mkdirSync(dir, { recursive: true })
      const delays = probes.map(p => p.delay).sort((a,b) => a-b)
      writeFileSync(`${dir}/${label}-${Date.now()}.json`, JSON.stringify({...summarize(times), pointerToBounds: {kind:'JS move to matching native post-paint notification; not display presentation', samples:probes.length, p50:+pct(delays,.5).toFixed(2), p95:+pct(delays,.95).toFixed(2)}, probes}))
    }
  }, [node, renderer, label])
  return dir ? ref : undefined
}
