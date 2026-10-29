// Field log for the native frame watchdog (gpui_macos window.rs, macOS). When a
// visible window goes 250 ms without a display-link frame, or a draw gets no
// Metal drawable, the addon repairs it and raises a window-state event; this
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
}

type WatchdogRenderer = { getFrameWatchdog?: () => FrameWatchdogReport | null }

const MAX_BYTES = 256 * 1024

/** The log line for what changed between two reports, or null when no stall or dropped drawable was added. */
export function frameLogLine(previous: FrameWatchdogReport | null, next: FrameWatchdogReport, at = new Date()): string | null {
  const stalls = next.stalls - (previous?.stalls ?? 0)
  const dropped = next.droppedFrames - (previous?.droppedFrames ?? 0)
  if (stalls <= 0 && dropped <= 0) return null
  const parts = [at.toISOString()]
  if (stalls > 0) parts.push(`stall x${stalls} (${next.repairs} repaired in total): ${next.lastStall ?? 'unknown'}`)
  if (dropped > 0) parts.push(`no drawable x${dropped} (${next.representedFrames} presented again in total)`)
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
