// Slot registry for the in-app preview. Moving an iframe reloads it, so live page
// documents sit in one stable layer (`PreviewSurfaceLayer`) and the dock pane and the
// mini player only register slots here. Rects are read from slot elements and written
// straight to the surface styles, so layout motion costs no React render.
//
// This is deliberately not part of the main store: layout updates must stay out of
// `useStore` subscribers.

import { create } from "zustand"

import { reloadOnHotUpdate } from "@/lib/hot"
import type { ThreadId } from "@/protocol"
import { isWindowOnScreen, subscribeWindowSurface } from "./windowSurfaceState"

export type PreviewSlotKind = "dock" | "pip"
export type PreviewRect = { x: number; y: number; w: number; h: number }

type SlotSource = {
  threadId: ThreadId
  /** Measured for its rect. The mini player passes a rect function instead. */
  element?: HTMLElement | null
  rect?: () => PreviewRect | null
  /** The surface is clipped to this element's box (the animating dock). */
  clip?: HTMLElement | null
}

type SlotState = { threadId: ThreadId; visible: boolean }

interface PreviewSurfaceState {
  /** Slot registrations visible to React: which thread owns which slot, and whether it is shown. */
  slots: Partial<Record<PreviewSlotKind, SlotState>>
  /** Chrome hosts (the surface element, or its chrome layer), so the mini player can portal above the page. */
  elements: Partial<Record<PreviewSlotKind, HTMLElement>>
  /** Fitted device scale in percent per slot kind, for the toolbar readout. */
  scale: Partial<Record<PreviewSlotKind, number>>
  /** The thread whose floating page is animating out. */
  exiting: ThreadId | null
  windowOnScreen: boolean
}

export const usePreviewSurface = create<PreviewSurfaceState>(() => ({
  slots: {},
  elements: {},
  scale: {},
  exiting: null,
  windowOnScreen: true,
}))

const sources = new Map<PreviewSlotKind, SlotSource>()

/** A surface's imperative side: it applies its slot rect to its own DOM. */
export type SurfaceHandle = {
  kind: PreviewSlotKind
  element: HTMLElement
  /** Where the mini player portals its header and resize handle (above the page). */
  chrome?: HTMLElement | null
  apply: (rect: PreviewRect | null, moving: boolean) => void
}
const handles = new Map<PreviewSlotKind, SurfaceHandle>()

export function registerSlot(kind: PreviewSlotKind, source: SlotSource, visible: boolean): () => void {
  sources.set(kind, source)
  usePreviewSurface.setState((s) => ({ slots: { ...s.slots, [kind]: { threadId: source.threadId, visible } } }))
  const element = source.element
  let observer: ResizeObserver | undefined
  if (element) {
    // The observer callback runs after layout and before paint: writing here keeps the page on the slot in the same frame.
    observer = new ResizeObserver(() => syncPreviewSurfaces())
    observer.observe(element)
    if (source.clip) observer.observe(source.clip)
  }
  pokePreviewLayout()
  return () => {
    observer?.disconnect()
    if (sources.get(kind) === source) sources.delete(kind)
    usePreviewSurface.setState((s) => {
      const current = s.slots[kind]
      if (!current || current.threadId !== source.threadId) return s
      const slots = { ...s.slots }
      delete slots[kind]
      return { slots }
    })
    syncPreviewSurfaces()
  }
}

export function setSlotVisible(kind: PreviewSlotKind, threadId: ThreadId, visible: boolean): void {
  usePreviewSurface.setState((s) => {
    const current = s.slots[kind]
    if (!current || current.threadId !== threadId || current.visible === visible) return s
    return { slots: { ...s.slots, [kind]: { threadId, visible } } }
  })
  if (visible) pokePreviewLayout()
}

export function registerSurface(handle: SurfaceHandle): () => void {
  handles.set(handle.kind, handle)
  const host = handle.chrome ?? handle.element
  usePreviewSurface.setState((s) => ({ elements: { ...s.elements, [handle.kind]: host } }))
  syncPreviewSurfaces()
  return () => {
    if (handles.get(handle.kind) === handle) handles.delete(handle.kind)
    usePreviewSurface.setState((s) => {
      if (s.elements[handle.kind] !== host) return s
      const elements = { ...s.elements }
      delete elements[handle.kind]
      return { elements }
    })
  }
}

export function setPreviewScale(kind: PreviewSlotKind, percent: number | null): void {
  usePreviewSurface.setState((s) => {
    if ((s.scale[kind] ?? null) === percent) return s
    const scale = { ...s.scale }
    if (percent === null) delete scale[kind]
    else scale[kind] = percent
    return { scale }
  })
}

/** Last docked size per thread: a floated page keeps this layout and scales down. */
export const dockedSize = new Map<ThreadId, { w: number; h: number }>()

const lastRects = new Map<PreviewSlotKind, PreviewRect | null>()
const lastChange = new Map<PreviewSlotKind, number>()

function readRect(source: SlotSource): PreviewRect | null {
  if (source.rect) return source.rect()
  const el = source.element
  if (!el || !el.isConnected) return null
  const box = el.getBoundingClientRect()
  return { x: box.left, y: box.top, w: box.width, h: box.height }
}

function sameRect(a: PreviewRect | null | undefined, b: PreviewRect | null): boolean {
  if (!a || !b) return a === b
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}

/** Intersect the slot with its clip element; null when nothing remains. */
function clipped(rect: PreviewRect, clip: HTMLElement | null | undefined): { rect: PreviewRect; clipPath: string } | null {
  if (!clip || !clip.isConnected) return { rect, clipPath: "none" }
  const box = clip.getBoundingClientRect()
  const left = Math.max(rect.x, box.left)
  const top = Math.max(rect.y, box.top)
  const right = Math.min(rect.x + rect.w, box.right)
  const bottom = Math.min(rect.y + rect.h, box.bottom)
  if (right <= left || bottom <= top) return null
  if (left === rect.x && top === rect.y && right === rect.x + rect.w && bottom === rect.y + rect.h) return { rect, clipPath: "none" }
  return { rect, clipPath: `inset(${top - rect.y}px ${rect.x + rect.w - right}px ${rect.y + rect.h - bottom}px ${left - rect.x}px)` }
}

const MOVING_QUIET_MS = 120

/** Write every surface's rect from its slot. Safe to call from a ResizeObserver callback. */
export function syncPreviewSurfaces(): void {
  const now = performance.now()
  for (const [kind, handle] of handles) {
    const source = sources.get(kind)
    const rect = source ? readRect(source) : null
    const fit = rect && source ? clipped(rect, source.clip) : null
    const previous = lastRects.get(kind)
    if (!sameRect(previous, rect)) {
      lastRects.set(kind, rect)
      lastChange.set(kind, now)
    }
    const moving = now - (lastChange.get(kind) ?? 0) < MOVING_QUIET_MS && previous !== undefined
    handle.apply(rect, moving)
    handle.element.style.clipPath = fit?.clipPath ?? "none"
    if (rect && !fit) handle.element.style.clipPath = "inset(100%)"
  }
}

let pollUntil = 0
let polling = false

/** Follow slots every frame for a while (a dock spring, a sidebar slide, a resize drag). */
export function pokePreviewLayout(durationMs = 900): void {
  if (typeof window === "undefined") return
  pollUntil = Math.max(pollUntil, performance.now() + durationMs)
  if (polling) return
  polling = true
  const tick = () => {
    syncPreviewSurfaces()
    if (performance.now() < pollUntil || document.documentElement.hasAttribute("data-resizing")) requestAnimationFrame(tick)
    else polling = false
  }
  requestAnimationFrame(tick)
}

let installed = false
/** Window-level triggers: resize, the dock resize flag, window visibility. Installed once. */
export function installPreviewSurfaceTriggers(): void {
  if (installed || typeof window === "undefined") return
  installed = true
  window.addEventListener("resize", () => pokePreviewLayout(200))
  new MutationObserver(() => pokePreviewLayout(300)).observe(document.documentElement, { attributes: true, attributeFilter: ["data-resizing"] })
  const visibility = () => usePreviewSurface.setState({ windowOnScreen: isWindowOnScreen() })
  document.addEventListener("visibilitychange", visibility)
  subscribeWindowSurface(visibility)
  visibility()
}

/** Show the exit state on the floating page, then run `done`. Reduced motion skips the wait. */
export function exitFloatingPreview(threadId: ThreadId, done: () => void): void {
  usePreviewSurface.setState({ exiting: threadId })
  window.setTimeout(() => {
    usePreviewSurface.setState({ exiting: null })
    done()
  }, 150)
}

reloadOnHotUpdate(import.meta.hot)
