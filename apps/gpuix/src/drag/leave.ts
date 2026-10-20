import type { EventPayload, NativeRenderer } from '@gpuix/react'

/** Native leave notifications can arrive when the pointer crosses a child. Only
 * leaving the capture surface itself cancels a gesture, like DOM pointer capture. */
export function leftCapture(event: EventPayload, renderer: NativeRenderer | null) {
  if (event.x == null || event.y == null) return false
  const box = renderer?.getElementBounds?.(event.elementId)
  return !!box && (event.x < box.x || event.y < box.y || event.x >= box.x + box.width || event.y >= box.y + box.height)
}
