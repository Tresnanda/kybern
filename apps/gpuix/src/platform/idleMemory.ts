// Return memory a background window does not need. Once the window has not been
// key (another app is in front) or has been hidden for BACKGROUND_RELEASE_MS,
// the native renderer drops what its next frame can rebuild (`releaseIdleMemory`:
// the window-sized path target, cached instance buffers, backdrop scratch, the
// private small-allocation heap) and the JS heap is collected. A quick switch to
// another app keeps everything warm. Glyph and image atlases, caches, mounted
// content and compiled JS stay, so reopening is not slower. `Bun.shrink` would
// return the freed JS pages sooner but discards compiled code, which slowed the
// next long-thread and code-file opens (`perf/ramfix/README.md`); it is opt-in.
// Once per background period: becoming key and visible again re-arms it.
// Driven by window-state events (`native/windowState.ts`); no timer runs while
// the window stays in the foreground.
import { isWindowVisible, onWindowVisibility } from '../native/visibility.ts'
import { hasWindowStateEvents, onWindowStateChange } from '../native/windowState.ts'

export const BACKGROUND_RELEASE_MS = 60_000

type Releasable = { releaseIdleMemory?: (options?: { queue?: boolean }) => { gpuBytes?: number } | null }
/** Also replace the Metal command queue. Measured no effect on the driver's
 *  retained memory (perf/ramfix/README.md), so only an experiment opts in. */
const RECREATE_QUEUE = process.env.KYBERN_IDLE_QUEUE === '1'
const log = (message: string) => { if (process.env.KYBERN_DEBUG_IDLE_MEMORY) console.log(`[idle-memory] ${message}`) }

/** Release now; returns the native GPU bytes released and the time it took. */
export function releaseIdleMemory(renderer: object) {
  const started = performance.now()
  let gpuBytes = 0
  try {
    gpuBytes = (renderer as Releasable).releaseIdleMemory?.({ queue: RECREATE_QUEUE })?.gpuBytes ?? 0
  } catch { /* An addon without the release keeps its memory. */ }
  Bun.gc(true)
  if (process.env.KYBERN_IDLE_SHRINK === '1') (Bun as { shrink?: () => void }).shrink?.()
  const ms = performance.now() - started
  log(`released gpu=${gpuBytes} in ${ms.toFixed(1)} ms`)
  return { gpuBytes, ms }
}

let installed = false
/** Follow the window: release after it has spent BACKGROUND_RELEASE_MS in the background. */
export function installIdleMemory(renderer: object, isFocused: () => boolean, delayMs = BACKGROUND_RELEASE_MS) {
  if (installed || process.env.KYBERN_IDLE_RELEASE === '0' || !hasWindowStateEvents()) return
  installed = true
  let timer: ReturnType<typeof setTimeout> | undefined
  let released = false
  const background = () => !isWindowVisible() || !isFocused()
  const sync = () => {
    if (!background()) {
      clearTimeout(timer)
      timer = undefined
      released = false
      return
    }
    if (released || timer) return
    timer = setTimeout(() => {
      timer = undefined
      if (!background()) return
      released = true
      releaseIdleMemory(renderer)
    }, delayMs)
  }
  // Visibility listeners re-read occlusion first; key changes arrive as state events.
  onWindowVisibility(sync)
  onWindowStateChange(() => queueMicrotask(sync))
  sync()
}
