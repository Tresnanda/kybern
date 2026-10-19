// Window behaviour GPUIX 0.10.0 does not expose, through the Objective-C runtime
// (`native/objc.ts`) and native layout events:
//
// - the frame (size and position) is saved and restored via AppKit's own frame
//   string (`stringWithSavedFrame` / `setFrameFromString:`), which survives a
//   changed screen layout; both take and return pointers, so no struct FFI;
// - native resize events feed the thread panel/dock narrow-window rules;
// - macOS Light/Dark is read from `NSApp.effectiveAppearance` and reported to
//   `appearance.ts`, which re-themes the app live.
//
// One 900 ms timer reads position and appearance; it never reads window size.
// Every failure falls back to GPUI's default (the window just keeps its size).
import type { Pointer } from 'bun:ffi'
import type { NativeRenderer } from '@gpuix/react'
import { cls, cstr, each, getObjc, nsApp, sel, type Objc } from '../native/objc.ts'
import { onWindowResize } from '../native/layout.ts'
import { readSystemVariant, setSystemVariant } from './appearance.ts'
import { setWindowWidth } from './layout.ts'
import { load, save } from './persist.ts'
import { refreshAccessibilityDisplay } from '../platform/material.ts'

const FRAME_KEY = 'kybern.window.frame'
const POLL_MS = 900
// Automation chooses an explicit built-in-display frame before showing the
// window. This also keeps original-addon A/B runs independent of saved frames.
const automationFrame = process.env.GPUIX_BACKGROUND === '1' ? process.env.KYBERN_AUTOMATION_WINDOW_FRAME : undefined
const savedFrame = () => automationFrame || load<string | null>(FRAME_KEY, null)

const mac = process.platform === 'darwin'

/** Saving waits until a saved frame has been restored, or it would overwrite it with the default. */
let frameReady = !mac || !savedFrame()

/** The app's window: the first on-screen (or minimized) NSWindow; `hidden` also accepts one not shown yet. */
function appWindow(o: Objc, hidden = false): Pointer | null {
  const app = nsApp()
  if (!app) return null
  let found: Pointer | null = null
  each(o, o.msg(app, sel(o, 'windows')) as Pointer, (window) => {
    if (found) return
    const minimized = (Number(o.msgU64(window, sel(o, 'isMiniaturized'))) & 0xff) !== 0
    const onScreen = (Number(o.msgU64(window, sel(o, 'isVisible'))) & 0xff) !== 0
    if (minimized || onScreen || (hidden && o.msg(window, sel(o, 'contentView')))) found = window
  })
  return found
}

const nsString = (o: Objc, text: string) => o.msgPtrArg(cls(o, 'NSString'), sel(o, 'stringWithUTF8String:'), cstr(text)) as Pointer

/** Whether there is a saved frame to restore: `main.tsx` then opens the window hidden. */
export const hasSavedFrame = () => mac && !!savedFrame()

/**
 * Put the window back where it was, then show it. The window opens hidden when
 * a frame is saved (`show: false`), so it never flashes at the default place;
 * a window that was shown anyway is just moved. False when it is not up yet.
 */
export function restoreWindowFrame(): boolean {
  if (!mac) return true
  const saved = savedFrame()
  if (!saved) return true
  try {
    const o = getObjc()
    const window = appWindow(o, true)
    if (!window) return false
    o.msgSetPtr(window, sel(o, 'setFrameFromString:'), nsString(o, saved))
    if (automationFrame) {
      const expected = automationFrame.trim().split(/\s+/).slice(0, 4).map(Number)
      const actual = readFrame(o, window)?.trim().split(/\s+/).slice(0, 4).map(Number)
      if (expected.length !== 4 || expected.some(value => !Number.isFinite(value)) || !actual || actual.length !== 4 || actual.some((value, i) => !Number.isFinite(value) || Math.abs(value - expected[i]!) > .5)) return false
    }
    if ((Number(o.msgU64(window, sel(o, 'isVisible'))) & 0xff) === 0) {
      // Automation runs (`GPUIX_BACKGROUND`) must not take the keyboard.
      if (process.env.GPUIX_BACKGROUND === '1') o.msgSetPtr(window, sel(o, 'orderFront:'), null as unknown as Pointer)
      else {
        o.msgSetBool(nsApp()!, sel(o, 'activateIgnoringOtherApps:'), true)
        o.msgSetPtr(window, sel(o, 'makeKeyAndOrderFront:'), null as unknown as Pointer)
      }
    }
    return true
  } catch {
    return !automationFrame
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

/**
 * Bring this window forward for "Open in a new window" from a sibling window
 * (`windows/registry.ts`): restore it if minimized, then make it key. Automation
 * runs (`GPUIX_BACKGROUND`) only reorder it and never take the keyboard.
 */
export function focusAppWindow(renderer: NativeRenderer) {
  const background = process.env.GPUIX_BACKGROUND === '1'
  if (mac) {
    try {
      const o = getObjc()
      const window = appWindow(o, true)
      if (window) {
        if ((Number(o.msgU64(window, sel(o, 'isMiniaturized'))) & 0xff) !== 0) o.msgSetPtr(window, sel(o, 'deminiaturize:'), null as unknown as Pointer)
        if (background) o.msgSetPtr(window, sel(o, 'orderFront:'), null as unknown as Pointer)
      }
    } catch { /* GPUI's own activation below still runs. */ }
  }
  if (!background) (renderer as { activateWindow?: () => void }).activateWindow?.()
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
/** Size is event-driven; position/appearance retain their existing AppKit read. */
export function startWindowShell(renderer: NativeRenderer) {
  if (started) return
  started = true
  let lastFrame = ''
  const readPlatformState = () => {
    if (!mac) return
    try {
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
      // Reduce transparency / Increase contrast, changed in System Settings while running.
      refreshAccessibilityDisplay()
    } catch { /* Retry the platform-only read on the next tick. */ }
  }
  onWindowResize(renderer, ({ width, height }) => {
    if (process.env.KYBERN_DEBUG_SIZE) console.log('[window-size]', width, height)
    setWindowWidth(width)
    readPlatformState()
  })
  readPlatformState()
  setInterval(readPlatformState, POLL_MS)
}
