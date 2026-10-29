// Field log for the native frame watchdog (gpui_macos window.rs, macOS). When a
// visible window goes 250 ms without a display-link frame, a draw gets no Metal
// drawable, or the compositor holds every drawable (`DrawableStarved`, gpui_apple
// drawable_gate.rs: draws are skipped instead of blocking the main thread), the
// addon repairs it and raises a window-state event, also when a starvation ends; this
// appends the native report as one line to `gpuix-frames.log` beside the
// daemon's data (`KYBERN_DATA_DIR` or `~/.kybern`), so a freeze seen in real use
// can be matched to its cause afterwards. Nothing polls: the line is written
// from that event. The file is replaced by `.old` past 256 KB.
import { appendFileSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'
import { localDataDir } from '../environments/registry.ts'
import { writeAllowed } from '../shell/persist.ts'
import { onWindowStateChange } from '../native/windowState.ts'

export type FrameWatchdogReport = {
  frames: number
  stalls: number
  repairs: number
  lastStall: string | null
  droppedFrames: number
  representedFrames: number
  slowDrawables: number
  maxDrawableWaitMs: number
  // Older addons leave these out.
  drawableStarvations?: number
  drawableRecoveries?: number
  starvedSkips?: number
  drawableKicks?: number
  lastStarvation?: string | null
}

type WatchdogRenderer = { getFrameWatchdog?: () => FrameWatchdogReport | null }

const MAX_BYTES = 256 * 1024

/** The log line for what changed between two reports, or null when no stall, dropped drawable or drawable starvation was added. */
export function frameLogLine(previous: FrameWatchdogReport | null, next: FrameWatchdogReport, at = new Date()): string | null {
  const stalls = next.stalls - (previous?.stalls ?? 0)
  const dropped = next.droppedFrames - (previous?.droppedFrames ?? 0)
  const starved = (next.drawableStarvations ?? 0) - (previous?.drawableStarvations ?? 0)
  const recovered = (next.drawableRecoveries ?? 0) - (previous?.drawableRecoveries ?? 0)
  if (stalls <= 0 && dropped <= 0 && starved <= 0 && recovered <= 0) return null
  const parts = [at.toISOString()]
  if (stalls > 0) parts.push(`stall x${stalls} (${next.repairs} repaired in total): ${next.lastStall ?? 'unknown'}`)
  if (dropped > 0) parts.push(`no drawable x${dropped} (${next.representedFrames} presented again in total)`)
  if (starved > 0 || recovered > 0) {
    const counts = `${next.starvedSkips ?? 0} draws skipped, ${next.drawableKicks ?? 0} kicks in total`
    parts.push(`${recovered > 0 ? 'starvation ended' : `starvation x${starved}`} (${counts}): ${next.lastStarvation ?? 'DrawableStarved'}`)
  }
  parts.push(`slow drawables ${next.slowDrawables}, longest wait ${next.maxDrawableWaitMs.toFixed(0)} ms`)
  return `${parts.join('; ')}\n`
}

let installed = false
export function installFrameWatchdogLog(renderer: object, file = path.join(localDataDir, 'gpuix-frames.log'), onChange = onWindowStateChange) {
  const native = renderer as WatchdogRenderer
  if (installed || typeof native.getFrameWatchdog !== 'function' || !writeAllowed(file)) return
  installed = true
  let previous = native.getFrameWatchdog()
  onChange(() => {
    const next = native.getFrameWatchdog?.()
    if (!next) return
    const line = frameLogLine(previous, next)
    previous = next
    if (!line) return
    console.warn(`[frame-watchdog] ${line.trimEnd()}`)
    try {
      if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) renameSync(file, `${file}.old`)
      appendFileSync(file, line, { mode: 0o600 })
    } catch { /* A read-only data dir keeps the console line only. */ }
  })
}
