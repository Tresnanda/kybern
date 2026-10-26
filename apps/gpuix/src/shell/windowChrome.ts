// The window off macOS (WP3), from the addon's `getWindowChrome` / `setWindowChromeCallback` (fork `window_chrome.rs`):
//
// - the title bar's state (`useWindowChrome`): maximized, active, client- or server-side decorations and tiling, the
//   controls the compositor offers and the desktop's button order (Linux);
// - the OS appearance and reduced motion, live: GPUI follows the registry on Windows and the portal's `color-scheme`
//   on Linux (`setSystemVariant`; on Linux not the first report, see `takesAppearance`); Windows' "Animation effects"
//   comes with the state, GNOME's `enable-animations` through `gsettings monitor` (`setPlatformReducedMotion`);
// - the frame (size, position, maximized, display; `bounds` in each report), saved as it changes and passed to `render`
//   at the next launch (`savedFrameOptions`), the way `shell/window.ts` restores AppKit's frame string on macOS. Bounds
//   are not part of the React snapshot: a move or resize step that changes only them re-renders nothing;
// - the title-bar double click on Linux: GNOME's `action-double-click-titlebar` (Windows does its own).
//
// macOS keeps `shell/window.ts`, `shell/appearance.ts` and the traffic lights: nothing here runs there.
import { useSyncExternalStore } from 'react'
import type { NativeRenderer } from '@gpuix/react'
import { setSystemVariant } from './appearance.ts'
import { load, save } from './persist.ts'
import { setPlatformReducedMotion } from '../platform/material.ts'
import { parseTitlebarDoubleClick, readSystemVariant, readTitlebarDoubleClick, watchGsettings } from '../platform/systemPrefs.ts'

export interface WindowChrome {
  platform: 'macos' | 'windows' | 'linux'
  decorations: 'server' | 'client'
  tiling: { top: boolean; left: boolean; right: boolean; bottom: boolean } | null
  maximized: boolean
  fullscreen: boolean
  active: boolean
  resizable: boolean
  minimizable: boolean
  controls: { minimize: boolean; maximize: boolean; fullscreen: boolean; windowMenu: boolean }
  buttonLayout: { left: WindowButton[]; right: WindowButton[] } | null
  appearance: 'light' | 'dark'
  reducedMotion: boolean | null
}
/** What the addon reports: the state and the frame to save (`getWindowBounds`). */
export type WindowChromeReport = WindowChrome & { bounds?: SavedFrame }
export type WindowButton = 'minimize' | 'maximize' | 'close'
export type ResizeEdge = 'top' | 'top-right' | 'right' | 'bottom-right' | 'bottom' | 'bottom-left' | 'left' | 'top-left'

type ChromeRenderer = {
  getWindowChrome?: () => WindowChromeReport
  setWindowChromeCallback?: (callback: ((error: Error | null, chrome: WindowChromeReport) => void) | null) => void
  startWindowResize?: (edge: ResizeEdge) => void
  showWindowMenu?: (x: number, y: number) => void
  setTitlebarDoubleClick?: (action: string) => void
  minimizeWindow?: () => void
  zoomWindow?: () => void
  closeWindow?: () => void
}

interface SavedFrame { state: 'windowed' | 'maximized' | 'fullscreen'; x: number; y: number; width: number; height: number; display: string | null }

const FRAME_KEY = 'kybern.window.frame.native'
const OFF_MAC = process.platform !== 'darwin'
/** Automated runs never restore or save the user's frame (as on macOS, `shell/window.ts`). */
const automated = process.env.GPUIX_BACKGROUND === '1'

let native: ChromeRenderer | null = null
let chrome: WindowChrome | null = null
const listeners = new Set<() => void>()

/** The last state the addon reported; null on macOS, before the window is up, or with an addon without `getWindowChrome`. */
export const getWindowChrome = () => chrome
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const useWindowChrome = (): WindowChrome | null => useSyncExternalStore(subscribe, getWindowChrome)

/**
 * Whether a reported appearance becomes the system variant. A change always does. The first report does except on
 * Linux when the launch read found a theme: GPUI follows only the portal's `color-scheme`, which reads light when the
 * portal states no preference (XFCE, MATE, Cinnamon), while the launch read also knows GNOME's `color-scheme` and the
 * GTK theme's name (`Adwaita-dark`); the first frame must not flip dark → light.
 */
export function takesAppearance(platform: NodeJS.Platform, previous: WindowChrome['appearance'] | null, next: WindowChrome['appearance'], launchKnown: boolean): boolean {
  if (previous === null) return !(platform === 'linux' && launchKnown)
  return next !== previous
}

/** The snapshot fields compared for a change (everything React reads; `bounds` is not). */
export const sameChrome = (a: WindowChrome | null, b: WindowChrome) => !!a && a.platform === b.platform && a.decorations === b.decorations && a.maximized === b.maximized
  && a.fullscreen === b.fullscreen && a.active === b.active && a.resizable === b.resizable && a.minimizable === b.minimizable
  && a.appearance === b.appearance && a.reducedMotion === b.reducedMotion && JSON.stringify([a.tiling, a.controls, a.buttonLayout]) === JSON.stringify([b.tiling, b.controls, b.buttonLayout])

let saveTimer: ReturnType<typeof setTimeout> | undefined
let savedFrame = ''
/** The appearance in the last report (null before the first), apart from the snapshot's. */
let reported: WindowChrome['appearance'] | null = null
/** Take a new report: the launch read, then each change the addon sends (no waited bridge call per change). */
function apply(report: WindowChromeReport) {
  const { bounds: frame, ...next } = report
  if (!process.env.KYBERN_APPEARANCE && takesAppearance(process.platform, reported, next.appearance, reported === null && readSystemVariant() !== null)) setSystemVariant(next.appearance)
  reported = next.appearance
  // A move or resize step changes only the bounds: the title bar, controls and edges keep their snapshot.
  if (!sameChrome(chrome, next)) {
    chrome = next
    setPlatformReducedMotion(next.reducedMotion)
    for (const listener of [...listeners]) listener()
  }
  if (!automated && frame && frame.state !== 'fullscreen' && frame.width > 0 && frame.height > 0 && JSON.stringify(frame) !== savedFrame) {
    savedFrame = JSON.stringify(frame)
    // Bounds change on every step of a drag; write once it rests.
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => save(FRAME_KEY, frame), 500)
  }
}

/** Start following the window. Off macOS only; a no-op with an addon that predates WP3. */
export function startWindowChrome(renderer: NativeRenderer) {
  if (!OFF_MAC || native) return
  native = renderer as unknown as ChromeRenderer
  if (!native.getWindowChrome) return
  try { apply(native.getWindowChrome()) } catch { return }
  try { native.setWindowChromeCallback?.((error, next) => { if (!error && next) apply(next) }) } catch { /* Older addon: state stays at the launch read. */ }
  if (process.platform === 'linux') {
    const doubleClick = (action: string) => { try { native?.setTitlebarDoubleClick?.(action) } catch { /* Window closed. */ } }
    // Until the read answers, the addon keeps its default (maximize).
    readTitlebarDoubleClick(doubleClick)
    watchGsettings('org.gnome.desktop.wm.preferences', ['action-double-click-titlebar'], (_key, value) => doubleClick(parseTitlebarDoubleClick(value)))
    watchGsettings('org.gnome.desktop.interface', ['enable-animations'], (_key, value) => setPlatformReducedMotion(value === 'false'))
  }
}

/** Window options for `render` that reopen the saved frame (Windows and Linux). Size never goes below the minimum. */
export function savedFrameOptions(min: { width: number; height: number }): { width?: number; height?: number; x?: number; y?: number; maximized?: boolean; display?: string } {
  if (!OFF_MAC || automated) return {}
  const frame = load<SavedFrame | null>(FRAME_KEY, null)
  if (!frame || ![frame.x, frame.y, frame.width, frame.height].every(Number.isFinite)) return {}
  return {
    width: Math.max(min.width, Math.round(frame.width)),
    height: Math.max(min.height, Math.round(frame.height)),
    x: Math.round(frame.x),
    y: Math.round(frame.y),
    ...(frame.state === 'maximized' ? { maximized: true } : {}),
    ...(frame.display ? { display: frame.display } : {}),
  }
}

/** What the caption buttons do where the platform does not act on them itself (Linux; Windows handles its hit test). */
export const windowActions = {
  minimize: () => native?.minimizeWindow?.(),
  toggleMaximize: () => native?.zoomWindow?.(),
  // Through the close guard, as the platform's close button would.
  close: () => native?.closeWindow?.(),
  resize: (edge: ResizeEdge) => native?.startWindowResize?.(edge),
  menu: (x: number, y: number) => native?.showWindowMenu?.(x, y),
}
