// Pixel arithmetic for the round-2 glass checker (`src/platform/verify.glass.ts`), kept free of any display so
// `src/platform/verify.glass.test.ts` covers it.
//
// `screencapture -l <id> -o` keeps the window's own alpha (straight, not premultiplied, in the PNG). Instead of putting a
// black and then a white window behind the app, the checker composites the one RGBA capture over black and over white:
// what a translucent surface would show on a black or a white desktop (the window-server blur of a flat colour is that
// colour). A surface is translucent when its two composites differ (spec §10.2 #4, #5); an opaque one differs by 0.

/** One captured pixel: r, g, b, a in 0…255 (straight alpha). */
export type Rgba = [number, number, number, number]
export type Rgb = [number, number, number]

export interface Image { w: number; h: number; channels: number; data: Uint8Array | Buffer }

/** The pixel at device coordinates; alpha 255 for an RGB capture. */
export function devicePixel(img: Image, x: number, y: number): Rgba {
  const xi = Math.min(img.w - 1, Math.max(0, Math.floor(x))), yi = Math.min(img.h - 1, Math.max(0, Math.floor(y)))
  const i = (yi * img.w + xi) * img.channels
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, img.channels === 4 ? img.data[i + 3]! : 255]
}
/** The pixel under a point in logical (window) coordinates at `scale` device pixels per point. */
export const pointPixel = (img: Image, x: number, y: number, scale = 2): Rgba => devicePixel(img, x * scale, y * scale)

/**
 * The median of a small square of device pixels around a point (per channel): robust against a stray antialiased glyph
 * edge or a 1px hairline crossing the sample. `radius` in device pixels (1 → 3×3).
 */
export function medianPixel(img: Image, x: number, y: number, scale = 2, radius = 1): Rgba {
  const cx = Math.floor(x * scale), cy = Math.floor(y * scale)
  const ch: number[][] = [[], [], [], []]
  for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
    const p = devicePixel(img, cx + dx, cy + dy)
    for (let c = 0; c < 4; c++) ch[c]!.push(p[c]!)
  }
  return ch.map((values) => { values.sort((a, b) => a - b); return values[values.length >> 1]! }) as Rgba
}

/** `p` composited over an opaque backdrop colour. */
export function over(p: Rgba, backdrop: Rgb): Rgb {
  const a = p[3] / 255
  return [0, 1, 2].map((i) => p[i]! * a + backdrop[i]! * (1 - a)) as Rgb
}
export const BLACK: Rgb = [0, 0, 0]
export const WHITE: Rgb = [255, 255, 255]
export const overBlack = (p: Rgba) => over(p, BLACK)
export const overWhite = (p: Rgba) => over(p, WHITE)

/** Largest per-channel difference between two colours. */
export const maxDelta = (a: readonly number[], b: readonly number[]) => Math.max(...[0, 1, 2].map((i) => Math.abs(a[i]! - b[i]!)))
/** How much a pixel changes between a black and a white desktop (max channel): 255 − alpha, in 0…255. */
export const blackWhiteDelta = (p: Rgba) => maxDelta(overBlack(p), overWhite(p))

/** Whether two captured pixels look the same on both a black and a white desktop, within `by` per channel. */
export const sameOnBoth = (a: Rgba, b: Rgba, by: number) => maxDelta(overBlack(a), overBlack(b)) <= by && maxDelta(overWhite(a), overWhite(b)) <= by
/** The worse of the black and white differences between two captured pixels. */
export const deltaOnBoth = (a: Rgba, b: Rgba) => Math.max(maxDelta(overBlack(a), overBlack(b)), maxDelta(overWhite(a), overWhite(b)))

/** sRGB luminance on the 0…255 scale (Rec. 709 weights on the encoded values, as `verify.material.ts`). */
export const luminance = (p: readonly number[]) => 0.2126 * p[0]! + 0.7152 * p[1]! + 0.0722 * p[2]!

/** Parse `#rgb`, `#rrggbb`, `#rrggbbaa` or `rgb()/rgba()` into straight-alpha 0…255 RGBA. */
export function parseCss(css: string): Rgba {
  const s = css.trim()
  if (s === 'transparent') return [0, 0, 0, 0]
  if (s.startsWith('#')) {
    let h = s.slice(1)
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('')
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16)
    return [n(0), n(2), n(4), h.length === 8 ? n(6) : 255]
  }
  const m = s.match(/[\d.]+/g)
  if (!m || m.length < 3) throw Error(`Unrecognised colour ${css}`)
  const [r, g, b, a = '1'] = m
  return [Number(r), Number(g), Number(b), Math.round(Number(a) * 255)]
}

/** Source-over of `top` on `under`, both straight-alpha RGBA (what GPUI's blending does for stacked fills). */
export function stack(top: Rgba, under: Rgba): Rgba {
  const ta = top[3] / 255, ua = under[3] / 255
  const a = ta + ua * (1 - ta)
  if (a === 0) return [0, 0, 0, 0]
  const ch = (i: number) => (top[i]! * ta + under[i]! * ua * (1 - ta)) / a
  return [ch(0), ch(1), ch(2), a * 255]
}

/** Round for printing. */
export const fmt = (p: readonly number[]) => `(${p.map((v) => Math.round(v)).join(',')})`

// ─── Sample-point geometry ─────────────────────────────────────────────────────────────────────────────────────────────

export interface Box { x: number; y: number; width: number; height: number }
export interface Point { x: number; y: number }

/**
 * Spec §10.2 #3: the bottom 49 px of a clamped region and an empty part of the card above it, both in a right-hand column
 * the text does not reach. `inset` keeps clear of the card's right padding.
 */
export function clampBandPoints(clamped: Box, inset = 24): { band: Point[]; above: Point[] } {
  const x = clamped.x + clamped.width - inset
  const bottom = clamped.y + clamped.height
  const band = [6, 16, 26, 36, 46].map((d) => ({ x, y: bottom - d })).filter((p) => p.y > clamped.y)
  const above = [8, 20].map((d) => ({ x, y: clamped.y + d })).filter((p) => p.y < bottom - 49)
  return { band, above }
}

/** A point `inset` points inside a box's left edge, at its vertical middle (clear of centred icons and labels). */
export const leftInterior = (b: Box, inset: number): Point => ({ x: b.x + inset, y: b.y + b.height / 2 })
/** Device-pixel x of the two pixels of a 1 pt left border at 2×, and the row at the box's vertical middle. */
export const leftRimDevice = (b: Box, scale = 2) => ({ xs: [Math.round(b.x * scale), Math.round(b.x * scale) + 1], y: Math.floor((b.y + b.height / 2) * scale) })

/**
 * The segmented-control samples of spec §3.4: the thumb's empty padding inside the selected segment and the bare track,
 * both in the unselected segment's padding and in the gap between the two segments.
 */
export function segmentedPoints(selected: Box, unselected: Box, padX: number) {
  const y = selected.y + selected.height / 2
  const pad = Math.min(4, padX / 2)
  const gapLeft = Math.min(selected.x + selected.width, unselected.x + unselected.width)
  const gapRight = Math.max(selected.x, unselected.x)
  return {
    thumb: { x: selected.x + pad, y },
    trackPad: { x: unselected.x + (unselected.x < selected.x ? pad : unselected.width - pad), y },
    trackGap: gapRight > gapLeft ? { x: (gapLeft + gapRight) / 2, y } : null,
  }
}

/** The expected coat stack of spec §5.3 for one region: the root coat with the region's extra coat (if any) on top. */
export function regionStack(frame: Rgba, extra: Rgba | null): Rgba {
  return extra && extra[3] > 0 ? stack(extra, frame) : frame
}

/** Fraction of pixels whose RGBA differs by more than `by` in any channel; the images must be the same size. */
export function diffFraction(a: Image, b: Image, by = 2): number | null {
  if (a.w !== b.w || a.h !== b.h) return null
  let differ = 0
  const n = a.w * a.h, ca = a.channels, cb = b.channels
  for (let i = 0; i < n; i++) {
    const ia = i * ca, ib = i * cb
    for (let c = 0; c < 4; c++) {
      const va = c < 3 || ca === 4 ? a.data[ia + c]! : 255, vb = c < 3 || cb === 4 ? b.data[ib + c]! : 255
      if (Math.abs(va - vb) > by) { differ++; break }
    }
  }
  return differ / n
}
