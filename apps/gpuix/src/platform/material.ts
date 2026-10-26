// Window material and the accessibility display options, as on the desktop:
//
// - The window material has three scopes (`platform/translucency.ts`), chosen per theme variant in
//   Settings › Appearance › Window:
//     none     Solid, or an accessibility override: opaque surfaces, an opaque native window;
//     sidebar  "Sidebar only": the frame and the thread panel are glass, the conversation is opaque;
//     window   Translucent: one coat over the whole window, route content clear.
//   `ThemeProvider` resolves the scope (`ui.tsx`); `theme.scope` / `theme.glass` carry it to components, and
//   `shell/windowMaterial.ts` moves the native window (opaque, vibrancy or an adjustable desktop blur).
//   `KYBERN_OPAQUE=1` is the capture mode: scope none from launch.
// - Reduce transparency and Increase contrast (System Settings › Accessibility › Display) force scope none
//   and turn scene backdrops off and, for contrast, give the workspace card a real border (kit.css:146-150,
//   kybern.css:631-660). They win over every slider.
//
// - Reduce motion (`platform/reducedMotion.ts`) switches every motion to its
//   fade or instant path.
//
// The options are read from NSWorkspace on the window shell's existing poll
// (`shell/window.ts`), so a change in System Settings applies while the app
// runs. Off macOS `platform/osDisplay.ts` reads Windows' transparency effects and
// contrast themes, and Linux's high contrast, on the same poll. `KYBERN_REDUCED_TRANSPARENCY` / `KYBERN_INCREASED_CONTRAST` /
// `KYBERN_REDUCED_MOTION` pin them;
// `KYBERN_A11Y_FILE` (JSON) lets checks change them without touching the
// user's system settings.
import type { Pointer } from 'bun:ffi'
import { readFileSync } from 'node:fs'
import { useSyncExternalStore } from 'react'
import { BACKDROP_BLUR } from '../native/local-build.ts'
import { cls, getObjc, sel } from '../native/objc.ts'
import { onOsDisplayChange, readOsDisplay } from './osDisplay.ts'
import { REDUCED_MOTION, setReducedMotion } from './reducedMotion.ts'
import { OPAQUE_WINDOW } from './translucency.ts'

export interface AccessibilityDisplay { reduceTransparency: boolean; increaseContrast: boolean; reduceMotion: boolean }

const pinned = (name: string) => process.env[name] ? process.env[name] === '1' : null

/** Windows and Linux: the system's reduced-motion switch (`shell/windowChrome.ts`); its launch value is `reducedMotion.ts`'s. */
let platformMotion: boolean | null = process.platform === 'darwin' ? null : REDUCED_MOTION
export function setPlatformReducedMotion(value: boolean | null) {
  if (value === null || value === platformMotion) return
  platformMotion = value
  refreshAccessibilityDisplay()
}

function readNative(): AccessibilityDisplay | null {
  // Off macOS: transparency and contrast from `osDisplay.ts` (WP9), reduced motion from the window shell (WP3).
  if (process.platform !== 'darwin') {
    const os = readOsDisplay()
    if (!os && platformMotion === null) return null
    return { reduceTransparency: os?.reduceTransparency ?? false, increaseContrast: os?.increaseContrast ?? false, reduceMotion: platformMotion ?? false }
  }
  try {
    const o = getObjc()
    const workspace = o.msg(cls(o, 'NSWorkspace'), sel(o, 'sharedWorkspace')) as Pointer
    const flag = (name: string) => (Number(o.msgU64(workspace, sel(o, name))) & 0xff) !== 0
    return { reduceTransparency: flag('accessibilityDisplayShouldReduceTransparency'), increaseContrast: flag('accessibilityDisplayShouldIncreaseContrast'), reduceMotion: flag('accessibilityDisplayShouldReduceMotion') }
  } catch { return null }
}

/** The current options; pinned values and the test file win over the system. */
export function readAccessibilityDisplay(): AccessibilityDisplay {
  let source = readNative() ?? { reduceTransparency: false, increaseContrast: false, reduceMotion: false }
  const file = process.env.KYBERN_A11Y_FILE
  if (file) try { source = { ...source, ...JSON.parse(readFileSync(file, 'utf8')) } } catch { /* Missing file: keep the system values. */ }
  return {
    reduceTransparency: pinned('KYBERN_REDUCED_TRANSPARENCY') ?? !!source.reduceTransparency,
    increaseContrast: pinned('KYBERN_INCREASED_CONTRAST') ?? !!source.increaseContrast,
    reduceMotion: pinned('KYBERN_REDUCED_MOTION') ?? !!source.reduceMotion,
  }
}

let display = readAccessibilityDisplay()
setReducedMotion(display.reduceMotion)
const listeners = new Set<() => void>()
export const getAccessibilityDisplay = () => display
/** Called by the window shell's poll; listeners hear only real changes. */
export function refreshAccessibilityDisplay() {
  const next = readAccessibilityDisplay()
  if (next.reduceTransparency === display.reduceTransparency && next.increaseContrast === display.increaseContrast && next.reduceMotion === display.reduceMotion) return
  display = next
  setReducedMotion(next.reduceMotion)
  if (process.env.KYBERN_DEBUG_A11Y) console.log('[a11y]', JSON.stringify(next))
  for (const l of listeners) l()
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
// Linux reads arrive from `gsettings`, not from the poll.
onOsDisplayChange(refreshAccessibilityDisplay)

/**
 * Whether the open window's renderer draws scene backdrops (`backdropFilterSupported`, WP9): off macOS a wgpu surface that
 * cannot be copied from does not, and frosted surfaces then take their dense fills. Read once the window is up
 * (`shell/window.ts`), before the app below the font gate renders.
 */
let windowBackdrop = true
export function readWindowBackdrop(renderer: object) {
  const read = (renderer as { backdropFilterSupported?: () => boolean }).backdropFilterSupported
  let next = true
  try { next = read ? read.call(renderer) !== false : true } catch { next = true }
  if (next === windowBackdrop) return
  windowBackdrop = next
  if (process.env.KYBERN_DEBUG_A11Y) console.log('[backdrop] window renderer draws backdrops:', next)
  // A new snapshot, so the theme re-resolves with backdrops off.
  display = { ...display }
  for (const l of listeners) l()
}
/** Hear about changes outside React (registered first, so it runs before re-renders). */
export const onAccessibilityDisplay = subscribe
export const useAccessibilityDisplay = () => useSyncExternalStore(subscribe, getAccessibilityDisplay)

/** Capture mode: an opaque window with no native material (`translucency.ts`). */
export { OPAQUE_WINDOW }
/** Scene backdrops (blurred popovers, drop labels) are allowed right now, and this OS's renderer and window draw them (`BACKDROP_BLUR`, `readWindowBackdrop`). */
export const backdropAllowed = () => BACKDROP_BLUR && windowBackdrop && !OPAQUE_WINDOW && !display.reduceTransparency && !display.increaseContrast
