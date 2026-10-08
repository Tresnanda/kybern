/** Device toolbar math (ADE-34 spec 3.4). Pure. */

export type ViewportSize = { w: number; h: number }
export type ViewportGroup = "responsive" | "phone" | "tablet" | "desktop"
export type ViewportPreset = { id: string; label: string; group: ViewportGroup; w: number; h: number }

export const VIEWPORT_MIN = 240
export const VIEWPORT_MAX = 3840
export const VIEWPORT_MAX_AREA = 3840 * 2160
export const VIEWPORT_MARGIN = 12

export const RESPONSIVE_PRESET_ID = "responsive"

export const VIEWPORT_PRESETS: readonly ViewportPreset[] = [
  { id: "iphone-se", label: "iPhone SE", group: "phone", w: 375, h: 667 },
  { id: "iphone-12-pro", label: "iPhone 12 Pro", group: "phone", w: 390, h: 844 },
  { id: "iphone-14-pro-max", label: "iPhone 14 Pro Max", group: "phone", w: 430, h: 932 },
  { id: "pixel-7", label: "Pixel 7", group: "phone", w: 412, h: 915 },
  { id: "ipad-mini", label: "iPad mini", group: "tablet", w: 768, h: 1024 },
  { id: "ipad-air", label: "iPad Air", group: "tablet", w: 820, h: 1180 },
  { id: "laptop", label: "Laptop", group: "desktop", w: 1280, h: 800 },
  { id: "desktop", label: "Desktop", group: "desktop", w: 1440, h: 900 },
]

export function viewportPreset(id: string): ViewportPreset | undefined {
  return VIEWPORT_PRESETS.find((preset) => preset.id === id)
}

/** Parses a W or H field; null when not a whole number. */
export function parseViewportField(text: string): number | null {
  const t = text.trim()
  if (!/^\d{1,5}$/.test(t)) return null
  return Number(t)
}

/** True when the size commits as typed (no clamping needed). */
export function isViewportSizeValid(w: number, h: number): boolean {
  return (
    Number.isInteger(w) &&
    Number.isInteger(h) &&
    w >= VIEWPORT_MIN &&
    w <= VIEWPORT_MAX &&
    h >= VIEWPORT_MIN &&
    h <= VIEWPORT_MAX &&
    w * h <= VIEWPORT_MAX_AREA
  )
}

/** Clamps to 240-3840 per side and a 3840x2160 area, keeping the aspect when shrinking. */
export function clampViewport(size: ViewportSize): ViewportSize {
  let w = clamp(Math.round(size.w), VIEWPORT_MIN, VIEWPORT_MAX)
  let h = clamp(Math.round(size.h), VIEWPORT_MIN, VIEWPORT_MAX)
  if (w * h > VIEWPORT_MAX_AREA) {
    const k = Math.sqrt(VIEWPORT_MAX_AREA / (w * h))
    w = clamp(Math.floor(w * k), VIEWPORT_MIN, VIEWPORT_MAX)
    h = clamp(Math.floor(h * k), VIEWPORT_MIN, VIEWPORT_MAX)
    while (w * h > VIEWPORT_MAX_AREA) {
      if (w >= h && w > VIEWPORT_MIN) w -= 1
      else if (h > VIEWPORT_MIN) h -= 1
      else break
    }
  }
  return { w, h }
}

export function rotateViewport(size: ViewportSize): ViewportSize {
  return clampViewport({ w: size.h, h: size.w })
}

/** `s = min(1, (slotW - 24) / W, (slotH - 24) / H)`, never below a sliver. */
export function fitScale(size: ViewportSize, slot: ViewportSize): number {
  const m = VIEWPORT_MARGIN * 2
  const s = Math.min(1, (slot.w - m) / size.w, (slot.h - m) / size.h)
  return Number.isFinite(s) ? Math.max(0.01, s) : 1
}

export type ResizeEdge = "e" | "s" | "se"

export type ResizeInput = {
  edge: ResizeEdge
  /** Viewport size when the drag began. */
  start: ViewportSize
  /** Pointer position when the drag began (the grab offset is kept because only deltas count). */
  startPointer: { x: number; y: number }
  pointer: { x: number; y: number }
  /** Current fit scale; screen delta is divided by it so the edge stays under the pointer. */
  scale: number
  /** Keep the aspect ratio. */
  shift?: boolean
}

export function resizeViewport(input: ResizeInput): ViewportSize {
  const { edge, start, startPointer, pointer, shift } = input
  const scale = input.scale > 0 ? input.scale : 1
  const dx = (pointer.x - startPointer.x) / scale
  const dy = (pointer.y - startPointer.y) / scale
  let w = start.w + (edge === "s" ? 0 : dx)
  let h = start.h + (edge === "e" ? 0 : dy)
  if (shift) {
    const ratio = start.w / start.h
    if (edge === "e") h = w / ratio
    else if (edge === "s") w = h * ratio
    else if (Math.abs(w - start.w) / start.w >= Math.abs(h - start.h) / start.h) h = w / ratio
    else w = h * ratio
  }
  return clampViewport({ w, h })
}

/** Double-click on a rail: size the axis to the panel (at scale 1). */
export function fitAxis(axis: "w" | "h", size: ViewportSize, slot: ViewportSize): ViewportSize {
  const m = VIEWPORT_MARGIN * 2
  return clampViewport(
    axis === "w" ? { w: slot.w - m, h: size.h } : { w: size.w, h: slot.h - m },
  )
}

/** CSS for the scaled iframe and the box that reserves its scaled footprint. */
export function viewportLayout(size: ViewportSize, slot: ViewportSize) {
  const scale = fitScale(size, slot)
  const width = size.w * scale
  const height = size.h * scale
  return {
    scale,
    width,
    height,
    left: Math.max(VIEWPORT_MARGIN, (slot.w - width) / 2),
    top: Math.max(VIEWPORT_MARGIN, (slot.h - height) / 2),
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
