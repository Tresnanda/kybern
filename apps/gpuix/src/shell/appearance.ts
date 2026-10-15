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
import { getObjc, nsApp, sel } from '../native/objc.ts'

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

let applied: Variant | null = null
/**
 * Give the window the app's appearance and re-apply the desktop vibrancy
 * material (it resolves against the window's appearance). The first call only
 * records the variant: `main.tsx` installs the material at launch.
 */
export function useSyncWindowAppearance(variant: Variant, enabled = true) {
  useEffect(() => {
    const first = applied === null
    const changed = applied !== variant
    applied = variant
    if (first || !changed || !enabled || process.env.KYBERN_OPAQUE === '1') return
    applyDesktopMaterial(variant)
  }, [variant, enabled])
}
