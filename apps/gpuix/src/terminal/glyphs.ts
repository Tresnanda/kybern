/**
 * Box drawing (U+2500-257F) and block elements (U+2580-259F), drawn as rectangles that fill the
 * whole cell like xterm.js's `customGlyphs: true`; a font glyph is shorter than the 1.35 line
 * height, so vertical lines and blocks would leave gaps between rows.
 */
export interface GlyphRect { x: number; y: number; w: number; h: number; alpha?: number }
// [left, right, up, down] line weights: 0 none, 1 light, 2 heavy, 3 double.
const BOX: Record<number, [number, number, number, number]> = {
  0x2500: [1, 1, 0, 0], 0x2501: [2, 2, 0, 0], 0x2502: [0, 0, 1, 1], 0x2503: [0, 0, 2, 2],
  0x2504: [1, 1, 0, 0], 0x2505: [2, 2, 0, 0], 0x2506: [0, 0, 1, 1], 0x2507: [0, 0, 2, 2], 0x2508: [1, 1, 0, 0], 0x2509: [2, 2, 0, 0], 0x250a: [0, 0, 1, 1], 0x250b: [0, 0, 2, 2],
  0x250c: [0, 1, 0, 1], 0x250d: [0, 2, 0, 1], 0x250e: [0, 1, 0, 2], 0x250f: [0, 2, 0, 2],
  0x2510: [1, 0, 0, 1], 0x2511: [2, 0, 0, 1], 0x2512: [1, 0, 0, 2], 0x2513: [2, 0, 0, 2],
  0x2514: [0, 1, 1, 0], 0x2515: [0, 2, 1, 0], 0x2516: [0, 1, 2, 0], 0x2517: [0, 2, 2, 0],
  0x2518: [1, 0, 1, 0], 0x2519: [2, 0, 1, 0], 0x251a: [1, 0, 2, 0], 0x251b: [2, 0, 2, 0],
  0x251c: [0, 1, 1, 1], 0x251d: [0, 2, 1, 1], 0x251e: [0, 1, 2, 1], 0x251f: [0, 1, 1, 2], 0x2520: [0, 1, 2, 2], 0x2521: [0, 2, 2, 1], 0x2522: [0, 2, 1, 2], 0x2523: [0, 2, 2, 2],
  0x2524: [1, 0, 1, 1], 0x2525: [2, 0, 1, 1], 0x2526: [1, 0, 2, 1], 0x2527: [1, 0, 1, 2], 0x2528: [1, 0, 2, 2], 0x2529: [2, 0, 2, 1], 0x252a: [2, 0, 1, 2], 0x252b: [2, 0, 2, 2],
  0x252c: [1, 1, 0, 1], 0x252d: [2, 1, 0, 1], 0x252e: [1, 2, 0, 1], 0x252f: [2, 2, 0, 1], 0x2530: [1, 1, 0, 2], 0x2531: [2, 1, 0, 2], 0x2532: [1, 2, 0, 2], 0x2533: [2, 2, 0, 2],
  0x2534: [1, 1, 1, 0], 0x2535: [2, 1, 1, 0], 0x2536: [1, 2, 1, 0], 0x2537: [2, 2, 1, 0], 0x2538: [1, 1, 2, 0], 0x2539: [2, 1, 2, 0], 0x253a: [1, 2, 2, 0], 0x253b: [2, 2, 2, 0],
  0x253c: [1, 1, 1, 1], 0x253d: [2, 1, 1, 1], 0x253e: [1, 2, 1, 1], 0x253f: [2, 2, 1, 1], 0x2540: [1, 1, 2, 1], 0x2541: [1, 1, 1, 2], 0x2542: [1, 1, 2, 2], 0x2543: [2, 1, 2, 1], 0x2544: [1, 2, 2, 1], 0x2545: [2, 1, 1, 2], 0x2546: [1, 2, 1, 2], 0x2547: [2, 2, 2, 1], 0x2548: [2, 2, 1, 2], 0x2549: [2, 1, 2, 2], 0x254a: [1, 2, 2, 2], 0x254b: [2, 2, 2, 2],
  0x254c: [1, 1, 0, 0], 0x254d: [2, 2, 0, 0], 0x254e: [0, 0, 1, 1], 0x254f: [0, 0, 2, 2],
  0x2550: [3, 3, 0, 0], 0x2551: [0, 0, 3, 3], 0x2552: [0, 3, 0, 1], 0x2553: [0, 1, 0, 3], 0x2554: [0, 3, 0, 3], 0x2555: [3, 0, 0, 1], 0x2556: [1, 0, 0, 3], 0x2557: [3, 0, 0, 3],
  0x2558: [0, 3, 1, 0], 0x2559: [0, 1, 3, 0], 0x255a: [0, 3, 3, 0], 0x255b: [3, 0, 1, 0], 0x255c: [1, 0, 3, 0], 0x255d: [3, 0, 3, 0],
  0x255e: [0, 3, 1, 1], 0x255f: [0, 1, 3, 3], 0x2560: [0, 3, 3, 3], 0x2561: [3, 0, 1, 1], 0x2562: [1, 0, 3, 3], 0x2563: [3, 0, 3, 3],
  0x2564: [3, 3, 0, 1], 0x2565: [1, 1, 0, 3], 0x2566: [3, 3, 0, 3], 0x2567: [3, 3, 1, 0], 0x2568: [1, 1, 3, 0], 0x2569: [3, 3, 3, 0], 0x256a: [3, 3, 1, 1], 0x256b: [1, 1, 3, 3], 0x256c: [3, 3, 3, 3],
  0x256d: [0, 1, 0, 1], 0x256e: [1, 0, 0, 1], 0x256f: [1, 0, 1, 0], 0x2570: [0, 1, 1, 0],
  0x2574: [1, 0, 0, 0], 0x2575: [0, 0, 1, 0], 0x2576: [0, 1, 0, 0], 0x2577: [0, 0, 0, 1], 0x2578: [2, 0, 0, 0], 0x2579: [0, 0, 2, 0], 0x257a: [0, 2, 0, 0], 0x257b: [0, 0, 0, 2],
  0x257c: [1, 2, 0, 0], 0x257d: [0, 0, 1, 2], 0x257e: [2, 1, 0, 0], 0x257f: [0, 0, 2, 1],
}
/** Quadrants for U+2596-259F as [upper-left, upper-right, lower-left, lower-right]. */
const QUADRANTS: Record<number, [number, number, number, number]> = {
  0x2596: [0, 0, 1, 0], 0x2597: [0, 0, 0, 1], 0x2598: [1, 0, 0, 0], 0x2599: [1, 0, 1, 1], 0x259a: [1, 0, 0, 1], 0x259b: [1, 1, 1, 0], 0x259c: [1, 1, 0, 1], 0x259d: [0, 1, 0, 0], 0x259e: [0, 1, 1, 0], 0x259f: [0, 1, 1, 1],
}
export const isCustomGlyph = (cp: number) => (cp >= 0x2500 && cp <= 0x259f) && (cp in BOX || (cp >= 0x2580 && cp <= 0x259f))
const THICKNESS = [0, 1, 3, 1]
/** Rectangles, in cell pixels, that draw the glyph; empty when the font should draw it. */
export function glyphRects(cp: number, w: number, h: number): GlyphRect[] {
  if (cp >= 0x2580 && cp <= 0x259f) {
    if (cp === 0x2580) return [{ x: 0, y: 0, w, h: h / 2 }]
    if (cp >= 0x2581 && cp <= 0x2588) { const n = (cp - 0x2580) / 8; return [{ x: 0, y: h * (1 - n), w, h: h * n }] }
    if (cp >= 0x2589 && cp <= 0x258f) { const n = (0x2590 - cp) / 8; return [{ x: 0, y: 0, w: w * n, h }] }
    if (cp === 0x2590) return [{ x: w / 2, y: 0, w: w / 2, h }]
    if (cp >= 0x2591 && cp <= 0x2593) return [{ x: 0, y: 0, w, h, alpha: (cp - 0x2590) / 4 }]
    if (cp === 0x2594) return [{ x: 0, y: 0, w, h: h / 8 }]
    if (cp === 0x2595) return [{ x: w * 7 / 8, y: 0, w: w / 8, h }]
    const q = QUADRANTS[cp]
    if (!q) return []
    return q.flatMap((on, i) => on ? [{ x: i % 2 ? w / 2 : 0, y: i < 2 ? 0 : h / 2, w: w / 2, h: h / 2 }] : [])
  }
  const weights = BOX[cp]
  if (!weights) return []
  const [left, right, up, down] = weights
  const cx = Math.floor(w / 2), cy = Math.floor(h / 2) + (Math.floor(h / 2) * 2 === Math.floor(h) ? 0 : 0.5)
  const rects: GlyphRect[] = []
  const line = (direction: 'l' | 'r' | 'u' | 'd', weight: number) => {
    if (!weight) return
    const lines = weight === 3 ? [-1.5, 1.5] : [0], t = THICKNESS[weight]!
    for (const offset of lines) {
      const mid = (direction === 'l' || direction === 'r' ? cy : cx) + offset - t / 2 + (weight === 3 ? 0.5 : 0)
      if (direction === 'l') rects.push({ x: 0, y: mid, w: cx + t / 2 + (weight === 3 ? 1.5 : 0), h: t })
      else if (direction === 'r') rects.push({ x: cx - t / 2 - (weight === 3 ? 1.5 : 0), y: mid, w: w - (cx - t / 2 - (weight === 3 ? 1.5 : 0)), h: t })
      else if (direction === 'u') rects.push({ x: mid, y: 0, w: t, h: cy + t / 2 + (weight === 3 ? 1.5 : 0) })
      else rects.push({ x: mid, y: cy - t / 2 - (weight === 3 ? 1.5 : 0), w: t, h: h - (cy - t / 2 - (weight === 3 ? 1.5 : 0)) })
    }
  }
  line('l', left); line('r', right); line('u', up); line('d', down)
  return rects
}
