// The desktop's `MatrixLoader` (`components/kybern/motion.tsx`, `styles/motion.css`):
// 16 dots in a 4×4 grid, 2px with a 0.5px radius and 2px gaps. Each dot runs
// the same pulse with its own delay: rest at 22%, ease up to full by 15% of the
// cycle, back to rest by 45%. Orbit delays the eight ring dots by order × cycle/8
// and pulses the four inner dots together; orbit and pulse hide the corners, so
// the grid reads as a disc.
//
// WebKit animates those keyframes in its compositor. GPUI lays out the whole
// window for any change, so every loader samples the keyframes from ONE shared
// clock: one React commit and one frame per tick however many loaders show.
// The clock runs only while a loader is mounted and the window is visible, and
// never under Reduce Motion (loaders then hold their rest frame).
import { useSyncExternalStore } from 'react'
import { isWindowVisible, onWindowVisibility } from './native/visibility.ts'
import { ink, REDUCED_MOTION, useTheme } from './ui.tsx'

/** Ticks per loop step. Each tick re-lays out the whole window (~19 ms of CPU
 *  on the home screen, 2026-10-14): 100 ms costs ~21% CPU, 200 ms ~13%, 400 ms
 *  ~8%. 200 ms keeps the desktop's pattern with coarser steps.
 *  `KYBERN_LOADER_TICK_MS` overrides it for measurement. */
const TICK_MS = Number(process.env.KYBERN_LOADER_TICK_MS ?? 200)

let now = 0
let timer: ReturnType<typeof setInterval> | undefined
let stopVisibility: (() => void) | undefined
const listeners = new Set<() => void>()

// The clock ticks only while a loader is mounted AND the window is on screen
// (desktop: loops pause in hidden windows). Covered or minimized, it stops.
function sync() {
  const run = listeners.size > 0 && !REDUCED_MOTION && isWindowVisible()
  if (run && !timer) {
    now = performance.now()
    timer = setInterval(() => {
      now = performance.now()
      for (const l of listeners) l()
    }, TICK_MS)
  } else if (!run && timer) {
    clearInterval(timer)
    timer = undefined
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (!stopVisibility && !REDUCED_MOTION) stopVisibility = onWindowVisibility(sync)
  sync()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      stopVisibility?.()
      stopVisibility = undefined
    }
    sync()
  }
}

/** Marks a fixed-size `cache` island (native/patches/cache_island.rs). */
export const ISLAND = { cache: true } as Record<string, unknown>
/** An island sized by its parent (flex-grow / stretch) instead of its own width and height. */
export const FILL_ISLAND = { cache: 'fill' } as Record<string, unknown>

export type MatrixVariant = 'scan' | 'twinkle' | 'orbit' | 'pulse'

const TWINKLE_ORDER = [7, 2, 11, 5, 14, 9, 0, 12, 3, 15, 6, 10, 13, 1, 8, 4]
const ORBIT_RING = [1, 2, 7, 11, 14, 13, 8, 4]
const PULSE_INNER = [5, 6, 9, 10]
const ROUNDED_GAPS = new Set([0, 3, 12, 15])
const REST = 0.22

/** `matrixDelays` from the desktop, in ms per dot index (row-major). */
function delays(variant: MatrixVariant, cycle: number): number[] {
  const d = new Array<number>(16).fill(0)
  if (variant === 'scan') for (let i = 0; i < 16; i++) d[i] = (i % 4) * (cycle / 10)
  if (variant === 'twinkle') TWINKLE_ORDER.forEach((dot, order) => (d[dot] = order * (cycle / 16)))
  if (variant === 'orbit') ORBIT_RING.forEach((dot, order) => (d[dot] = order * (cycle / 8)))
  if (variant === 'pulse') for (let i = 0; i < 16; i++) d[i] = PULSE_INNER.includes(i) ? 0 : cycle * 0.16
  return d
}

/** CSS `ease-in-out`, cubic-bezier(0.42, 0, 0.58, 1). */
function easeInOut(x: number): number {
  const bez = (t: number, a: number, b: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3
  let lo = 0
  let hi = 1
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2
    if (bez(mid, 0.42, 0.58) < x) lo = mid
    else hi = mid
  }
  return bez((lo + hi) / 2, 0, 1)
}

/** `@keyframes t-matrix-pulse`: 0%, 45%, 100% at rest; 15% at full. */
function pulseOpacity(phase: number): number {
  if (phase < 0.15) return REST + (1 - REST) * easeInOut(phase / 0.15)
  if (phase < 0.45) return 1 - (1 - REST) * easeInOut((phase - 0.15) / 0.3)
  return REST
}

export function MatrixLoader({
  variant = 'orbit',
  cycle = 1200,
  alpha = 0.58 * 0.7,
  dot = 2,
  gap = 2,
  rounded,
  rgb,
}: {
  variant?: MatrixVariant
  cycle?: number
  /** Ink opacity, like the desktop's `text-muted-foreground/70` (0.58 × 0.7). */
  alpha?: number
  dot?: number
  gap?: number
  rounded?: boolean
  /** Dots in this colour instead of the theme ink (a loader on an ink-filled button). */
  rgb?: readonly [number, number, number]
}) {
  const t = useTheme()
  const time = useSyncExternalStore(subscribe, () => now)
  const isRounded = rounded ?? (variant === 'orbit' || variant === 'pulse')
  const d = delays(variant, cycle)
  const size = dot * 4 + gap * 3
  return (
    // A cached island (patched GPUIX): a tick re-renders these 16 dots, and the
    // rest of the window replays its previous frame.
    <div {...ISLAND} style={{ display: 'flex', flexDirection: 'column', gap, width: size, height: size, flexShrink: 0 }}>
      {[0, 1, 2, 3].map((r) => (
        <div key={r} style={{ display: 'flex', gap }}>
          {[0, 1, 2, 3].map((c) => {
            const i = r * 4 + c
            const hidden = isRounded && ROUNDED_GAPS.has(i)
            const phase = REDUCED_MOTION ? 1 : ((((time - d[i]!) % cycle) + cycle) % cycle) / cycle
            const opacity = hidden ? 0 : pulseOpacity(phase)
            return <div key={c} style={{ width: dot, height: dot, borderRadius: 0.5, backgroundColor: rgb ? `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha * opacity})` : ink(t, alpha * opacity) }} />
          })}
        </div>
      ))}
    </div>
  )
}

/** A 0–7 step (200 ms each, a 1.6 s loop) for other loops on the shared clock,
 *  such as the transcript's "Thinking" pulse. Re-renders only when the step
 *  changes; holds still under Reduce Motion. */
export function useLoaderStep(): number {
  return useSyncExternalStore(subscribe, () => Math.floor(now / 200) % 8)
}
