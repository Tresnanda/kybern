// The OS appearance, observed live. macOS switches between Light and Dark while
// the app runs; `window.ts` polls `NSApp.effectiveAppearance` and reports here.
// The mode the reader picks (Light / Dark / System) is a Settings preference
// (`settings/appearance.ts`); this module only supplies the two native halves:
//
//   useSystemVariant(VARIANT)               what macOS is showing now (the "System" value)
//   useSyncWindowAppearance(variant, on)    keep the window's own appearance and the
//                                           vibrancy material in step with the theme
//
// Hook-in (`ui.tsx` `ThemeProvider`): replace the launch-time `VARIANT` with
// `useSystemVariant()`, and call `useSyncWindowAppearance(variant, translucent)`
// with the resolved variant:
//
//   const system = useSystemVariant(VARIANT)
//   const variant = forced ? VARIANT : prefs.theme === 'system' ? system : prefs.theme
//   useSyncWindowAppearance(variant, prefs.translucent)
//
// There is no cross-fade: GPUIX paints one scene per frame and cannot hold the
// old one under the new, so the switch is instant, like most macOS apps.
import type { Pointer } from 'bun:ffi'
import { useEffect, useSyncExternalStore } from 'react'
import { applyDesktopMaterial } from '../native/material.ts'
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

/** Keep even opaque windows' native controls in the selected appearance. */
export function syncWindowAppearance(variant: Variant): boolean {
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

let materialInstalledFor: Variant | null = null
export function useSyncWindowAppearance(variant: Variant, enabled = true) {
  useEffect(() => {
    const first = materialInstalledFor === null
    materialInstalledFor = variant
    // main.tsx already installs the launch material; avoid redundant native
    // appearance and material work during the first scene.
    if (first && enabled && process.env.KYBERN_OPAQUE !== '1') return
    let attempts = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const apply = () => {
      const ready = syncWindowAppearance(variant)
      if (enabled && process.env.KYBERN_OPAQUE !== '1') applyDesktopMaterial(variant)
      if (!ready && ++attempts < 40) timer = setTimeout(apply, 50)
    }
    apply()
    return () => clearTimeout(timer)
  }, [variant, enabled])
}
