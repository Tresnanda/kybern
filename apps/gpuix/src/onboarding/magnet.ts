// The magnetic primary (SPEC §7): within 24 px of a primary button the button drifts toward the pointer (x × 0.12, y × 0.2, at most
// 6 × 4 px) and settles back on a critically damped spring when the pointer leaves. Mouse only; off under Reduce Motion.
//
// No React work per pointer move. The Welcome root feeds the pointer in (`magnetPointer`); each button registers its wrapper, and
// the drift is written straight to the renderer with `setSubtreeTranslation` (a retained translation: no element building, no
// layout). A small spring loop runs only while a button is away from where it is heading, then stops.
import type { PublicInstance } from '@gpuix/react'

export const REACH = 24
export const DRIFT = { x: 0.12, y: 0.2 }
export const MAX_DRIFT = { x: 6, y: 4 }
/** The kit spring's response, seconds (`SPRING`: response .35). */
export const RESPONSE = 0.35

export interface Rect { x: number; y: number; width: number; height: number }
const clamp = (v: number, max: number) => Math.max(-max, Math.min(max, v))

/** How far the pointer is outside `rect` (0 inside). */
export function distanceOutside(rect: Rect, px: number, py: number): number {
  const dx = px < rect.x ? rect.x - px : px > rect.x + rect.width ? px - (rect.x + rect.width) : 0
  const dy = py < rect.y ? rect.y - py : py > rect.y + rect.height ? py - (rect.y + rect.height) : 0
  return Math.hypot(dx, dy)
}

/** Where the button wants to be for a pointer at (`px`, `py`): toward it from the centre, only within `REACH` of the button. */
export function magnetTarget(rect: Rect, px: number | null, py: number | null): { x: number; y: number } {
  if (px === null || py === null || distanceOutside(rect, px, py) > REACH) return { x: 0, y: 0 }
  const x = clamp((px - (rect.x + rect.width / 2)) * DRIFT.x, MAX_DRIFT.x)
  const y = clamp((py - (rect.y + rect.height / 2)) * DRIFT.y, MAX_DRIFT.y)
  return { x, y }
}

/** One step of a critically damped spring toward `to`: `[value, velocity]` after `dt` seconds. */
export function springStep(value: number, velocity: number, to: number, dt: number, response = RESPONSE): [number, number] {
  const omega = (2 * Math.PI) / response
  const accel = omega * omega * (to - value) - 2 * omega * velocity
  const v = velocity + accel * dt
  return [value + v * dt, v]
}

interface Renderer {
  getElementBounds?: (id: number) => Rect | null | undefined
  setSubtreeTranslation?: (id: number, v: { translateX: number; translateY: number }) => void
}
interface Magnet {
  node: () => PublicInstance | null
  renderer: Renderer
  /** The wrapper's rect without our own drift (the layout slot), refreshed at most every 250 ms. */
  slot: Rect | null
  readAt: number
  x: number; y: number; vx: number; vy: number
  to: { x: number; y: number }
}

const magnets = new Set<Magnet>()
let pointer: { x: number; y: number } | null = null
let timer: ReturnType<typeof setInterval> | undefined
let last = 0

/** Whether a button may drift at all: a mouse, a renderer that can move a subtree, and motion allowed. */
export function magnetSupported(renderer: unknown, reduced: boolean, patched: boolean): boolean {
  return !reduced && patched && typeof (renderer as Renderer).setSubtreeTranslation === 'function'
}

/** Register a button's wrapper. Returns the unregister, which also puts the button back. */
export function registerMagnet(renderer: unknown, node: () => PublicInstance | null): () => void {
  const magnet: Magnet = { node, renderer: renderer as Renderer, slot: null, readAt: 0, x: 0, y: 0, vx: 0, vy: 0, to: { x: 0, y: 0 } }
  magnets.add(magnet)
  return () => { magnets.delete(magnet); if (magnets.size === 0) stop() }
}

function slotOf(magnet: Magnet, now: number): Rect | null {
  if (magnet.slot && now - magnet.readAt < 250) return magnet.slot
  const id = magnet.node()?.id
  const bounds = id != null ? magnet.renderer.getElementBounds?.(id) : null
  magnet.readAt = now
  // The bounds are visual: they already include the drift written last, so take it out to get the layout slot.
  magnet.slot = bounds ? { x: bounds.x - magnet.x, y: bounds.y - magnet.y, width: bounds.width, height: bounds.height } : null
  return magnet.slot
}

/** The pointer in window coordinates, or null when it left the window. Retargets every registered button; starts the loop if one must move. */
export function magnetPointer(x: number | null, y: number | null): void {
  if (magnets.size === 0) return
  pointer = x === null || y === null ? null : { x, y }
  const now = Date.now()
  let moving = false
  for (const magnet of magnets) {
    const slot = pointer ? slotOf(magnet, now) : magnet.slot
    magnet.to = slot ? magnetTarget(slot, pointer?.x ?? null, pointer?.y ?? null) : { x: 0, y: 0 }
    if (Math.abs(magnet.to.x - magnet.x) > 0.01 || Math.abs(magnet.to.y - magnet.y) > 0.01) moving = true
  }
  if (moving) start()
}

function start() {
  if (timer) return
  last = performance.now()
  timer = setInterval(tick, 16)
}
function stop() {
  clearInterval(timer)
  timer = undefined
}

function tick() {
  const now = performance.now()
  const dt = Math.min(0.05, (now - last) / 1000)
  last = now
  let moving = false
  for (const magnet of magnets) {
    const [x, vx] = springStep(magnet.x, magnet.vx, magnet.to.x, dt)
    const [y, vy] = springStep(magnet.y, magnet.vy, magnet.to.y, dt)
    const settled = Math.abs(x - magnet.to.x) < 0.02 && Math.abs(y - magnet.to.y) < 0.02 && Math.abs(vx) < 0.05 && Math.abs(vy) < 0.05
    magnet.x = settled ? magnet.to.x : x; magnet.vx = settled ? 0 : vx
    magnet.y = settled ? magnet.to.y : y; magnet.vy = settled ? 0 : vy
    const id = magnet.node()?.id
    if (id != null) magnet.renderer.setSubtreeTranslation?.(id, { translateX: magnet.x, translateY: magnet.y })
    if (!settled) moving = true
  }
  if (!moving) stop()
}
