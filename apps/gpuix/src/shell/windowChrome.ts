// The window off macOS (WP3), from the addon's `getWindowChrome` / `setWindowChromeCallback` (fork `window_chrome.rs`):
//
// - the title bar's state (`useWindowChrome`): maximized, active, client- or server-side decorations and tiling, the
//   controls the compositor offers and the desktop's button order (Linux);
// - the OS appearance and reduced motion, live: GPUI follows the registry on Windows and the portal's `color-scheme`
//   on Linux (`setSystemVariant`); Windows' "Animation effects" comes with the state, GNOME's `enable-animations`
//   through `gsettings monitor` (`setPlatformReducedMotion`);
// - the frame (size, position, maximized, display; `bounds` in each state), saved as it changes and passed to `render` at the next launch
//   (`savedFrameOptions`), the way `shell/window.ts` restores AppKit's frame string on macOS;
// - the title-bar double click on Linux: GNOME's `action-double-click-titlebar` (Windows does its own).
//
// macOS keeps `shell/window.ts`, `shell/appearance.ts` and the traffic lights: nothing here runs there.
import { useSyncExternalStore } from 'react'
import type { NativeRenderer } from '@gpuix/react'
import { setSystemVariant } from './appearance.ts'
import { load, save } from './persist.ts'
import { setPlatformReducedMotion } from '../platform/material.ts'
import { readTitlebarDoubleClick, watchGnomeSetting } from '../platform/systemPrefs.ts'

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
  /** The frame to save (`getWindowBounds`). */
  bounds: SavedFrame
}
export type WindowButton = 'minimize' | 'maximize' | 'close'
export type ResizeEdge = 'top' | 'top-right' | 'right' | 'bottom-right' | 'bottom' | 'bottom-left' | 'left' | 'top-left'

type ChromeRenderer = {
  getWindowChrome?: () => WindowChrome
  setWindowChromeCallback?: (callback: ((error: Error | null, chrome: WindowChrome) => void) | null) => void
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

let saveTimer: ReturnType<typeof setTimeout> | undefined
let savedFrame = ''
/** Take a new state: the launch read, then each change the addon sends (no waited bridge call per change). */
function apply(next: WindowChrome) {
  const appearance = next.appearance !== chrome?.appearance
  chrome = next
  if (appearance && !process.env.KYBERN_APPEARANCE) setSystemVariant(next.appearance)
  setPlatformReducedMotion(next.reducedMotion)
  for (const listener of [...listeners]) listener()
  const frame = next.bounds
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
    try { native.setTitlebarDoubleClick?.(readTitlebarDoubleClick()) } catch { /* Keep the default (maximize). */ }
    watchGnomeSetting('org.gnome.desktop.wm.preferences', 'action-double-click-titlebar', () => {
      try { native?.setTitlebarDoubleClick?.(readTitlebarDoubleClick()) } catch { /* Window closed. */ }
    })
    watchGnomeSetting('org.gnome.desktop.interface', 'enable-animations', (value) => setPlatformReducedMotion(value === 'false'))
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
