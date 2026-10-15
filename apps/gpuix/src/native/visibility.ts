// Window visibility for loop animations, like the desktop's `observeLoopVisibility`
// (loops pause in hidden windows). GPUIX 0.10.0 reports no window activation or
// occlusion, so this polls the app's NSWindows through the Objective-C runtime:
// a window counts as visible when AppKit's occlusion state has the Visible bit
// and it is not minimized. Covered by other windows, minimized, or on another
// Space means hidden. Polling costs a few message sends per second and never
// touches React; listeners only hear about changes.
import type { Pointer } from 'bun:ffi'
import { cls, each, getObjc, sel } from './objc.ts'

const NS_WINDOW_OCCLUSION_STATE_VISIBLE = 1 << 1
const POLL_MS = 400

let visible = true
let timer: ReturnType<typeof setInterval> | undefined
const listeners = new Set<(visible: boolean) => void>()

function read(): boolean {
  if (process.platform !== 'darwin') return true
  try {
    const o = getObjc()
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
  } catch {
    return true
  }
}

/** Whether any app window is on screen; true when it cannot be determined. */
export function isWindowVisible(): boolean {
  return visible
}

/** Hear about visibility changes; polling runs only while someone listens. */
export function onWindowVisibility(listener: (visible: boolean) => void): () => void {
  listeners.add(listener)
  if (!timer) {
    visible = read()
    timer = setInterval(() => {
      const next = read()
      if (next === visible) return
      visible = next
      if (process.env.KYBERN_DEBUG_VISIBILITY) console.log(`[visibility] ${next ? 'visible' : 'hidden'}`)
      for (const l of listeners) l(next)
    }, POLL_MS)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = undefined
    }
  }
}
