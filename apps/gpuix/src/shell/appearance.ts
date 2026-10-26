// The OS appearance, observed live. macOS switches between Light and Dark while
// the app runs; `window.ts` polls `NSApp.effectiveAppearance` and reports here.
// The mode the reader picks (Light / Dark / System) is a Settings preference
// (`settings/appearance.ts`); this module only supplies the two native halves:
//
//   useSystemVariant(VARIANT)          what macOS is showing now (the "System" value)
//   useSyncWindowAppearance(variant)   keep the window's own NSAppearance in step with the theme
//
// The window material (opaque, vibrancy or an adjustable blur) is `shell/windowMaterial.ts`.
//
//   const system = useSystemVariant(VARIANT)
//   const variant = forced ? VARIANT : prefs.theme === 'system' ? system : prefs.theme
//   useSyncWindowAppearance(variant)
//
// The switch cross-fades like the desktop's view transition (`motion/themeFade.tsx`).
import type { Pointer } from 'bun:ffi'
import { useEffect, useSyncExternalStore } from 'react'
import { snapshotBeforeThemeChange } from '../motion/themeFade.tsx'
import { appearance } from '../settings/appearance.ts'
import { cls, cstr, each, getObjc, nsApp, sel } from '../native/objc.ts'

export type Variant = 'dark' | 'light'

/** macOS's current appearance from `NSApp.effectiveAppearance`; null when it cannot be read yet. */
export function readSystemVariant(): Variant | null {
  if (process.platform !== 'darwin') return null
  try {
    const o = getObjc()
    const app = nsApp()
    if (!app) return null
    const appearance = o.msg(app, sel(o, 'effectiveAppearance')) as Pointer
    const name = o.msgCStr(o.msg(appearance, sel(o, 'name')) as Pointer, sel(o, 'UTF8String'))
    return String(name).includes('Dark') ? 'dark' : 'light'
  } catch {
    return null
  }
}

/** What the poll last saw; null until the app exists (`useSystemVariant` falls back to the launch value). */
let system: Variant | null = null
const listeners = new Set<() => void>()

/** `window.ts` calls this when macOS switches between Light and Dark. */
export function setSystemVariant(variant: Variant) {
  if (variant === system) return
  // The reader follows the system: hold the old frame so the change cross-fades (`motion/themeFade.tsx`).
  if (system !== null && appearance().theme === 'system') snapshotBeforeThemeChange()
  system = variant
  listeners.forEach((l) => l())
}

export const getSystemVariant = (): Variant | null => system

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
/** `launch` is the variant read at startup (`VARIANT` in `ui.tsx`), used until the first poll. */
export const useSystemVariant = (launch: Variant): Variant => useSyncExternalStore(subscribe, getSystemVariant) ?? launch

type AppearanceRenderer = { setWindowAppearance?: (appearance: Variant | null) => boolean }
let appearanceRenderer: AppearanceRenderer | null = null
/** The variant the theme asked for before the renderer was registered. */
let pendingVariant: Variant | null = null
/** `window.ts` registers the renderer once the window is up; Windows applies the appearance through it. */
export function setAppearanceRenderer(renderer: object) {
  appearanceRenderer = renderer as AppearanceRenderer
  if (pendingVariant) syncWindowAppearance(pendingVariant)
}

/**
 * Keep even opaque windows' native controls in the selected appearance. On Windows the addon sets DWM dark mode, which
 * also tints Mica and Acrylic, and keeps it when the system theme changes (WP9). Linux has no window appearance to set.
 */
export function syncWindowAppearance(variant: Variant): boolean {
  if (process.platform === 'win32') {
    // The window may not exist yet; an addon without the call has nothing to retry.
    if (!appearanceRenderer) { pendingVariant = variant; return false }
    pendingVariant = null
    try { appearanceRenderer.setWindowAppearance?.(variant) } catch (error) { console.error('[appearance] window appearance:', error) }
    return true
  }
  if (process.platform !== 'darwin') return true
  try {
    const o = getObjc(), app = nsApp()
    if (!app) return false
    const name = o.msgPtrArg(cls(o, 'NSString'), sel(o, 'stringWithUTF8String:'), cstr(variant === 'dark' ? 'NSAppearanceNameDarkAqua' : 'NSAppearanceNameAqua')) as Pointer
    const appearance = o.msgPtrArg(cls(o, 'NSAppearance'), sel(o, 'appearanceNamed:'), name) as Pointer
    let found = false
    each(o, o.msg(app, sel(o, 'windows')) as Pointer, (window) => {
      if (!o.msg(window, sel(o, 'contentView'))) return
      o.msgSetPtr(window, sel(o, 'setAppearance:'), appearance)
      found = true
    })
    return found
  } catch { return true }
}

export function useSyncWindowAppearance(variant: Variant) {
  useEffect(() => {
    let attempts = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const apply = () => {
      // The window may not exist for a few frames after launch.
      if (!syncWindowAppearance(variant) && ++attempts < 40) timer = setTimeout(apply, 50)
    }
    apply()
    return () => clearTimeout(timer)
  }, [variant])
}
