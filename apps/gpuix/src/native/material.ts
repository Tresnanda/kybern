// Window material parity with the desktop's macOS vibrancy.
//
// Tauri gives the window an `NSVisualEffectView` with the UnderWindowBackground
// material: the tinted, saturated glass macOS uses behind sidebars. The desktop
// paints its frame at 88% over that glass.
//
// GPUI's `windowBackground: 'blurred'` adds its own `NSVisualEffectView`
// subclass (`BlurredView`) with the Selection material and, on every layer
// update, hides the material's tint layer (`CAChameleonLayer`) and strips its
// saturation filter. What shows through the 12% is then a colourless blur of
// the wallpaper, which reads as a different, lighter surface.
//
// GPUIX 0.10.0 exposes no material option, so this reaches the window through
// the Objective-C runtime (Bun FFI) once it exists:
//   1. restore `NSVisualEffectView`'s own `updateLayer` on `BlurredView`, so the
//      tint and saturation stay;
//   2. switch the material to UnderWindowBackground;
//   3. give the window the app's appearance (Aqua / DarkAqua), so the material
//      follows the app theme rather than the system one, like Tauri's setTheme.
// Everything is best effort: on any failure the window keeps GPUI's blur.
import type { Pointer } from 'bun:ffi'
import { className, cls, cstr, each, getObjc, sel, type Objc } from './objc.ts'

const NS_VISUAL_EFFECT_MATERIAL_UNDER_WINDOW_BACKGROUND = 21

/** Show the tint layers GPUI hid (they are not recreated on their own). */
function unhideTint(o: Objc, layer: Pointer | null, depth = 0) {
  if (!layer || depth > 6) return
  if (className(o, layer) === 'CAChameleonLayer') o.msgSetBool(layer, sel(o, 'setHidden:'), false)
  each(o, o.msg(layer, sel(o, 'sublayers')) as Pointer | null, (child) => unhideTint(o, child, depth + 1))
}

/** Debug readback: material, tint layer visibility and filters, after AppKit relayers. */
function describe(o: Objc, view: Pointer, delay = 500) {
  setTimeout(() => {
    const material = Number(o.msgU64(view, sel(o, 'material')))
    const found: string[] = []
    const walk = (layer: Pointer | null, depth: number) => {
      if (!layer || depth > 6) return
      const name = className(o, layer)
      const hidden = Number(o.msgU64(layer, sel(o, 'isHidden'))) & 0xff
      const filters = o.msg(layer, sel(o, 'filters')) as Pointer | null
      const nf = filters ? Number(o.msgU64(filters, sel(o, 'count'))) : 0
      if (name === 'CAChameleonLayer' || nf > 0) found.push(`${name}${hidden ? ' (hidden)' : ''}${nf ? ` filters=${nf}` : ''}`)
      each(o, o.msg(layer, sel(o, 'sublayers')) as Pointer | null, (c) => walk(c, depth + 1))
    }
    walk(o.msg(view, sel(o, 'layer')) as Pointer | null, 0)
    console.log(`[material] material=${material}`, found.join(', ') || 'no tint/filter layers')
  }, delay)
}

/** Debug: print the current material state of every GPUI blur view without changing it. */
export function describeMaterial() {
  const o = getObjc()
  const app = o.msg(cls(o, 'NSApplication'), sel(o, 'sharedApplication')) as Pointer
  each(o, o.msg(app, sel(o, 'windows')) as Pointer, (w) => {
    const content = o.msg(w, sel(o, 'contentView')) as Pointer | null
    if (content) each(o, o.msg(content, sel(o, 'subviews')) as Pointer, (v) => { if (className(o, v) === 'BlurredView') describe(o, v, 0) })
  })
}

/** Apply the desktop's vibrancy to every window that has GPUI's blur view. Returns true once applied. */
export function applyDesktopMaterial(appearance: 'dark' | 'light'): boolean {
  if (process.platform !== 'darwin') return true
  try {
    const o = getObjc()
    const blurred = cls(o, 'BlurredView')
    const effect = cls(o, 'NSVisualEffectView')
    if (!blurred || !effect) return false
    // 1. Stop GPUI's override from stripping the tint and saturation again.
    const stock = o.rt.class_getMethodImplementation(effect, sel(o, 'updateLayer'))
    if (stock) o.rt.class_replaceMethod(blurred, sel(o, 'updateLayer'), stock, cstr('v@:'))

    const app = o.msg(cls(o, 'NSApplication'), sel(o, 'sharedApplication')) as Pointer
    const named = o.msgPtrArg(
      cls(o, 'NSAppearance'),
      sel(o, 'appearanceNamed:'),
      o.msgPtrArg(cls(o, 'NSString'), sel(o, 'stringWithUTF8String:'), cstr(appearance === 'dark' ? 'NSAppearanceNameDarkAqua' : 'NSAppearanceNameAqua')),
    ) as Pointer
    let applied = false
    each(o, o.msg(app, sel(o, 'windows')) as Pointer, (window) => {
      const content = o.msg(window, sel(o, 'contentView')) as Pointer | null
      if (!content) return
      each(o, o.msg(content, sel(o, 'subviews')) as Pointer, (view) => {
        if (className(o, view) !== 'BlurredView') return
        // 3. The material resolves against the window's appearance.
        if (named) o.msgSetPtr(window, sel(o, 'setAppearance:'), named)
        // 2. The desktop's material, then let AppKit rebuild its layers.
        o.msgSetI64(view, sel(o, 'setMaterial:'), BigInt(NS_VISUAL_EFFECT_MATERIAL_UNDER_WINDOW_BACKGROUND))
        o.msgSetBool(view, sel(o, 'setNeedsDisplay:'), true)
        unhideTint(o, o.msg(view, sel(o, 'layer')) as Pointer | null)
        if (process.env.KYBERN_DEBUG_MATERIAL) describe(o, view)
        applied = true
      })
    })
    return applied
  } catch (error) {
    console.error('[material] keeping GPUI blur:', error)
    return true
  }
}
