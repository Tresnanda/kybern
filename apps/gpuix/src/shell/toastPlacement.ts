import type { LayoutRect } from '../native/layout.ts'

/** Shared with the update announcement so both surfaces align at the window corner. */
export const NOTIFICATION_INSET = 16
const COMPOSER_GAP = 8

/** Bottom-right anchor for a toast stack. Lift only past composer cards it actually intersects. */
export function toastPosition(window: { width: number; height: number }, width: number, height: number, composers: readonly LayoutRect[]) {
  const x = window.width - NOTIFICATION_INSET
  let y = window.height - NOTIFICATION_INSET
  // Bottom-most cards first: moving above a lower card may meet a second pane's composer.
  for (const rect of [...composers].sort((a, b) => b.y - a.y)) {
    if (rect.width <= 0 || rect.height <= 0) continue
    if (x <= rect.x || x - width >= rect.x + rect.width) continue
    if (y <= rect.y || y - height >= rect.y + rect.height) continue
    y = rect.y - COMPOSER_GAP
  }
  return { x, y }
}
