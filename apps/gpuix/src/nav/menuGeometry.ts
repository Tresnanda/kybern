// Pointer geometry for nested menus. Painted bounds only (window coordinates), so a submenu flipped to the
// left at the window edge works the same as one on the right.
export interface Point { x: number; y: number }
export interface Box { x: number; y: number; width: number; height: number }

export function containsPoint(box: Box | null | undefined, point: Point, slop = 0): boolean {
  return !!box && point.x >= box.x - slop && point.x <= box.x + box.width + slop && point.y >= box.y - slop && point.y <= box.y + box.height + slop
}

/**
 * Base UI's `safePolygon` as a triangle: the pointer may cross the trigger's siblings on its way to the open submenu
 * as long as it stays inside the triangle from where it left the trigger to the submenu's near edge (its top and
 * bottom corners, with a few px of slack). Inside the submenu itself is always safe.
 */
export function submenuCorridor(origin: Point | null, panel: Box | null | undefined, point: Point): boolean {
  if (!panel) return false
  if (containsPoint(panel, point, 1)) return true
  if (!origin) return false
  const edge = panel.x >= origin.x ? panel.x : panel.x + panel.width
  const progress = (point.x - origin.x) / (edge - origin.x)
  if (!Number.isFinite(progress) || progress < 0 || progress > 1) return false
  const top = origin.y + (panel.y - 5 - origin.y) * progress
  const bottom = origin.y + (panel.y + panel.height + 5 - origin.y) * progress
  return point.y >= Math.min(top, bottom) - 2 && point.y <= Math.max(top, bottom) + 2
}

/**
 * A submenu opens to the right of its trigger row, and the layer keeps it inside the window. When there is no room it
 * is pushed back over the trigger's own menu; that popup (`popup`, painted) then starts left of the row's right edge
 * and the submenu opens on the left instead.
 */
export function submenuOverlapsParent(popup: Box | null | undefined, row: Box | null | undefined): boolean {
  return !!popup && !!row && popup.x < row.x + row.width - 1
}
