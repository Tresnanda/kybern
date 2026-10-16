// The desktop's `MatrixLoader` (`components/kybern/motion.tsx`, `styles/motion.css`):
// 16 dots in a 4×4 grid, 2px with a 0.5px radius and 2px gaps. Each dot runs
// the same pulse with its own delay: rest at 22%, ease up to full by 15% of the
// cycle, back to rest by 45%. Orbit delays the eight ring dots by order × cycle/8
// and pulses the four inner dots together; orbit and pulse hide the corners, so
// the grid reads as a disc.
//
// WebKit animates those keyframes in its compositor. Native paintAnimation
// evaluates the same curves at native display callbacks without React work.
// The diagnostic JS path and non-declarative motion share the frame source.
// The diagnostic React path shares one clock across all visible loaders.
// The clock runs only while a loader is mounted and the window is visible, and
// never under Reduce Motion (loaders then hold their rest frame).
import { useCallback, useSyncExternalStore } from 'react'
import { onFrame } from './native/frame.ts'
import { isWindowVisible, onWindowVisibility } from './native/visibility.ts'
import { ink, REDUCED_MOTION, useTheme } from './ui.tsx'

// Full-app native-loop acceptance remains opt-in: repeated GPU controls did not
// meet the approved gate, and the smooth JS fallback regressed running CPU.
// Preserve the existing clock outside that experiment; it is still a known
// pacing defect, not an accepted 60 fps result. The onFrame API is independent.
export const NATIVE_PAINT_ANIMATIONS = process.env.KYBERN_NATIVE_PAINT_ANIMATIONS === '1'
const TICK_MS = Number(process.env.KYBERN_LOADER_TICK_MS ?? (NATIVE_PAINT_ANIMATIONS ? 0 : 200))
let now = 0
let stopFrame: (() => void) | undefined
let legacyTimer: ReturnType<typeof setInterval> | undefined
let stopVisibility: (() => void) | undefined
const listeners = new Set<() => void>()
function sync() {
  const run = listeners.size > 0 && !REDUCED_MOTION && isWindowVisible()
  if (run && TICK_MS > 0 && !legacyTimer) {
    // Preserve the pre-experiment resource behavior while its replacement is
    // gated. A native display subscription itself schedules recurring frames.
    legacyTimer = setInterval(() => {
      now = performance.now()
      for (const listener of listeners) listener()
    }, TICK_MS)
  } else if (run && TICK_MS <= 0 && !stopFrame) {
    stopFrame = onFrame(time => {
      if (time - now < TICK_MS) return
      now = time
      for (const listener of listeners) listener()
    })
  } else if (!run) {
    stopFrame?.()
    stopFrame = undefined
    if (legacyTimer) clearInterval(legacyTimer)
    legacyTimer = undefined
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

function useLoaderSnapshot(snapshot: () => number, active = true) {
  const connect = useCallback((listener: () => void) => {
    if (!active) return () => {}
    return subscribe(listener)
  }, [active])
  return useSyncExternalStore(connect, snapshot)
}
/** Continuous native frame time for motion; elapsed labels use coarse snapshots. */
export function useLoaderTime() { return useLoaderSnapshot(() => now) }
/** Historical port clock, retained until the smooth-loop resource gate passes. */
export function useLoaderStep() { return useLoaderSnapshot(() => Math.floor(now / 200) % 8) }

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
export function easeInOut(x: number): number {
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
  const time = useLoaderSnapshot(() => now, !NATIVE_PAINT_ANIMATIONS)
  const isRounded = rounded ?? (variant === 'orbit' || variant === 'pulse')
  const d = delays(variant, cycle)
  const size = dot * 4 + gap * 3
  return (
    // Native paint loops evaluate the desktop keyframes without React commits.
    // The diagnostic JS path uses the same binary for controlled A/B samples.
    <div {...ISLAND} style={{ display: 'flex', flexDirection: 'column', gap, width: size, height: size, flexShrink: 0 }}>
      {[0, 1, 2, 3].map((r) => (
        <div key={r} style={{ display: 'flex', gap }}>
          {[0, 1, 2, 3].map((c) => {
            const i = r * 4 + c
            const hidden = isRounded && ROUNDED_GAPS.has(i)
            const phase = REDUCED_MOTION ? 1 : ((((time - d[i]!) % cycle) + cycle) % cycle) / cycle
            const opacity = hidden ? 0 : NATIVE_PAINT_ANIMATIONS && !REDUCED_MOTION ? 1 : pulseOpacity(phase)
            return <div key={c} {...(NATIVE_PAINT_ANIMATIONS && !REDUCED_MOTION && !hidden ? { paintAnimation: { kind: 'matrix', cycleMs: cycle, delayMs: d[i] } } : {})} style={{ width: dot, height: dot, borderRadius: 0.5, backgroundColor: rgb ? `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha * opacity})` : ink(t, alpha * opacity) }} />
          })}
        </div>
      ))}
    </div>
  )
}

/** Seconds for elapsed labels; independent of display-rate animation delivery.
 * Settled labels never subscribe. */
export function useLoaderSecond(active: boolean): number {
  return useSyncExternalStore(active ? subscribeSeconds : noSubscription, () => active ? second : 0)
}

// Elapsed labels are information, not animation. They must keep advancing under
// Reduce Motion without keeping a display-rate subscription alive.
let second = Math.floor(Date.now() / 1000)
let secondTimer: ReturnType<typeof setTimeout> | undefined
let stopSecondVisibility: (() => void) | undefined
const secondListeners = new Set<() => void>()
const noSubscription = () => () => {}
function syncSeconds() {
  if (secondTimer) clearTimeout(secondTimer)
  secondTimer = undefined
  if (!secondListeners.size || !isWindowVisible()) return
  const next = Math.floor(Date.now() / 1000)
  if (next !== second) { second = next; for (const listener of secondListeners) listener() }
  secondTimer = setTimeout(syncSeconds, 1000 - Date.now() % 1000)
}
function subscribeSeconds(listener: () => void) {
  secondListeners.add(listener)
  if (!stopSecondVisibility) stopSecondVisibility = onWindowVisibility(syncSeconds)
  syncSeconds()
  return () => {
    secondListeners.delete(listener)
    if (!secondListeners.size) { stopSecondVisibility?.(); stopSecondVisibility = undefined }
    syncSeconds()
  }
}
