// Window material and the accessibility display options, as on the desktop:
//
// - The window always has the native under-window vibrancy (desktop #39: the
//   frame and sidebar are translucent in every mode). `KYBERN_OPAQUE=1` is the
//   capture mode that paints an opaque window instead.
// - "Use translucent surfaces" turns on full translucency: the content
//   surfaces become glass over that material (kybern.css:580-616). It switches
//   live, through the theme, with no relaunch.
// - Reduce transparency and Increase contrast (System Settings › Accessibility
//   › Display) turn full translucency and scene backdrops off and, for
//   contrast, give the workspace card a real border (kit.css:146-150,
//   kybern.css:631-660). AppKit already renders the native material opaque
//   under Reduce transparency, like the desktop's NSVisualEffectView.
//
// The options are read from NSWorkspace on the window shell's existing poll
// (`shell/window.ts`), so a change in System Settings applies while the app
// runs. `KYBERN_REDUCED_TRANSPARENCY` / `KYBERN_INCREASED_CONTRAST` pin them;
// `KYBERN_A11Y_FILE` (JSON) lets checks change them without touching the
// user's system settings.
import type { Pointer } from 'bun:ffi'
import { readFileSync } from 'node:fs'
import { useSyncExternalStore } from 'react'
import { cls, getObjc, sel } from '../native/objc.ts'
import { useAppearance } from '../settings/appearance.ts'

export interface AccessibilityDisplay { reduceTransparency: boolean; increaseContrast: boolean }

const pinned = (name: string) => process.env[name] ? process.env[name] === '1' : null

function readNative(): AccessibilityDisplay | null {
  if (process.platform !== 'darwin') return null
  try {
    const o = getObjc()
    const workspace = o.msg(cls(o, 'NSWorkspace'), sel(o, 'sharedWorkspace')) as Pointer
    const flag = (name: string) => (Number(o.msgU64(workspace, sel(o, name))) & 0xff) !== 0
    return { reduceTransparency: flag('accessibilityDisplayShouldReduceTransparency'), increaseContrast: flag('accessibilityDisplayShouldIncreaseContrast') }
  } catch { return null }
}

/** The current options; pinned values and the test file win over the system. */
export function readAccessibilityDisplay(): AccessibilityDisplay {
  let source = readNative() ?? { reduceTransparency: false, increaseContrast: false }
  const file = process.env.KYBERN_A11Y_FILE
  if (file) try { source = { ...source, ...JSON.parse(readFileSync(file, 'utf8')) } } catch { /* Missing file: keep the system values. */ }
  return {
    reduceTransparency: pinned('KYBERN_REDUCED_TRANSPARENCY') ?? !!source.reduceTransparency,
    increaseContrast: pinned('KYBERN_INCREASED_CONTRAST') ?? !!source.increaseContrast,
  }
}

let display = readAccessibilityDisplay()
const listeners = new Set<() => void>()
export const getAccessibilityDisplay = () => display
/** Called by the window shell's poll; listeners hear only real changes. */
export function refreshAccessibilityDisplay() {
  const next = readAccessibilityDisplay()
  if (next.reduceTransparency === display.reduceTransparency && next.increaseContrast === display.increaseContrast) return
  display = next
  if (process.env.KYBERN_DEBUG_A11Y) console.log('[a11y]', JSON.stringify(next))
  for (const l of listeners) l()
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
/** Hear about changes outside React (registered first, so it runs before re-renders). */
export const onAccessibilityDisplay = subscribe
export const useAccessibilityDisplay = () => useSyncExternalStore(subscribe, getAccessibilityDisplay)

/** Capture mode: an opaque window with no native material. */
export const OPAQUE_WINDOW = process.env.KYBERN_OPAQUE === '1'
/** Scene backdrops (blurred popovers, drop labels) are allowed right now. */
export const backdropAllowed = () => !OPAQUE_WINDOW && !display.reduceTransparency && !display.increaseContrast
/** Full translucency for given preferences: the switch is on and nothing in Accessibility overrides it. */
export const fullTranslucency = (translucent: boolean, a11y = display) => translucent && !OPAQUE_WINDOW && !a11y.reduceTransparency && !a11y.increaseContrast
export function useFullTranslucency(): boolean {
  const translucent = useAppearance().translucent
  return fullTranslucency(translucent, useAccessibilityDisplay())
}

/**
 * Full translucency, verbatim from kybern.css:580-616 (`html[data-full-translucency]
 * [data-window-material="translucent"]`). Applied over the theme's own
 * variables; every `--app-opaque-*` source is already in them.
 */
export const FULL_TRANSLUCENCY: Record<string, string> = {
  '--app-glass-panel-opacity': '58%',
  '--app-glass-popup-opacity': '78%',
  '--app-glass-control-opacity': '40%',
  '--app-glass-surface': 'color-mix(in srgb, var(--app-opaque-content-surface) 72%, transparent)',
  '--app-glass-popup-surface': 'color-mix(in srgb, var(--app-opaque-popover) 78%, transparent)',
  '--color-background-surface': 'var(--app-glass-surface)',
  '--app-settings-surface': 'var(--app-glass-surface)',
  '--background': 'color-mix(in srgb, var(--app-opaque-background) 40%, transparent)',
  '--card': 'color-mix(in srgb, var(--app-opaque-card) 58%, transparent)',
  '--popover': 'var(--app-glass-popup-surface)',
  '--input': 'color-mix(in srgb, var(--app-opaque-input) 40%, transparent)',
  '--muted': 'color-mix(in srgb, var(--app-opaque-muted) 40%, transparent)',
  '--secondary': 'color-mix(in srgb, var(--app-opaque-secondary) 40%, transparent)',
  '--color-background-panel': 'color-mix(in srgb, var(--app-opaque-color-background-panel) 58%, transparent)',
  '--color-background-control': 'color-mix(in srgb, var(--app-opaque-color-background-control) 40%, transparent)',
  '--color-background-control-opaque': 'color-mix(in srgb, var(--app-opaque-color-background-control-opaque) 40%, transparent)',
  '--color-background-elevated-primary': 'color-mix(in srgb, var(--app-opaque-color-background-elevated-primary) 78%, transparent)',
  '--color-background-elevated-primary-opaque': 'color-mix(in srgb, var(--app-opaque-color-background-elevated-primary-opaque) 78%, transparent)',
  '--color-background-elevated-secondary': 'color-mix(in srgb, var(--app-opaque-color-background-elevated-secondary) 40%, transparent)',
  '--app-chat-code-surface': 'var(--color-background-control-opaque)',
  '--app-user-message-background': 'var(--color-background-control-opaque)',
  '--app-composer-picker-surface': 'var(--app-glass-popup-surface)',
  '--app-composer-command-surface': 'color-mix(in srgb, var(--app-opaque-popover) 94%, transparent)',
  '--composer-surface': 'var(--color-background-control-opaque)',
  '--composer-glass-surface': 'var(--app-opaque-popover)',
}
