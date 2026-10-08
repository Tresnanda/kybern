/** Floating mini player geometry (ADE-34 spec 3.6). Pure. */

export type PlayerSize = { w: number; h: number }
export type PlayerPoint = { x: number; y: number }
export type PlayerBounds = { w: number; h: number }
export type PlayerCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right"

export const PLAYER_DEFAULT_BOX = 320
export const PLAYER_MIN: PlayerSize = { w: 240, h: 150 }
export const PLAYER_MAX_WIDTH_RATIO = 0.5
export const PLAYER_MAX_HEIGHT_RATIO = 0.6
export const PLAYER_GAP = 12
export const PLAYER_DECAY_RATE = 0.998
export const PLAYER_CORNERS: readonly PlayerCorner[] = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
]

/** Largest box with the page's aspect ratio that fits 320x320 (then clamped to bounds). */
export function defaultPlayerSize(aspect: PlayerSize, bounds?: PlayerBounds): PlayerSize {
  const ratio = aspect.w > 0 && aspect.h > 0 ? aspect.w / aspect.h : 16 / 10
  const raw: PlayerSize =
    ratio >= 1
      ? { w: PLAYER_DEFAULT_BOX, h: PLAYER_DEFAULT_BOX / ratio }
      : { w: PLAYER_DEFAULT_BOX * ratio, h: PLAYER_DEFAULT_BOX }
  return clampPlayerSize(raw, bounds)
}

/** Min 240x150; max 50% of the column width and 60% of its height. Min wins in tiny columns. */
export function clampPlayerSize(size: PlayerSize, bounds?: PlayerBounds): PlayerSize {
  const maxW = bounds ? bounds.w * PLAYER_MAX_WIDTH_RATIO : Infinity
  const maxH = bounds ? bounds.h * PLAYER_MAX_HEIGHT_RATIO : Infinity
  return {
    w: Math.round(Math.max(PLAYER_MIN.w, Math.min(size.w, maxW))),
    h: Math.round(Math.max(PLAYER_MIN.h, Math.min(size.h, maxH))),
  }
}

/** Apple's deceleration projection: `v / 1000 * rate / (1 - rate)` (v in px/s). */
export function project(velocity: number, rate: number = PLAYER_DECAY_RATE): number {
  return ((velocity / 1000) * rate) / (1 - rate)
}

export type CornerOptions = {
  gap?: number
  /** Distance reserved at the bottom (composer height + 12). Never less than the gap. */
  bottomInset?: number
}

/** Top-left position of the player pinned to a corner. */
export function cornerPosition(
  corner: PlayerCorner,
  size: PlayerSize,
  bounds: PlayerBounds,
  options: CornerOptions = {},
): PlayerPoint {
  const gap = options.gap ?? PLAYER_GAP
  const bottom = Math.max(gap, options.bottomInset ?? 0)
  const left = gap
  const right = bounds.w - gap - size.w
  const top = gap
  const low = bounds.h - bottom - size.h
  return {
    x: Math.max(gap, corner.endsWith("left") ? left : right),
    y: Math.max(gap, corner.startsWith("top") ? top : low),
  }
}

/**
 * On release: project the player's top-left with the release velocity (px/s)
 * and pick the nearest of the four corner positions.
 */
export function nearestCorner(
  position: PlayerPoint,
  velocity: PlayerPoint,
  size: PlayerSize,
  bounds: PlayerBounds,
  options: CornerOptions = {},
): PlayerCorner {
  const end = { x: position.x + project(velocity.x), y: position.y + project(velocity.y) }
  let best: PlayerCorner = "bottom-right"
  let bestDistance = Infinity
  for (const corner of PLAYER_CORNERS) {
    const at = cornerPosition(corner, size, bounds, options)
    const distance = (at.x - end.x) ** 2 + (at.y - end.y) ** 2
    if (distance < bestDistance) {
      best = corner
      bestDistance = distance
    }
  }
  return best
}

/** Which corner the resize handle sits on: the one facing the column center. */
export function resizeHandleCorner(corner: PlayerCorner): PlayerCorner {
  return `${corner.startsWith("top") ? "bottom" : "top"}-${corner.endsWith("left") ? "right" : "left"}` as PlayerCorner
}

export function isPlayerCorner(value: unknown): value is PlayerCorner {
  return typeof value === "string" && (PLAYER_CORNERS as readonly string[]).includes(value)
}
