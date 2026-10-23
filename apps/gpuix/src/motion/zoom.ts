// The image preview's zoom model (lightbox and image tab): pure geometry, no rendering.
//
// A view is `{ z, x, y }`: `z` is points per image pixel, `(x, y)` where the image's top-left sits inside the viewport. The
// image itself never relayouts; the surface paints one node under a `paintTransform` computed from the view
// (`ZoomSurface.tsx`). `null` stands for "fit": the view is derived from the viewport, so a window resize re-fits.
//
// - Fit contains the image in the viewport, never upscaled. An image much taller or wider than the viewport (aspect beyond
//   `EXTREME` times its own) fits its width (or height) instead and scrolls along the long axis, opening at its start.
// - 100% is actual pixels at the device scale: one image pixel per device pixel (`1 / scaleFactor` points).
// - The range runs from fit (or 100% when that is smaller) to 800%. Zoom keeps the point under the pointer still.
// - An axis smaller than the viewport is centred; a larger one is clamped to its edges.

export interface Size { width: number; height: number }
export interface Point { x: number; y: number }
export interface View { z: number; x: number; y: number }
/** The viewer's state: a free view, or null while fitted. */
export type ZoomState = View | null

/** How much larger an aspect ratio must be than the viewport's before the image fits its width (or height) instead. */
export const EXTREME = 1.6
/** The most it zooms, as a multiple of actual pixels. */
export const MAX_ACTUAL = 8
/** One ⌘+ / ⌘− step. */
export const STEP = 1.25

export type FitAxis = 'contain' | 'width' | 'height'
export interface Limits {
  /** Points per image pixel at fit. */
  fit: number
  /** Which side fit was taken by. */
  axis: FitAxis
  /** Points per image pixel at 100%. */
  actual: number
  min: number
  max: number
  /** Where a short axis is centred, in viewport coordinates (the viewport's centre unless the opener sits the image elsewhere). */
  home: Point
  pad: number
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high)

/** `pad`: room kept clear around the fitted picture (the image tab's margin); a zoomed picture still reaches the edges. */
export function limits(image: Size, viewport: Size, scaleFactor = 1, home: Point = { x: viewport.width / 2, y: viewport.height / 2 }, pad = 0): Limits {
  const actual = 1 / Math.max(scaleFactor, 1)
  const room = { width: Math.max(1, viewport.width - 2 * pad), height: Math.max(1, viewport.height - 2 * pad) }
  const viewAspect = room.width / room.height, aspect = image.width / image.height
  let axis: FitAxis = 'contain'
  let fit = Math.min(room.width / image.width, room.height / image.height)
  if (aspect < viewAspect / EXTREME) { axis = 'width'; fit = room.width / image.width }
  else if (aspect > viewAspect * EXTREME) { axis = 'height'; fit = room.height / image.height }
  // Never upscaled beyond one point per pixel (what the preview always did).
  fit = Math.min(fit, 1)
  return { fit, axis, actual, min: Math.min(fit, actual), max: Math.max(fit, actual * MAX_ACTUAL), home, pad }
}

/** An offset on one axis: centred on `home` when the image is smaller than the viewport, otherwise kept inside its edges. */
export function clampAxis(offset: number, extent: number, room: number, home = room / 2): number {
  return extent <= room ? clamp(home - extent / 2, 0, room - extent) : clamp(offset, room - extent, 0)
}

export function clampView(view: View, image: Size, viewport: Size, lim: Limits): View {
  const z = clamp(view.z, lim.min, lim.max)
  return { z, x: clampAxis(view.x, image.width * z, viewport.width, lim.home.x), y: clampAxis(view.y, image.height * z, viewport.height, lim.home.y) }
}

/** Fit: centred on a short axis, at the start of a long one. */
export function fitView(image: Size, viewport: Size, lim: Limits): View {
  return clampView({ z: lim.fit, x: lim.pad, y: lim.pad }, image, viewport, lim)
}

export function resolveView(state: ZoomState, image: Size, viewport: Size, lim: Limits): View {
  return state ? clampView(state, image, viewport, lim) : fitView(image, viewport, lim)
}

/** The view at zoom `z` that keeps the image point under `anchor` (viewport coordinates) where it was. */
export function zoomAt(view: View, z: number, anchor: Point, image: Size, viewport: Size, lim: Limits): View {
  const next = clamp(z, lim.min, lim.max), ratio = next / view.z
  return clampView({ z: next, x: anchor.x - (anchor.x - view.x) * ratio, y: anchor.y - (anchor.y - view.y) * ratio }, image, viewport, lim)
}

export function panBy(view: View, dx: number, dy: number, image: Size, viewport: Size, lim: Limits): View {
  return clampView({ ...view, x: view.x + dx, y: view.y + dy }, image, viewport, lim)
}

const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(a, b) * 0.005
export const isFit = (view: View, lim: Limits) => near(view.z, lim.fit)
export const isActual = (view: View, lim: Limits) => near(view.z, lim.actual)
/** The percentage the HUD shows: 100 is actual pixels. */
export const percent = (view: View, lim: Limits) => Math.round((view.z / lim.actual) * 100)

/** The zoom one step in `direction` (+1 in, -1 out). It lands exactly on fit and on 100% when a step would cross them. */
export function stepZoom(z: number, direction: 1 | -1, lim: Limits): number {
  const next = clamp(direction > 0 ? z * STEP : z / STEP, lim.min, lim.max)
  for (const stop of [lim.fit, lim.actual]) {
    if (near(z, stop)) continue
    if (direction > 0 ? z < stop && next > stop : z > stop && next < stop) return clamp(stop, lim.min, lim.max)
  }
  return next
}

/** Double click and the HUD toggle: fit ↔ 100%. From 100% back to fit; from anywhere else to 100%. */
export function toggleZoom(view: View, lim: Limits): number {
  return isActual(view, lim) ? lim.fit : lim.actual
}

/**
 * ⌘-scroll: the factor one wheel event applies. Pixel (trackpad) deltas are fine; line (mouse wheel) ones are coarse. GPUI's
 * `deltaY` is positive for a scroll toward the top (the wheel rolled up), which zooms in, as ⌘/ctrl-scroll does in browsers,
 * Figma and Sketch.
 */
export function wheelFactor(deltaY: number, precise: boolean): number {
  return clamp(Math.exp(deltaY * (precise ? 0.01 : 0.12)), 0.5, 2)
}
