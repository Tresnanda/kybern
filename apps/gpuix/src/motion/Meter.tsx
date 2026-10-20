// `.limit-meter-track > span` (`RailUsage`, usage bars; `width` 400 ms `--ease-out`): a bar that fills without layout. GPUIX's
// `paintTransform` scale is uniform (no `scaleX`), so the fill is a full-length block inside an `overflow: hidden` rounded track,
// slid along its axis by `paintTransform` translation: the track's mask stays where the layout put it (masks at a scope's entry
// stay in window coordinates, `native/README.md`), the fill's end keeps its radius, and nothing re-lays out per frame.
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { REDUCED_MOTION } from '../ui.tsx'
import { DURATION, EASE } from './tokens.ts'

/**
 * A meter bar `value` (0..1) full. `length` and `thickness` are the track's size along and across `axis` (`'x'` fills left to
 * right, `'y'` grows upward from the bottom, like the usage bars); `radius` rounds both the track and the fill. `play` makes the
 * fill grow in from empty when the meter mounts (fresh content only); later `value` changes retarget from what is on screen over
 * `DURATION.slow` (400 ms, `--ease-out`). Reduce Motion sets the value at once; the stock addon draws the fill with a layout
 * width/height (no animation).
 */
export function MeterFill({ value, axis = 'x', length, thickness, radius, color, play = false, testId }: { value: number; axis?: 'x' | 'y'; length: number; thickness: number; radius: number; color: string; play?: boolean; testId?: string }) {
  const v = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))
  const x = axis === 'x'
  const track = { display: 'flex', overflow: 'hidden', flexShrink: 0, borderRadius: radius, width: x ? length : thickness, height: x ? thickness : length } as const
  if (!PATCHED_NATIVE) {
    return (
      <div testId={testId} style={{ ...track, flexDirection: x ? 'row' : 'column', justifyContent: x ? 'flex-start' : 'flex-end' }}>
        <div style={{ width: x ? length * v : thickness, height: x ? thickness : length * v, borderRadius: radius, backgroundColor: color }} />
      </div>
    )
  }
  // The fill sits at the track's start (left / bottom); `rest` is how far it is pushed out of the track.
  const hidden = (1 - v) * length
  const offset = (distance: number) => (x ? { translateX: -distance } : { translateY: distance })
  return (
    <div testId={testId} style={{ ...track, flexDirection: 'column' }}>
      <div
        paintTransform={{
          initial: play && !REDUCED_MOTION ? offset(length) : false,
          animate: offset(hidden),
          transition: { duration: REDUCED_MOTION ? 0 : DURATION.slow, ease: [...EASE.out] },
        }}
        style={{ width: x ? length : thickness, height: x ? thickness : length, borderRadius: radius, backgroundColor: color, flexShrink: 0 }}
      />
    </div>
  )
}
