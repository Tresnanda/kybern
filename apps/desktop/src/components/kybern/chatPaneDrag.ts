import type { DragEvent as ReactDragEvent } from "react"

import type { ThreadId } from "@/protocol"
import type { SplitDirection, SplitSide } from "@/state/splitView"

export const THREAD_DRAG_MIME = "application/x-kybern-thread"

export type DropZone = "top" | "bottom" | "left" | "right"

export function beginThreadDrag(
  event: ReactDragEvent,
  threadId: ThreadId
): void {
  event.dataTransfer.effectAllowed = "move"
  event.dataTransfer.setData(THREAD_DRAG_MIME, threadId)
}

export function hasThreadDrag(event: ReactDragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes(THREAD_DRAG_MIME)
}

export function readThreadDrag(event: ReactDragEvent): ThreadId | null {
  const value = event.dataTransfer.getData(THREAD_DRAG_MIME)
  return value ? (value as ThreadId) : null
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
