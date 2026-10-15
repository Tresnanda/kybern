// Window behaviour GPUIX 0.10.0 does not expose, through the Objective-C runtime
// (`native/objc.ts`) and one poll:
//
// - the frame (size and position) is saved and restored via AppKit's own frame
//   string (`stringWithSavedFrame` / `setFrameFromString:`), which survives a
//   changed screen layout; both take and return pointers, so no struct FFI;
// - the window's width feeds the thread panel's narrow-window rule (`layout.ts`);
// - macOS Light/Dark is read from `NSApp.effectiveAppearance` and reported to
//   `appearance.ts`, which re-themes the app live.
//
// One 300 ms timer covers all three. A tick that changes nothing costs one
// native size read; the frame string and appearance are read every third tick.
// Every failure falls back to GPUI's default (the window just keeps its size).
import type { Pointer } from 'bun:ffi'
import type { NativeRenderer } from '@gpuix/react'
import { cls, cstr, each, getObjc, nsApp, sel, type Objc } from '../native/objc.ts'
import { readSystemVariant, setSystemVariant } from './appearance.ts'
import { setWindowSize } from './layout.ts'
import { load, save } from './persist.ts'

const FRAME_KEY = 'kybern.window.frame'
const POLL_MS = 300

const mac = process.platform === 'darwin'

/** Saving waits until a saved frame has been restored, or it would overwrite it with the default. */
let frameReady = !mac || !load<string | null>(FRAME_KEY, null)

/** The app's window: the first on-screen (or minimized) NSWindow that is not an AppKit helper. */
function appWindow(o: Objc): Pointer | null {
  const app = nsApp()
  if (!app) return null
  let found: Pointer | null = null
  each(o, o.msg(app, sel(o, 'windows')) as Pointer, (window) => {
    if (found) return
    const minimized = (Number(o.msgU64(window, sel(o, 'isMiniaturized'))) & 0xff) !== 0
    const onScreen = (Number(o.msgU64(window, sel(o, 'isVisible'))) & 0xff) !== 0
    if (minimized || onScreen) found = window
  })
  return found
}

const nsString = (o: Objc, text: string) => o.msgPtrArg(cls(o, 'NSString'), sel(o, 'stringWithUTF8String:'), cstr(text)) as Pointer

/** Put the window back where it was; false when nothing is saved or the window is not up yet. */
export function restoreWindowFrame(): boolean {
  if (!mac) return true
  const saved = load<string | null>(FRAME_KEY, null)
  if (!saved) return true
  try {
    const o = getObjc()
    const window = appWindow(o)
    if (!window) return false
    o.msgSetPtr(window, sel(o, 'setFrameFromString:'), nsString(o, saved))
    return true
  } catch {
    return true
  }
}

/** Retry until GPUI has opened its window (a few frames after `render`). */
export function installWindowFrame() {
  if (frameReady) return
  let tries = 0
  const tick = () => {
    if (restoreWindowFrame() || ++tries > 40) {
      frameReady = true
      return
    }
    setTimeout(tick, 25)
  }
  setTimeout(tick, 0)
}

function readFrame(o: Objc, window: Pointer): string | null {
  const text = o.msgCStr(o.msg(window, sel(o, 'stringWithSavedFrame')) as Pointer, sel(o, 'UTF8String'))
  return text ? String(text) : null
}

/** Whether the app's window is the key (focused) window; true when unknown. */
export function isWindowFocused(): boolean {
  if (!mac) return true
  try {
    const o = getObjc()
    const window = appWindow(o)
    return window ? (Number(o.msgU64(window, sel(o, 'isKeyWindow'))) & 0xff) !== 0 : true
  } catch {
    return true
  }
}

let started = false
/** Start the poll. Called once, after the renderer exists. */
export function startWindowShell(renderer: NativeRenderer) {
  if (started) return
  started = true
  let width = 0
  let height = 0
  let beat = 0
  let lastFrame = ''
  const tick = () => {
    try {
      const size = renderer.getWindowSize?.()
      const resized = !!size && (size.width !== width || size.height !== height)
      if (size) {
        width = size.width
        height = size.height
        setWindowSize(width, height)
      }
      if (!mac) return
      // The frame (position moves without resizing) and the OS appearance: every third tick.
      if (++beat % 3 !== 1 && !resized) return
      const o = getObjc()
      const window = appWindow(o)
      if (!window) return
      const frame = readFrame(o, window)
      if (frameReady && frame && frame !== lastFrame) {
        lastFrame = frame
        save(FRAME_KEY, frame)
      }
      const variant = readSystemVariant()
      if (variant) setSystemVariant(variant)
    } catch {
      // Keep polling; a failed read changes nothing.
    }
  }
  tick()
  setInterval(tick, POLL_MS)
}
