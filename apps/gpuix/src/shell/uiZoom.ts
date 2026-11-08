// Interface size (#292): the whole window zooms like a browser page. Text, icons, padding, images and hit areas all
// scale and the layout reflows, because GPUI renders the window at the display scale times the zoom in a viewport of
// its content size divided by it (`Window::set_ui_zoom`, through the addon's `setUiZoom`). Nothing here scales px.
//
//   ⌘= (⌘+) / ⌘− / ⌘0     zoom in, out, actual size (Ctrl off macOS; `nav/keys.ts`), View menu items on macOS
//   Settings → Appearance  the Interface size row
//
// One value for the device (`platform/prefs.ts`, never synced), shared by every window: a window picks up another
// window's change when it becomes active. The minimum window size grows with the zoom (900×600 × zoom, in OS points),
// and a step whose minimum would not fit the window's display is unavailable: the shortcuts skip it, Settings disables
// it, and a saved zoom that does not fit opens at the largest one that does (the saved value is kept). Saved window
// frames stay in OS coordinates.
import { useSyncExternalStore } from 'react'
import { readPref, reloadPrefs, writePref } from '../platform/prefs.ts'
import { isPrimaryChord, type KeyMods } from '../platform/keys.ts'

export const UI_ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const
/** The window's minimum content size at 100 %, in OS points (`main.tsx`). */
export const BASE_MIN_SIZE = { width: 900, height: 600 } as const
const PREF = 'ui.zoom'

/** The addon's `getUiZoom` / `setUiZoom` answer. */
export type UiZoomReport = { zoom: number; scale: number; displayWidth: number | null; displayHeight: number | null }
export type Display = { width: number; height: number } | null
type ZoomRenderer = {
  setUiZoom?: (zoom: number, minWidth?: number, minHeight?: number) => UiZoomReport
  getUiZoom?: () => UiZoomReport
  setMenuCommandCallback?: (callback: ((error: Error | null, command?: string | null) => void) | null) => void
  setZoomMenuState?: (zoomIn: boolean, zoomOut: boolean, actualSize: boolean) => void
  setTrafficLightPosition?: (x: number, y: number) => void
}

/**
 * macOS: the traffic lights keep their native size, so they move to stay centred on the zoomed title bar's midline
 * (`nav/TitleBar.tsx` `TITLEBAR` 46 / 2), and the room the title bar leaves them (`nav/WindowControls.tsx`) is their
 * fixed width in OS points over the zoom.
 */
export const TRAFFIC_LIGHTS = { x: 16, y: 16, end: 82, midline: 23 } as const
export const trafficLightY = (zoom: number) => TRAFFIC_LIGHTS.y + TRAFFIC_LIGHTS.midline * (zoom - 1)

/** The step nearest `value` (a saved value from an older build, or a hand-edited file). */
export function snapToStep(value: unknown): number {
  const zoom = typeof value === 'number' && Number.isFinite(value) ? value : 1
  return UI_ZOOM_STEPS.reduce((best, step) => (Math.abs(step - zoom) < Math.abs(best - zoom) ? step : best), 1)
}

/** The minimum window content size at `zoom`, in OS points. */
export const minWindowSize = (zoom: number) => ({ width: Math.round(BASE_MIN_SIZE.width * zoom), height: Math.round(BASE_MIN_SIZE.height * zoom) })

/** Whether a window at `zoom` still fits `display` (its visible area in OS points). Unknown displays fit everything. */
export function stepFits(zoom: number, display: Display): boolean {
  if (!display || !(display.width > 0) || !(display.height > 0)) return true
  const min = minWindowSize(zoom)
  return min.width <= display.width && min.height <= display.height
}

/** The steps a window on `display` can use. 100 % and smaller always can. */
export const availableSteps = (display: Display): number[] => UI_ZOOM_STEPS.filter((step) => step <= 1 || stepFits(step, display))

/** The step after `current` in `direction` that fits, or null at the end. */
export function nextStep(current: number, direction: 1 | -1, display: Display): number | null {
  const steps = availableSteps(display)
  const next = direction > 0 ? steps.find((step) => step > current + 1e-6) : [...steps].reverse().find((step) => step < current - 1e-6)
  return next ?? null
}

/** The largest available step not above `wanted` (a saved zoom on a display too small for it). */
export function fittingZoom(wanted: number, display: Display): number {
  const steps = availableSteps(display)
  return [...steps].reverse().find((step) => step <= wanted + 1e-6) ?? 1
}

/** `110%`. */
export const formatZoom = (zoom: number) => `${Math.round(zoom * 100)}%`

/** The saved interface zoom (100 % when unset). */
export const savedUiZoom = () => snapToStep(readPref<unknown>(PREF, 1))

type State = { zoom: number; display: Display }
let state: State = { zoom: savedUiZoom(), display: null }
let native: ZoomRenderer | null = null
const listeners = new Set<() => void>()
/** `limit`: a zoom in that could not go further because a larger size does not fit the display. */
export type ZoomAnnouncement = { zoom: number; limit: boolean }
const announcers = new Set<(announcement: ZoomAnnouncement) => void>()

export const getUiZoom = () => state.zoom
export const getUiZoomState = (): Readonly<State> => state
export function subscribeUiZoom(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
/** The zoom and the display, for Settings and the menus. */
export const useUiZoom = (): Readonly<State> => useSyncExternalStore(subscribeUiZoom, getUiZoomState)

/** Hear each zoom a shortcut or menu item applies (the transient readout, `ZoomPill.tsx`). */
export function onZoomAnnounce(listener: (announcement: ZoomAnnouncement) => void): () => void {
  announcers.add(listener)
  return () => { announcers.delete(listener) }
}

function displayOf(report: UiZoomReport | null | undefined): Display {
  return report && Number(report.displayWidth) > 0 && Number(report.displayHeight) > 0 ? { width: Number(report.displayWidth), height: Number(report.displayHeight) } : null
}

function publish(next: State) {
  if (next.zoom === state.zoom && next.display?.width === state.display?.width && next.display?.height === state.display?.height) return
  state = next
  syncMenu()
  for (const listener of [...listeners]) listener()
}

/** The View menu (macOS): Zoom in off at the largest size that fits, Zoom out at 80 %, Actual size at 100 %. */
function syncMenu() {
  const steps = availableSteps(state.display)
  try { native?.setZoomMenuState?.(state.zoom < steps[steps.length - 1] - 1e-6, state.zoom > UI_ZOOM_STEPS[0] + 1e-6, Math.abs(state.zoom - 1) > 1e-6) } catch { /* Window closing. */ }
}

/** The display the window is on now (it may have moved since the last zoom). */
function readDisplay(): Display {
  try { return displayOf(native?.getUiZoom?.()) ?? state.display } catch { return state.display }
}

/** Apply `zoom` to this window: the minimum size first (a smaller window grows to it), then the zoom. */
function apply(zoom: number) {
  if (!native?.setUiZoom) { publish({ ...state, zoom: 1 }); return }
  const min = minWindowSize(zoom)
  try {
    const report = native.setUiZoom(zoom, min.width, min.height)
    try { native.setTrafficLightPosition?.(TRAFFIC_LIGHTS.x, trafficLightY(zoom)) } catch { /* An addon without it. */ }
    // The addon answers in f32 (0.800000011…): keep the step itself.
    const applied = Number(report?.zoom)
    publish({ zoom: Number.isFinite(applied) && Math.abs(applied - zoom) > 1e-3 ? snapToStep(applied) : zoom, display: displayOf(report) ?? state.display })
  } catch (error) {
    console.error('[ui-zoom]', error)
  }
}

/**
 * Set the interface size and save it for the device. Returns the zoom applied: `zoom` itself, or the largest step that
 * fits this window's display.
 */
export function setUiZoom(zoom: number, options: { announce?: boolean } = {}): number {
  const wanted = snapToStep(zoom)
  const applied = fittingZoom(wanted, readDisplay())
  apply(applied)
  try { writePref(PREF, wanted); siblings?.tell() } catch { /* A read-only config folder: this window still zooms. */ }
  if (options.announce) announce({ zoom: applied, limit: false })
  return applied
}

function announce(announcement: ZoomAnnouncement) {
  for (const listener of [...announcers]) listener(announcement)
}

function step(direction: 1 | -1) {
  const display = readDisplay()
  const next = nextStep(state.zoom, direction, display)
  // At either end the readout still answers, so the key press is not silent; past the largest size that fits the
  // display it says why.
  if (next === null) { announce({ zoom: state.zoom, limit: direction > 0 && UI_ZOOM_STEPS.some((step) => step > state.zoom && !stepFits(step, display)) }); return }
  setUiZoom(next, { announce: true })
}
export const zoomIn = () => step(1)
export const zoomOut = () => step(-1)
export const resetZoom = () => { setUiZoom(1, { announce: true }) }

/** ⌘= ⌘+ ⌘⇧= zoom in, ⌘− out, ⌘0 actual size (Ctrl off macOS; AltGr text never matches: Alt must be up). */
export function zoomKey(event: { key?: string | null; modifiers?: KeyMods }): 'in' | 'out' | 'reset' | null {
  const m = event.modifiers
  if (!isPrimaryChord(m, { shift: 'any' })) return null
  switch (event.key) {
    case '=': case '+': return 'in'
    case '-': return m?.shift ? null : 'out'
    case '0': return m?.shift ? null : 'reset'
  }
  return null
}

/**
 * Window options for `render`: open at the saved zoom. The minimum stays 900×600 (100 %) until `installUiZoom` knows the
 * display: a saved size may not fit the display the window opens on (a laptop off its external monitor), and a launch
 * minimum larger than the display would leave the window larger than it after the zoom drops to a size that fits.
 */
export function launchWindowOptions(): { uiZoom: number; minWidth: number; minHeight: number; trafficLightX: number; trafficLightY: number } {
  const zoom = state.zoom
  return { uiZoom: zoom, minWidth: BASE_MIN_SIZE.width, minHeight: BASE_MIN_SIZE.height, trafficLightX: TRAFFIC_LIGHTS.x, trafficLightY: trafficLightY(zoom) }
}

/** The other window processes (`windows/registry.ts`): told when this one changes the size, and telling it in turn. */
export type ZoomSiblings = { tell: () => void; listen: (listener: () => void) => void }
let siblings: ZoomSiblings | null = null

let installed = false
/**
 * Follow this window after `render`: read the display, drop to a step that fits it, route the View menu's zoom items,
 * and pick up a zoom another window saved: at once when that window says so (`siblings`), and when this one's state
 * changes (`onActive`, from the window-state events: it may have moved to a smaller display, or missed the message).
 */
export function installUiZoom(renderer: object, onActive?: (listener: () => void) => () => void, others?: ZoomSiblings) {
  if (installed) return
  installed = true
  native = renderer as ZoomRenderer
  if (typeof native.getUiZoom !== 'function') { native = null; publish({ zoom: 1, display: null }); return }
  let report: UiZoomReport | null = null
  try { report = native.getUiZoom() } catch { /* Window closing. */ }
  const display = displayOf(report)
  const fitting = fittingZoom(savedUiZoom(), display)
  publish({ ...state, display })
  // Always: the window opened with the 100 % minimum (`launchWindowOptions`) and grows to this zoom's here.
  apply(fitting)
  syncMenu()
  try {
    native.setMenuCommandCallback?.((error, command) => {
      if (error) return
      if (command === 'zoomIn') zoomIn()
      else if (command === 'zoomOut') zoomOut()
      else if (command === 'actualSize') resetZoom()
    })
  } catch { /* An addon without the View menu. */ }
  const follow = () => {
    let saved: number
    try { saved = snapToStep(reloadPrefs()[PREF] ?? 1) } catch { return }
    const next = fittingZoom(saved, readDisplay())
    if (Math.abs(next - state.zoom) > 1e-3) apply(next)
  }
  onActive?.(follow)
  if (others) { siblings = others; others.listen(follow) }
}

/** Tests only: forget the window and the state. */
export function resetUiZoomForTests(next: Partial<State> = {}) {
  installed = false
  native = null
  siblings = null
  state = { zoom: 1, display: null, ...next }
  listeners.clear()
  announcers.clear()
}
