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
// Position, appearance and accessibility display are re-read when AppKit
// reports a window-state change (`native/windowState.ts`); an addon without
// that callback polls them every 900 ms. Window size is never polled.
// Every failure falls back to GPUI's default (the window just keeps its size).
import { dlopen, FFIType, type Pointer } from 'bun:ffi'
import { readFileSync } from 'node:fs'
import type { NativeRenderer } from '@gpuix/react'
import { cls, cstr, each, getObjc, nsApp, sel, withPool, type Objc } from '../native/objc.ts'
import { onWindowResize } from '../native/layout.ts'
import { hasWindowStateEvents, installWindowState, onWindowStateChange } from '../native/windowState.ts'
import { readSystemVariant, setSystemVariant } from './appearance.ts'
import { setWindowWidth } from './layout.ts'
import { load, save } from './persist.ts'
import { refreshAccessibilityDisplay } from '../platform/material.ts'
import { installIdleMemory } from '../platform/idleMemory.ts'

const FRAME_KEY = 'kybern.window.frame'
const POLL_MS = 900
/** Automated runs (`GPUIX_BACKGROUND=1`) open hidden, then show on the hidden test display (id in
 *  `/tmp/kybern-gpuix-test-display`) or else the Mac's built-in display (or at
 *  `KYBERN_AUTOMATION_WINDOW_FRAME`), never where the user works: GPUI centers new windows on the
 *  focused screen. They never restore or save the user's frame. `KYBERN_TEST_DISPLAY=any` opts out. */
const automated = process.env.GPUIX_BACKGROUND === '1' && process.env.KYBERN_TEST_DISPLAY !== 'any'
const savedFrame = () => (automated ? 'automation' : load<string | null>(FRAME_KEY, null))

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
  if (!savedFrame()) return true
  try {
    const o = getObjc()
    const window = appWindow(o, true)
    if (!window) return false
    const saved = automated ? process.env.KYBERN_AUTOMATION_WINDOW_FRAME : load<string | null>(FRAME_KEY, null)
    if (saved) o.msgSetPtr(window, sel(o, 'setFrameFromString:'), nsString(o, saved))
    else if (automated) {
      // A frame string is snapped back onto the main screen, so the test display is set by origin.
      const origin = automationOrigin(o, window)
      if (origin) setFrameOrigin(window, sel(o, 'setFrameOrigin:'), origin[0], origin[1])
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
    return true
  }
}

type Rect = [number, number, number, number]
/** An NSRect through KVC boxing (`valueForKey:` → NSValue description), so no struct FFI. */
function rectOf(o: Objc, object: Pointer, key: string): Rect | null {
  const boxed = o.msgPtrArg(object, sel(o, 'valueForKey:'), nsString(o, key)) as Pointer | null
  const text = boxed ? String(o.msgCStr(o.msg(boxed, sel(o, 'description')) as Pointer, sel(o, 'UTF8String')) ?? '') : ''
  const n = text.match(/-?\d+(?:\.\d+)?/g)?.map(Number)
  return n && n.length >= 4 ? [n[0]!, n[1]!, n[2]!, n[3]!] : null
}

let setFrameOrigin: (window: Pointer, selector: Pointer, x: number, y: number) => void = (window, selector, x, y) => {
  // NSPoint is two doubles, passed in floating-point registers like two plain arguments.
  const { symbols } = dlopen('/usr/lib/libobjc.A.dylib', { objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.f64, FFIType.f64], returns: FFIType.void } })
  setFrameOrigin = (w, s, px, py) => symbols.objc_msgSend(w, s, px, py)
  setFrameOrigin(window, selector, x, y)
}

/** The bottom-left origin centering `window` (at its current size) on the test display, else the
 *  built-in display; null without either. */
function automationOrigin(o: Objc, window: Pointer): [number, number] | null {
  const { symbols } = dlopen('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics', { CGDisplayIsBuiltin: { args: [FFIType.u32], returns: FFIType.bool } })
  let test: number | null = null
  try { test = Number(readFileSync('/tmp/kybern-gpuix-test-display', 'utf8').trim()) || null } catch { /* No test display. */ }
  const screens: Array<{ screen: Pointer; id: number }> = []
  each(o, o.msg(cls(o, 'NSScreen')!, sel(o, 'screens')) as Pointer, (screen) => {
    const info = o.msg(screen, sel(o, 'deviceDescription')) as Pointer | null
    const number = info && (o.msgPtrArg(info, sel(o, 'objectForKey:'), nsString(o, 'NSScreenNumber')) as Pointer | null)
    if (number) screens.push({ screen, id: Number(o.msgU64(number, sel(o, 'unsignedIntValue'))) })
  })
  const target = screens.find((s) => s.id === test) ?? screens.find((s) => symbols.CGDisplayIsBuiltin(s.id))
  const size = rectOf(o, window, 'frame')
  const visible = target && size ? rectOf(o, target.screen, 'visibleFrame') : null
  if (!visible || !size) return null
  const [, , w, h] = size, [vx, vy, vw, vh] = visible
  return [Math.round(vx + Math.max(0, vw - w) / 2), Math.round(vy + Math.max(0, vh - h) / 2)]
}

/** Retry until GPUI has opened its window (a few frames after `render`). */
export function installWindowFrame() {
  if (frameReady) return
  let tries = 0
  const tick = () => {
    // Automated runs start on a busy machine; a window that opens hidden must still appear.
    if (restoreWindowFrame() || ++tries > (automated ? 400 : 40)) {
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
    return withPool(o, () => {
      const window = appWindow(o)
      return window ? (Number(o.msgU64(window, sel(o, 'isKeyWindow'))) & 0xff) !== 0 : true
    })
  } catch {
    return true
  }
}

let started = false
/** Size, position, appearance and accessibility display are event-driven. */
export function startWindowShell(renderer: NativeRenderer) {
  if (started) return
  started = true
  let lastFrame = ''
  const readPlatformState = () => {
    if (!mac) return
    try {
      const o = getObjc()
      withPool(o, () => {
        const window = appWindow(o)
        if (!window) return
        const frame = readFrame(o, window)
        if (frameReady && !automated && frame && frame !== lastFrame) {
          lastFrame = frame
          save(FRAME_KEY, frame)
        }
        const variant = readSystemVariant()
        if (variant) setSystemVariant(variant)
        // Reduce transparency / Increase contrast, changed in System Settings while running.
        refreshAccessibilityDisplay()
      })
    } catch { /* Retry the platform-only read on the next tick. */ }
  }
  onWindowResize(renderer, ({ width, height }) => {
    if (process.env.KYBERN_DEBUG_SIZE) console.log('[window-size]', width, height)
    setWindowWidth(width)
    readPlatformState()
  })
  installWindowState(renderer)
  readPlatformState()
  if (hasWindowStateEvents()) onWindowStateChange(readPlatformState)
  else setInterval(readPlatformState, POLL_MS)
  // Checks drive the options through a file (`KYBERN_A11Y_FILE`), which raises no AppKit event.
  if (process.env.KYBERN_A11Y_FILE) setInterval(refreshAccessibilityDisplay, 250)
  installIdleMemory(renderer, isWindowFocused)
}
