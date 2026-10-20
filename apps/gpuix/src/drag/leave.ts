import type { EventPayload, NativeRenderer } from '@gpuix/react'

/** Native leave notifications can arrive when the pointer crosses a child. Only
 * leaving the capture surface itself cancels a gesture, like DOM pointer capture. */
export function leftCapture(event: EventPayload, renderer: NativeRenderer | null) {
  if (event.x == null || event.y == null) return false
  const box = renderer?.getElementBounds?.(event.elementId)
  return !!box && (event.x < box.x || event.y < box.y || event.x >= box.x + box.width || event.y >= box.y + box.height)
}

/** A press that has not become a drag yet. Layout and hover reconciliation can
 * report a leave while the pointer is still on the source, so only a leave past
 * its edge starts the drag. One without a position still ends the press, so a
 * release elsewhere cannot leave a stale one behind. */
export function leftSource(event: EventPayload, renderer: NativeRenderer | null | undefined) {
  return event.x == null || event.y == null || leftCapture(event, renderer ?? null)
}
