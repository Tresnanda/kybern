// The project drag's view of the rail (`docs/specs/spaces.md` §7.10): the tiles register their
// row elements, the drag reads their rectangles once when it starts (and again after an edge
// scroll), and publishes which tile it hovers. Tiles draw their rings from that.
import { useSyncExternalStore } from 'react'
import type { NativeRenderer, PublicInstance } from '@gpuix/react'
import { onEnvironmentChange } from '../shell/environment.ts'

export interface DropRect { id: string; x: number; y: number; width: number; height: number }

const elements = new Map<string, PublicInstance>()
let rects: DropRect[] = []

/** A tile row registers itself while mounted. */
export function registerSpaceTarget(id: string, element: PublicInstance | null) {
  if (element) elements.set(id, element)
  else elements.delete(id)
}

/** Read every registered row's window rectangle. Call once at drag activation and after the rail scrolls. */
export function measureSpaceTargets(renderer: NativeRenderer | null | undefined) {
  rects = []
  if (!renderer?.getElementBounds) return
  for (const [id, element] of elements) {
    const bounds = renderer.getElementBounds(element.id)
    if (bounds) rects.push({ id, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height })
  }
}

/** How many tiles are registered: zero with one space, so a drag then has nowhere to go. */
export const spaceTargetCount = () => elements.size

let scroller: PublicInstance | null = null
/** The rail's scrolling column, for edge scrolling while a drag hovers it. */
export function registerSpaceScroller(element: PublicInstance | null) { scroller = element }
export const getSpaceScroller = () => scroller

/** The tile row under a point, from the rectangles measured at activation. */
export function hitSpaceTarget(x: number, y: number): string | null {
  for (const rect of rects) if (x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height) return rect.id
  return null
}

/** The measured rectangle of a tile row (the ghost lands on its tile). */
export const spaceTargetRect = (id: string): DropRect | null => rects.find((rect) => rect.id === id) ?? null

export interface SpaceDrag {
  /** A project is being dragged. */
  active: boolean
  /** The space the pointer is over, if any. */
  target: string | null
}

let drag: SpaceDrag = { active: false, target: null }
const listeners = new Set<() => void>()

export function publishSpaceDrag(next: SpaceDrag) {
  if (next.active === drag.active && next.target === drag.target) return
  drag = next
  for (const listener of listeners) listener()
}

export const getSpaceDrag = () => drag

export function useSpaceDrag<T>(select: (s: SpaceDrag) => T): T {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => select(drag))
}

onEnvironmentChange(() => { elements.clear(); rects = []; publishSpaceDrag({ active: false, target: null }) }, -50)
