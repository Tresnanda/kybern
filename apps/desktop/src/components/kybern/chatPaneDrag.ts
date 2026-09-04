import type { PointerEvent as ReactPointerEvent } from "react"

import type { ThreadId } from "@/protocol"
import type { SplitDirection, SplitSide } from "@/state/splitView"

export type DropZone = "top" | "bottom" | "left" | "right"

export interface ThreadPointerDrag {
  threadId: ThreadId
  clientX: number
  clientY: number
}

type ThreadDragListener = (drag: ThreadPointerDrag | null) => void
type ThreadDropListener = (drop: ThreadPointerDrag) => void

const THREAD_DRAG_THRESHOLD = 6
const dragListeners = new Set<ThreadDragListener>()
const dropListeners = new Set<ThreadDropListener>()

let currentDrag: ThreadPointerDrag | null = null
let cancelCurrentPointerDrag: (() => void) | null = null
let suppressedClick: { threadId: ThreadId; expiresAt: number } | null = null

function publishDrag(drag: ThreadPointerDrag | null): void {
  currentDrag = drag
  for (const listener of [...dragListeners]) listener(drag)
}

function publishDrop(drop: ThreadPointerDrag): void {
  for (const listener of [...dropListeners]) listener(drop)
}

export function subscribeThreadPointerDrag(
  listener: ThreadDragListener
): () => void {
  dragListeners.add(listener)
  listener(currentDrag)
  return () => dragListeners.delete(listener)
}

export function subscribeThreadPointerDrop(
  listener: ThreadDropListener
): () => void {
  dropListeners.add(listener)
  return () => dropListeners.delete(listener)
}

export function hasCrossedThreadDragThreshold(
  startX: number,
  startY: number,
  clientX: number,
  clientY: number
): boolean {
  return (
    Math.hypot(clientX - startX, clientY - startY) >= THREAD_DRAG_THRESHOLD
  )
}

/**
 * Start an in-app thread drag without relying on HTML DataTransfer. WKWebView
 * does not reliably promote custom element drags into drag sessions, while
 * pointer capture is continuous and uses the same coordinates as our panes.
 */
export function beginThreadPointerDrag(
  event: ReactPointerEvent<HTMLElement>,
  threadId: ThreadId
): void {
  if (event.button !== 0 || !event.isPrimary) return

  cancelCurrentPointerDrag?.()

  const source = event.currentTarget
  const pointerId = event.pointerId
  const startX = event.clientX
  const startY = event.clientY
  let clientX = startX
  let clientY = startY
  let dragging = false
  let finished = false

  const cleanup = () => {
    window.removeEventListener("pointermove", onPointerMove, true)
    window.removeEventListener("pointerup", onPointerUp, true)
    window.removeEventListener("pointercancel", onPointerCancel, true)
    window.removeEventListener("blur", onWindowBlur)
    window.removeEventListener("keydown", onKeyDown, true)
    source.removeAttribute("data-thread-drag-source")
    document.documentElement.removeAttribute("data-thread-pointer-dragging")
    try {
      if (source.hasPointerCapture(pointerId))
        source.releasePointerCapture(pointerId)
    } catch {
      // Pointer capture is best-effort on older embedded WebKit builds.
    }
  }

  const finish = (drop: boolean) => {
    if (finished) return
    finished = true
    cleanup()
    cancelCurrentPointerDrag = null

    if (!dragging) return
    suppressedClick = {
      threadId,
      expiresAt: performance.now() + 500,
    }
    const result = { threadId, clientX, clientY }
    publishDrag(null)
    if (drop) publishDrop(result)
  }

  function onPointerMove(pointerEvent: PointerEvent) {
    if (pointerEvent.pointerId !== pointerId) return
    clientX = pointerEvent.clientX
    clientY = pointerEvent.clientY
    if (
      !dragging &&
      !hasCrossedThreadDragThreshold(startX, startY, clientX, clientY)
    )
      return

    if (!dragging) {
      dragging = true
      source.setAttribute("data-thread-drag-source", "true")
      document.documentElement.setAttribute(
        "data-thread-pointer-dragging",
        "true"
      )
      try {
        source.setPointerCapture(pointerId)
      } catch {
        // Window-level listeners still complete the drag when capture is absent.
      }
    }
    pointerEvent.preventDefault()
    publishDrag({ threadId, clientX, clientY })
  }

  function onPointerUp(pointerEvent: PointerEvent) {
    if (pointerEvent.pointerId !== pointerId) return
    clientX = pointerEvent.clientX
    clientY = pointerEvent.clientY
    if (dragging) pointerEvent.preventDefault()
    finish(true)
  }

  function onPointerCancel(pointerEvent: PointerEvent) {
    if (pointerEvent.pointerId === pointerId) finish(false)
  }

  function onWindowBlur() {
    finish(false)
  }

  function onKeyDown(keyEvent: KeyboardEvent) {
    if (keyEvent.key !== "Escape") return
    keyEvent.preventDefault()
    finish(false)
  }

  window.addEventListener("pointermove", onPointerMove, {
    capture: true,
    passive: false,
  })
  window.addEventListener("pointerup", onPointerUp, true)
  window.addEventListener("pointercancel", onPointerCancel, true)
  window.addEventListener("blur", onWindowBlur)
  window.addEventListener("keydown", onKeyDown, true)
  cancelCurrentPointerDrag = () => finish(false)
}

/** Prevent the click synthesized after a completed pointer drag from opening it. */
export function consumeThreadPointerDragClick(threadId: ThreadId): boolean {
  if (
    !suppressedClick ||
    suppressedClick.threadId !== threadId ||
    performance.now() > suppressedClick.expiresAt
  ) {
    return false
  }
  suppressedClick = null
  return true
}

function directionForZone(zone: DropZone): SplitDirection {
  return zone === "left" || zone === "right" ? "horizontal" : "vertical"
}

export function splitForZone(zone: DropZone): {
  direction: SplitDirection
  side: SplitSide
} {
  return {
    direction: directionForZone(zone),
    side: zone === "left" || zone === "top" ? "first" : "second",
  }
}

/** Favor left/right zones in wide panes and top/bottom zones in tall panes. */
export function dropZoneAt(
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  clientX: number,
  clientY: number,
  canDropInDirection: (direction: SplitDirection) => boolean
): DropZone | null {
  if (rect.width <= 0 || rect.height <= 0) return null
  const x = (clientX - rect.left) / rect.width
  const y = (clientY - rect.top) / rect.height
  if (x < 0 || x > 1 || y < 0 || y > 1) return null

  const horizontal = canDropInDirection("horizontal")
  const vertical = canDropInDirection("vertical")
  if (!horizontal && !vertical) return null
  if (!horizontal) return y < 0.5 ? "top" : "bottom"
  if (!vertical) return x < 0.5 ? "left" : "right"

  const edge = 1 / 3
  if (rect.width >= rect.height) {
    if (x < edge) return "left"
    if (x > 1 - edge) return "right"
    return y < 0.5 ? "top" : "bottom"
  }
  if (y < edge) return "top"
  if (y > 1 - edge) return "bottom"
  return x < 0.5 ? "left" : "right"
}
