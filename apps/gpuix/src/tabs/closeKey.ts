// ⌘W reaches GPUI as the Window menu's CloseWindow action (bound on the focus path) rather than as a key event, so the
// window's key handlers never see it while anything has focus. The close request is the one place that always runs: when
// AppKit is handling a ⌘W key press (not the title bar's close button), the request closes the active tab instead.
import { getObjc, nsApp, sel, withPool } from '../native/objc.ts'

const KEY_DOWN = 10
const COMMAND = 1 << 20
const SHIFT = 1 << 17
/** NSEventType mouse kinds: left/right down, up, moved, dragged, entered, exited, other down/up/dragged. */
const MOUSE = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 25, 26, 27])

/**
 * `'key'`: the request comes from ⌘W. `'pointer'`: a mouse event (the close button, or Window › Close with the pointer).
 * `'none'`: no key or mouse event (a synthetic keystroke from the automation driver), treated as the keyboard by the caller.
 * Off macOS Ctrl+W is an ordinary key event the window's shortcuts handle (`nav/keys.ts`), so a close request is always the
 * window's own close (the caption button, Alt+F4, the window menu, the taskbar): `'pointer'`. As `'none'` it closed the
 * active document tab instead of the window on Windows.
 */
export function closeRequestSource(platform: NodeJS.Platform = process.platform): 'key' | 'pointer' | 'none' {
  if (platform !== 'darwin') return 'pointer'
  try {
    const o = getObjc(), app = nsApp()
    if (!app) return 'none'
    return withPool(o, () => {
      const event = o.msg(app, sel(o, 'currentEvent'))
      if (!event) return 'none'
      const type = Number(o.msgU64(event, sel(o, 'type')))
      // Mouse events (the close button, Window › Close chosen with the pointer) close the window.
      if (MOUSE.has(type)) return 'pointer'
      if (type !== KEY_DOWN) return 'none'
      const flags = Number(o.msgU64(event, sel(o, 'modifierFlags')))
      const chars = o.msg(event, sel(o, 'charactersIgnoringModifiers'))
      const key = chars ? String(o.msgCStr(chars, sel(o, 'UTF8String')) ?? '') : ''
      return flags & COMMAND && !(flags & SHIFT) && key.toLowerCase() === 'w' ? 'key' : 'pointer'
    })
  } catch {
    return 'none'
  }
}
