// Window visibility for loop animations, like the desktop's `observeLoopVisibility`
// (loops pause in hidden windows). A window counts as visible when AppKit's
// occlusion state has the Visible bit and it is not minimized. Covered by other
// windows, minimized, or on another Space means hidden. The state is read
// through the Objective-C runtime when AppKit reports a window-state change
// (`windowState.ts`); an addon without that callback polls instead. Off macOS
// the event carries the state: on Windows minimized, hidden or cloaked on
// another virtual desktop means hidden (being covered by other windows is not
// reported); Linux cannot tell, so its windows count as visible. Never touches
// React; listeners only hear about changes.
import type { Pointer } from 'bun:ffi'
import { cls, each, getObjc, sel, withPool } from './objc.ts'
import { hasWindowStateEvents, onWindowStateChange, windowStateReport } from './windowState.ts'

const NS_WINDOW_OCCLUSION_STATE_VISIBLE = 1 << 1
const POLL_MS = 400

let visible = true
let timer: ReturnType<typeof setInterval> | undefined
let stopEvents: (() => void) | undefined
const listeners = new Set<(visible: boolean) => void>()

function read(): boolean {
  if (process.platform !== 'darwin') return windowStateReport()?.visible ?? true
  try {
    const o = getObjc()
    return withPool(o, () => {
      const app = o.msg(cls(o, 'NSApplication'), sel(o, 'sharedApplication')) as Pointer
      let any = false
      let shown = false
      each(o, o.msg(app, sel(o, 'windows')) as Pointer, (window) => {
        // A minimized window reports isVisible = NO, so check it first; other
        // invisible windows are AppKit helpers and are skipped.
        const minimized = (Number(o.msgU64(window, sel(o, 'isMiniaturized'))) & 0xff) !== 0
        const onScreen = (Number(o.msgU64(window, sel(o, 'isVisible'))) & 0xff) !== 0
        if (!minimized && !onScreen) return
        any = true
        const state = Number(o.msgU64(window, sel(o, 'occlusionState')))
        if (!minimized && state & NS_WINDOW_OCCLUSION_STATE_VISIBLE) shown = true
      })
      return any ? shown : true
    })
  } catch {
    return true
  }
}

/** Whether any app window is on screen; true when it cannot be determined. */
export function isWindowVisible(): boolean {
  return visible
}

function check() {
  const next = read()
  if (next === visible) return
  visible = next
  if (process.env.KYBERN_DEBUG_VISIBILITY) console.log(`[visibility] ${next ? 'visible' : 'hidden'}`)
  for (const l of listeners) l(next)
}
/** Each window-state event re-reads; without events, a poll does. */
function follow() {
  if (hasWindowStateEvents()) {
    clearInterval(timer)
    timer = undefined
  } else if (!timer) {
    timer = setInterval(check, POLL_MS)
  }
  check()
}

/** Hear about visibility changes; reading runs only while someone listens. */
export function onWindowVisibility(listener: (visible: boolean) => void): () => void {
  listeners.add(listener)
  if (!stopEvents) {
    visible = read()
    stopEvents = onWindowStateChange(follow)
    follow()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && stopEvents) {
      stopEvents()
      stopEvents = undefined
      clearInterval(timer)
      timer = undefined
    }
  }
}
