import { isWindowVisible, onWindowVisibility } from './visibility.ts'

interface FrameRenderer {
  subscribeAnimationFrames(callback: (error: Error | null, event: { timeMs: number }) => void): number
  acknowledgeAnimationFrame(token: number): void
  unsubscribeAnimationFrames(token: number): void
}

let renderer: FrameRenderer | undefined
let token: number | undefined
let generation = 0
let fallback: ReturnType<typeof setTimeout> | undefined
let stopVisibility: (() => void) | undefined
const listeners = new Set<(now: number) => void>()

/** Install the app's existing renderer; replacing it invalidates queued callbacks. */
export function installFrameSource(value: object) {
  if (renderer === value) return
  stop()
  renderer = value as FrameRenderer
  sync()
}

function stop() {
  generation++
  if (token !== undefined) renderer?.unsubscribeAnimationFrames(token)
  token = undefined
  if (fallback !== undefined) clearTimeout(fallback)
  fallback = undefined
}

function deliver() {
  // Use the JS monotonic clock so replacing/restarting the native source cannot
  // reset consumer time. All consumers of a delivery receive the same timestamp.
  const now = performance.now()
  for (const listener of [...listeners]) {
    if (listeners.has(listener)) {
      try { listener(now) } catch (error) { console.error('[frame]', error) }
    }
  }
}

function sync() {
  if (!listeners.size || !isWindowVisible()) { stop(); return }
  if (token !== undefined || fallback !== undefined) return
  const current = ++generation, active = renderer
  if (typeof active?.subscribeAnimationFrames === 'function') {
    token = active.subscribeAnimationFrames((error) => {
      const deliveredToken = token
      if (current !== generation || renderer !== active || deliveredToken === undefined) return
      try {
        if (error) console.error('[frame]', error)
        else deliver()
      } finally {
        if (current === generation) active.acknowledgeAnimationFrame(deliveredToken)
      }
    })
  } else {
    // Stock/older addons lack display callbacks. This compatibility path is
    // bounded to one scheduled delivery; the patched production addon uses vsync.
    const tick = () => {
      fallback = undefined
      if (generation !== current || !listeners.size || !isWindowVisible()) return
      const started = performance.now()
      deliver()
      if (generation === current && listeners.size) fallback = setTimeout(tick, Math.max(0, 1000/60 - (performance.now()-started)))
    }
    fallback = setTimeout(tick, 1000/60)
  }
}

/** Shared native display callbacks, parked without subscribers or while hidden.
 * These are display-source ticks, not GPU presentation-fence acknowledgements.
 */
export function onFrame(callback: (now: number) => void): () => void {
  listeners.add(callback)
  if (!stopVisibility) stopVisibility = onWindowVisibility(sync)
  sync()
  return () => {
    listeners.delete(callback)
    if (!listeners.size) { stopVisibility?.(); stopVisibility = undefined }
    sync()
  }
}
