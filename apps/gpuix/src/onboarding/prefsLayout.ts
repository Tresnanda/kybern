// The Preferences scene's pure rules (SPEC §5): how wide each column and card is, where the one sliding ring and the one
// sliding highlight sit, how the sliders glide to an option's values, which patch a Content drag writes and where the diagonal
// of the "Match system" miniature falls inside a smaller box. No GPUIX, no daemon: `prefs.test.ts` checks them.
import { BLUR_MAX, type VariantMaterial } from '../platform/translucency.ts'
import { contentSlider, materialPatch } from './model.ts'

// ─── Columns and cards ────────────────────────────────────────────────────

export const SIDE_PAD = 32
export const MAX_WIDTH = 1060
export const COLUMN_GAP = 40
/** Under this window width the two columns stack and the scene scrolls. */
export const STACK_BELOW = 880
export const CARD_GAP = 10
export const CARD_PAD = 6
export const CARD_RADIUS = 18
export const PREVIEW_RADIUS = 12

export interface PrefsLayout {
  /** The width of the content (heading, columns, actions). */
  width: number
  two: boolean
  left: number
  right: number
  /** One card of the three-card rows: its outer width, and the preview inside it. */
  card: number
  preview: { width: number; height: number }
}

/** `minmax(0, 1.15fr) minmax(0, 1fr)`, gap 40, max 1060; one column under 880 px of window. */
export function prefsLayout(windowWidth: number): PrefsLayout {
  const width = Math.max(280, Math.min(MAX_WIDTH, Math.floor(windowWidth) - SIDE_PAD * 2))
  const two = windowWidth >= STACK_BELOW
  const usable = width - COLUMN_GAP
  const left = two ? Math.floor((usable * 1.15) / 2.15) : width
  const right = two ? usable - left : width
  const card = Math.floor((left - CARD_GAP * 2) / 3)
  const pw = card - CARD_PAD * 2
  return { width, two, left, right, card, preview: { width: pw, height: Math.round((pw * 10) / 16) } }
}

/** Rough width of a 13/600 label, to know whether "Translucent sidebar" needs a second line in a narrow card. */
const labelWidth = (text: string) => Math.ceil(text.length * 6.8)
export const LABEL_LINE = 16
export const labelLines = (card: number, labels: readonly string[]) => (labels.every((l) => labelWidth(l) <= card - CARD_PAD * 2) ? 1 : 2)

/** Height of one card: inset, preview, gap, label, inset. */
export const cardHeight = (previewHeight: number, lines: number) => CARD_PAD + previewHeight + 8 + lines * LABEL_LINE + 8

/** The x of the n-th card in a row: where the single ring sits. */
export const cardX = (index: number, card: number) => index * (card + CARD_GAP)

// ─── Permission rows ──────────────────────────────────────────────────────

export const MODE_PAD = 4
/** The longest mode description at 13 px is ~300 px; a narrower text column gives rows room for a second line. */
export const modeRowHeight = (column: number) => (column - MODE_PAD * 2 - 14 * 2 - 30 - 12 >= 316 ? 60 : 78)
export const modeY = (index: number, rowHeight: number) => index * rowHeight

/** Lines the Full access warning takes (12.5 px, about 6.3 px a character) in a column. */
export function warningLines(column: number, length: number): number {
  const room = Math.max(120, column - 8 - 23)
  return Math.max(1, Math.ceil((length * 6.3) / room))
}
export const WARNING_LINE = 18
export const warningHeight = (lines: number) => 10 + lines * WARNING_LINE

// ─── Sliders ──────────────────────────────────────────────────────────────

export type SliderKey = 'sidebar' | 'content' | 'elements' | 'blur'
export type SliderValues = Record<SliderKey, number>
export const SLIDER_KEYS: readonly SliderKey[] = ['sidebar', 'content', 'elements', 'blur']
export const SLIDER_LABEL: Record<SliderKey, string> = { sidebar: 'Sidebar', content: 'Content', elements: 'Elements', blur: 'Blur' }

const easeOut = (t: number) => 1 - (1 - t) ** 3

/** The eased in-between values of a glide, `steps` of them, the last one exactly `to`. Integers; repeated frames collapse. */
export function glideSteps(from: SliderValues, to: SliderValues, steps = 10): SliderValues[] {
  const n = Math.max(1, Math.min(12, Math.floor(steps)))
  const out: SliderValues[] = []
  for (let i = 1; i <= n; i++) {
    const e = i === n ? 1 : easeOut(i / n)
    const frame = Object.fromEntries(SLIDER_KEYS.map((key) => [key, Math.round(from[key] + (to[key] - from[key]) * e)])) as SliderValues
    const last = out[out.length - 1]
    if (!last || SLIDER_KEYS.some((key) => last[key] !== frame[key])) out.push(frame)
  }
  return out
}

/** What a Content drag writes: below 100 is Full translucency (Acrylic on Windows, so a number for blur), 100 is Translucent sidebar (Mica there). */
export function contentPatch(value: number, platform: string = process.platform): Partial<VariantMaterial> {
  const { option, patch } = contentSlider(value)
  if (platform !== 'win32') return patch
  return { ...patch, blur: materialPatch(option, platform).blur ?? null }
}

export const NO_BLUR = BLUR_MAX

// ─── The "Match system" miniature ─────────────────────────────────────────

/** CSS angle of the light | dark split. */
export const SPLIT_ANGLE = 110

/**
 * Where the light | dark boundary of a `SPLIT_ANGLE` gradient across the whole miniature (50 %) falls inside a smaller box
 * placed in it, as that box's own gradient position, so the composer's split lines up with the preview's.
 */
export function splitStop(outer: { width: number; height: number }, inner: { x: number; y: number; width: number; height: number }): number {
  const rad = (SPLIT_ANGLE * Math.PI) / 180
  const sin = Math.sin(rad), cos = Math.cos(rad)
  const dx = inner.x + inner.width / 2 - outer.width / 2
  const dy = inner.y + inner.height / 2 - outer.height / 2
  // Distance of the inner centre from the boundary, along the gradient axis (CSS y runs down, the axis tilts down).
  const along = dx * sin - dy * cos
  const length = Math.abs(inner.width * sin) + Math.abs(inner.height * cos)
  return 0.5 - along / length
}

// ─── Arrow keys ───────────────────────────────────────────────────────────

/** The index an arrow key moves a radio group to (wrapping), or null for any other key. */
export function arrowTarget(key: string, index: number, count: number, axis: 'row' | 'column' | 'both' = 'both'): number | null {
  const forward = key === 'right' || key === 'down'
  const backward = key === 'left' || key === 'up'
  if (axis === 'row' && (key === 'up' || key === 'down')) return null
  if (axis === 'column' && (key === 'left' || key === 'right')) return null
  if (!forward && !backward) return null
  return (index + (forward ? 1 : -1) + count) % count
}
