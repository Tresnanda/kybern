// The desktop's `Skeleton` (`components/kit/skeleton.tsx`): a `--muted` block (radius 6 by default) with a light
// band sweeping across it: `linear-gradient(120deg, transparent 40%, highlight, transparent 60%)` sized 200% × 100%
// of the window and attached to it (`background-attachment: fixed`), moved one tile (2 window widths) every 2 s
// (`--animate-skeleton: skeleton 2s -1s infinite linear`, kit.css:6 and :70). Every skeleton on screen therefore
// shows the same sweep, in step. The highlight is white at 64% (light) or 4% (dark). The desktop keeps the sweep
// under Reduce Motion (the utility is not `motion-safe`), and so does this.
//
// GPUIX: the band is a child element (two halves with two-stop horizontal gradients; the desktop's 30° slant moves the
// band by under 12 px across a 40 px-tall block, which this approximates with the band position at the block's
// vertical centre) that a linear paint-only translation (`paintTransform`, `native/patches/subtree_transform.rs`)
// carries across the block: frames re-place the retained band without a render, layout or island wake. One pass
// covers one crossing; the next (a new generation, which restarts from `initial`) starts, re-phased from the shared
// clock, while the band is outside the block, so the restart is never visible. No JS runs per frame; the band holds
// still while the window is hidden.
import { useGpuixRequired, type PublicInstance, type StyleDesc } from '@gpuix/react'
import { useLayoutEffect, useRef, useState } from 'react'
import { useTheme } from '../ui.tsx'
import { useWindowVisible } from './Spin.tsx'

/** One sweep (`skeleton 2s`). */
export const SKELETON_CYCLE_MS = 2000
const EPOCH = performance.now()
const LINEAR: [number, number, number, number] = [0, 0, 1, 1]
let generation = 41_000_000

/** Where the band's centre crosses the row at window `y`, in window x, at time `ms` since `EPOCH` (mod one tile). */
export function bandCentre(y: number, ms: number, view: { width: number; height: number }) {
  const tile = view.width * 2
  // `animation-delay: -1s`: the animation is half a cycle in at time 0.
  const f = (((ms + SKELETON_CYCLE_MS / 2) / SKELETON_CYCLE_MS) % 1 + 1) % 1
  // Gradient line through the tile's centre at 120°: the 50% line is x = cx - (y - cy)·tan 30°.
  const x = tile / 2 - (y - view.height / 2) * Math.tan(Math.PI / 6) + tile * f
  return { x: ((x % tile) + tile) % tile, tile }
}
/** Half the band's width along a row: 10% of the gradient line, over sin 60°. */
export function bandHalf(view: { width: number; height: number }) {
  const line = view.width * 2 * Math.sin(Math.PI / 3) + view.height * Math.cos(Math.PI / 3)
  return (0.1 * line) / Math.sin(Math.PI / 3)
}

export interface SkeletonProps {
  width?: number | `${number}%`
  height?: number
  /** Corner radius (6 is `rounded-sm`; pass `height / 2` for `rounded-full`). */
  radius?: number
  /** Window size the sweep is attached to (the desktop's `fixed` background). Default 1280 × 820. */
  view?: { width: number; height: number }
  /** Hold the sweep (tests). */
  still?: boolean
  testId?: string
  style?: StyleDesc
}

export function Skeleton({ width = '100%', height = 16, radius = 6, view = { width: 1280, height: 820 }, still = false, testId, style }: SkeletonProps) {
  const t = useTheme()
  const renderer = useGpuixRequired()
  const ref = useRef<PublicInstance>(null)
  const visible = useWindowVisible()
  const [pass, setPass] = useState<{ generation: number; from: number; to: number; ms: number } | null>(null)
  const half = bandHalf(view)
  const highlight = t.variant === 'dark' ? 'rgba(255, 255, 255, 0.04)' : 'rgba(255, 255, 255, 0.64)'
  const clear = 'rgba(255, 255, 255, 0)'

  // Plan the next pass from the shared clock: the band's left edge goes from just left of the block to past its right edge.
  const plan = () => {
    const b = ref.current ? renderer.getElementBounds?.(ref.current.id) : null
    if (!b || b.width === 0) return false
    const { x, tile } = bandCentre(b.y + b.height / 2, performance.now() - EPOCH, view)
    const speed = tile / SKELETON_CYCLE_MS
    const start = -2 * half, end = start + tile
    let left = x - b.x - half
    while (left < start) left += tile
    while (left >= end) left -= tile
    setPass({ generation: ++generation, from: left, to: end, ms: (end - left) / speed })
    return true
  }
  const run = visible && !still
  useLayoutEffect(() => {
    if (!run) { setPass(null); return }
    let tries = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const first = () => { if (!plan() && ++tries < 20) timer = setTimeout(first, 16) }
    first()
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run])

  return (
    <div ref={ref} testId={testId} style={{ position: 'relative', width, height, flexShrink: 0, borderRadius: radius, overflow: 'hidden', backgroundColor: t.v('--muted'), ...style }}>
      {pass && (
        <div
          testId={testId ? `${testId}-band` : undefined}
          paintTransform={{ generation: pass.generation, initial: { translateX: pass.from }, animate: { translateX: pass.to }, transition: { duration: pass.ms / 1000, ease: LINEAR } }}
          onMotionComplete={(e) => { if (e.motionGeneration === pass.generation && run) plan() }}
          style={{ position: 'absolute', top: 0, left: 0, width: half * 2, height: '100%', display: 'flex', pointerEvents: 'none' }}
        >
          <div style={{ width: half, height: '100%', background: { type: 'linear-gradient', angle: 90, stops: [{ color: clear, position: 0 }, { color: highlight, position: 1 }] } }} />
          <div style={{ width: half, height: '100%', background: { type: 'linear-gradient', angle: 90, stops: [{ color: highlight, position: 0 }, { color: clear, position: 1 }] } }} />
        </div>
      )}
    </div>
  )
}
