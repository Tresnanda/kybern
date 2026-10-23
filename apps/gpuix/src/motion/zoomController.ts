// The zoom state and its input handling, outside React: one controller per open image. The preview shell configures it every
// render (image, viewport, where the viewport sits in the window, the device scale); the surface and the HUD subscribe to its
// snapshot, so a wheel event re-renders those two and nothing else (`ZoomSurface.tsx`). Geometry is `zoom.ts`.
import { clampView, fitView, isActual, isFit, limits, panBy, percent, resolveView, stepZoom, toggleZoom, wheelFactor, zoomAt, type Limits, type Point, type Size, type View, type ZoomState } from './zoom.ts'

export interface ZoomConfig {
  /** The image's pixel size; null when its header could not be read (nothing zooms). */
  image: Size | null
  viewport: Size
  /** Where the viewport's top-left sits in the window, to turn event positions into viewport ones (read per event when a function). */
  origin: Point | (() => Point)
  scaleFactor: number
  /** Where a short axis is centred, in viewport coordinates (default: the centre). */
  home?: Point
  /** Room kept clear around the fitted picture. */
  pad?: number
  /** Reduce Motion: every change lands at once. */
  reduced: boolean
}

/** What the surface paints: the stage (the image laid out at fit, in the viewport) under this transform, origin top-left. */
export interface ZoomSnapshot {
  enabled: boolean
  view: View
  limits: Limits | null
  percent: number
  /** At fit (the HUD toggle reads "100%" from here, and the quick exit may morph). */
  fitted: boolean
  actual: boolean
  /** Past fit: the lift shadow is gone, the cursor grabs. */
  zoomed: boolean
  dragging: boolean
  /** The image laid out at fit inside the viewport: the stage's box. */
  stage: { x: number; y: number; width: number; height: number }
  transform: { scale: number; translateX: number; translateY: number }
  /** Seconds the transform takes to get there: 0 for direct manipulation, a short ease for a step or a toggle. */
  duration: number
}

const EASED = 0.2
/** Two clicks this close in time and place are a double click when the platform did not say so. */
const DOUBLE_MS = 450
const NONE: ZoomSnapshot = { enabled: false, view: { z: 1, x: 0, y: 0 }, limits: null, percent: 100, fitted: true, actual: false, zoomed: false, dragging: false, stage: { x: 0, y: 0, width: 0, height: 0 }, transform: { scale: 1, translateX: 0, translateY: 0 }, duration: 0 }

export interface WheelInput { x: number; y: number; deltaX: number; deltaY: number; precise: boolean; modifiers?: { cmd?: boolean; ctrl?: boolean } }
export interface KeyInput { key?: string; modifiers?: { cmd?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } }

/** A line-based wheel (a mouse) pans this many points a line. */
const LINE = 20

export class ZoomController {
  private cfg: ZoomConfig = { image: null, viewport: { width: 1, height: 1 }, origin: { x: 0, y: 0 }, scaleFactor: 1, reduced: false }
  private state: ZoomState = null
  private duration = 0
  private pointer: Point | null = null
  private drag: { x: number; y: number; view: View } | null = null
  private listeners = new Set<() => void>()
  private snap: ZoomSnapshot = NONE
  private snapKey = ''
  private version = 0
  private lastClick: { x: number; y: number; at: number } | null = null

  configure(cfg: ZoomConfig) { this.cfg = cfg }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

  private lim(): Limits | null {
    const { image, viewport, scaleFactor, home, pad } = this.cfg
    return image && image.width > 0 && image.height > 0 && viewport.width > 0 && viewport.height > 0 ? limits(image, viewport, scaleFactor, home, pad) : null
  }

  private current(): { view: View; lim: Limits } | null {
    const lim = this.lim()
    return lim ? { view: resolveView(this.state, this.cfg.image!, this.cfg.viewport, lim), lim } : null
  }

  /** Stable between changes (a `useSyncExternalStore` snapshot): rebuilt only when the state or the configuration moved. */
  snapshot = (): ZoomSnapshot => {
    const { image, viewport, scaleFactor, home, pad } = this.cfg
    const key = `${this.version}|${image?.width}x${image?.height}|${viewport.width}x${viewport.height}|${scaleFactor}|${home?.x},${home?.y}|${pad ?? 0}|${this.cfg.reduced}`
    if (key === this.snapKey) return this.snap
    this.snapKey = key
    const now = this.current()
    if (!now) return (this.snap = NONE)
    const { view, lim } = now, fit = fitView(this.cfg.image!, viewport, lim)
    this.snap = {
      enabled: true,
      view,
      limits: lim,
      percent: percent(view, lim),
      fitted: isFit(view, lim),
      actual: isActual(view, lim),
      zoomed: view.z > lim.fit * 1.005,
      dragging: !!this.drag,
      stage: { x: fit.x, y: fit.y, width: this.cfg.image!.width * lim.fit, height: this.cfg.image!.height * lim.fit },
      transform: { scale: view.z / lim.fit, translateX: view.x - fit.x, translateY: view.y - fit.y },
      duration: this.cfg.reduced ? 0 : this.duration,
    }
    return this.snap
  }

  private set(next: View, eased: boolean) {
    const now = this.current()
    if (!now) return
    const clamped = clampView(next, this.cfg.image!, this.cfg.viewport, now.lim)
    const fit = fitView(this.cfg.image!, this.cfg.viewport, now.lim)
    // Back at the fitted view: follow the window again.
    this.state = Math.abs(clamped.z - fit.z) < 1e-6 && Math.abs(clamped.x - fit.x) < 0.5 && Math.abs(clamped.y - fit.y) < 0.5 ? null : clamped
    this.duration = eased ? EASED : 0
    this.changed()
  }

  private changed() { this.version++; for (const listener of [...this.listeners]) listener() }

  /** A window point in viewport coordinates. */
  local(x: number, y: number): Point {
    const o = typeof this.cfg.origin === 'function' ? this.cfg.origin() : this.cfg.origin
    return { x: x - o.x, y: y - o.y }
  }

  /** Where a keyboard zoom anchors: the pointer when it is over the viewport, else the middle. */
  private anchor(): Point {
    const { viewport } = this.cfg, p = this.pointer
    return p && p.x >= 0 && p.y >= 0 && p.x <= viewport.width && p.y <= viewport.height ? p : { x: viewport.width / 2, y: viewport.height / 2 }
  }

  zoomTo(z: number, anchor: Point | undefined, eased: boolean) {
    const now = this.current()
    if (now) this.set(zoomAt(now.view, z, anchor ?? this.anchor(), this.cfg.image!, this.cfg.viewport, now.lim), eased)
  }

  step(direction: 1 | -1) {
    const now = this.current()
    if (now) this.zoomTo(stepZoom(now.view.z, direction, now.lim), undefined, true)
  }

  /** Fit ↔ 100%, anchored at `at` (a double click) or the pointer. */
  toggle(at?: Point) {
    const now = this.current()
    if (now) this.zoomTo(toggleZoom(now.view, now.lim), at, true)
  }

  fit() {
    if (this.state) { this.state = null; this.duration = EASED; this.changed() }
  }

  /** Two-finger scroll pans; ⌘-scroll (and a pinch that arrives as ctrl-scroll) zooms about the pointer. */
  wheel(input: WheelInput) {
    const now = this.current()
    if (!now) return
    const at = this.local(input.x, input.y)
    this.pointer = at
    if (input.modifiers?.cmd || input.modifiers?.ctrl) return this.zoomTo(now.view.z * wheelFactor(input.deltaY, input.precise), at, false)
    const k = input.precise ? 1 : LINE
    this.set(panBy(now.view, input.deltaX * k, input.deltaY * k, this.cfg.image!, this.cfg.viewport, now.lim), false)
  }

  hover(x: number, y: number) { this.pointer = this.local(x, y) }

  pointerDown(x: number, y: number) {
    const now = this.current()
    this.pointer = this.local(x, y)
    this.drag = now ? { ...this.local(x, y), view: now.view } : null
    if (now) this.changed()
  }

  /** `pressed`: the primary button is still down. A move after the release was lost ends the drag. */
  pointerMove(x: number, y: number, pressed: boolean) {
    this.pointer = this.local(x, y)
    if (!this.drag) return
    if (!pressed) return this.pointerUp()
    const now = this.current()
    if (!now) return
    const p = this.local(x, y)
    this.set(panBy(this.drag.view, p.x - this.drag.x, p.y - this.drag.y, this.cfg.image!, this.cfg.viewport, now.lim), false)
  }

  pointerUp() {
    if (!this.drag) return
    this.drag = null
    this.changed()
  }

  /** A click: the second of a double click toggles at that point. Returns where it landed so the shell can treat the letterbox as the backdrop. */
  click(x: number, y: number, count: number, at = Date.now()): 'toggled' | 'image' | 'outside' | null {
    const now = this.current()
    if (!now) return null
    // The platform's click count when it has one; otherwise (injected clicks report 1) two clicks close together are a double.
    const last = this.lastClick
    this.lastClick = { x, y, at }
    if (count < 2 && last && at - last.at <= DOUBLE_MS && Math.hypot(x - last.x, y - last.y) <= 6) { this.lastClick = null; count = 2 }
    const p = this.local(x, y), { view } = now, image = this.cfg.image!
    const inside = p.x >= view.x && p.x <= view.x + image.width * view.z && p.y >= view.y && p.y <= view.y + image.height * view.z
    if (!inside) return 'outside'
    if (count >= 2) { this.toggle(p); return 'toggled' }
    return 'image'
  }

  /** ⌘+ ⌘= ⌘− ⌘0. True when handled. */
  key(event: KeyInput): boolean {
    const m = event.modifiers
    if (!m?.cmd || m.ctrl || m.alt || !this.current()) return false
    switch (event.key) {
      case '=': case '+': this.step(1); return true
      case '-': case '_': this.step(-1); return true
      case '0': this.fit(); return true
    }
    return false
  }
}
