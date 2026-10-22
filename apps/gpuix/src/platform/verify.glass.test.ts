// Display-free pieces of `verify.glass.ts`: the black/white compositing, the luminance sampling and the sample-point math.
import { describe, expect, test } from 'bun:test'
import {
  blackWhiteDelta, clampBandPoints, deltaOnBoth, diffFraction, leftInterior, leftRimDevice, luminance, maxDelta, medianPixel, over,
  overBlack, overWhite, parseCss, pointPixel, regionStack, sameOnBoth, segmentedPoints, stack, type Image, type Rgba,
} from '../../perf/glass/pixels.ts'
import { THEMES, materialFor, stack as themeStack } from '../theme.ts'

const image = (w: number, h: number, fill: Rgba): Image => {
  const data = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) data.set(fill, i * 4)
  return { w, h, channels: 4, data }
}

describe('compositing over a black and a white desktop', () => {
  test('an opaque pixel is the same on both', () => {
    const p: Rgba = [40, 50, 60, 255]
    expect(overBlack(p)).toEqual([40, 50, 60])
    expect(overWhite(p)).toEqual([40, 50, 60])
    expect(blackWhiteDelta(p)).toBe(0)
  })
  test('a clear pixel is the desktop', () => {
    expect(overBlack([200, 10, 10, 0])).toEqual([0, 0, 0])
    expect(overWhite([200, 10, 10, 0])).toEqual([255, 255, 255])
    expect(blackWhiteDelta([200, 10, 10, 0])).toBe(255)
  })
  test('the black/white difference is 255 − alpha in every channel', () => {
    for (const a of [3, 64, 128, 229, 252]) expect(blackWhiteDelta([90, 90, 90, a])).toBeCloseTo(255 - a, 6)
  })
  test('over() is straight-alpha source-over', () => {
    expect(over([255, 0, 0, 128], [0, 0, 255])).toEqual([128, 0, 127]) // 255·128/255, 0, 255·127/255
  })
  test('sameOnBoth and deltaOnBoth', () => {
    expect(sameOnBoth([10, 10, 10, 230], [12, 11, 10, 230], 2)).toBe(true)
    expect(sameOnBoth([10, 10, 10, 230], [10, 10, 10, 255], 3)).toBe(false) // same RGB, but one lets the desktop through
    expect(deltaOnBoth([10, 10, 10, 230], [10, 10, 10, 255])).toBeCloseTo(25 * (245 / 255), 6)
  })
})

describe('stacking fills', () => {
  test('matches theme.ts stack()', () => {
    // parseCss quantizes alpha to 1/255, so the two agree to within a unit.
    const s = stack(parseCss('rgba(255, 255, 255, 0.045)'), parseCss('rgba(20, 20, 20, 0.9)'))
    const ref = parseCss(themeStack('rgba(255, 255, 255, 0.045)', 'rgba(20, 20, 20, 0.9)'))
    for (let i = 0; i < 4; i++) expect(Math.abs(s[i]! - ref[i]!)).toBeLessThanOrEqual(1)
    expect(s[3] / 255).toBeCloseTo(0.045 + 0.9 * 0.955, 2)
  })
  test('an opaque top hides everything', () => expect(stack([1, 2, 3, 255], [200, 200, 200, 255])).toEqual([1, 2, 3, 255]))
  test('regionStack: no extra coat is the root coat', () => {
    expect(regionStack([10, 10, 10, 230], null)).toEqual([10, 10, 10, 230])
    expect(regionStack([10, 10, 10, 230], [10, 10, 10, 0])).toEqual([10, 10, 10, 230])
  })
  test('§5.3: the root coat plus the extra coat reads as coat(v)', () => {
    // r = 60, v = 90 → x = (90 − 60) / 40 = 75%: 0.75 + 0.6 · 0.25 = 0.9.
    const s = regionStack([24, 24, 24, 0.6 * 255], [24, 24, 24, 0.75 * 255])
    expect(s[3] / 255).toBeCloseTo(0.9, 6)
    expect(s[0]).toBeCloseTo(24, 6)
  })
})

describe('parseCss', () => {
  test('hex forms', () => {
    expect(parseCss('#fff')).toEqual([255, 255, 255, 255])
    expect(parseCss('#101010')).toEqual([16, 16, 16, 255])
    expect(parseCss('#10101080')).toEqual([16, 16, 16, 128])
  })
  test('rgb and rgba', () => {
    expect(parseCss('rgb(1, 2, 3)')).toEqual([1, 2, 3, 255])
    expect(parseCss('rgba(46, 46, 46, 0.92)')).toEqual([46, 46, 46, 235])
    expect(parseCss('transparent')).toEqual([0, 0, 0, 0])
  })
  test('every resolved theme token parses', () => {
    for (const variant of ['dark', 'light'] as const) {
      const g = materialFor(variant, 'window', 90, 90).glass
      for (const css of [g.raised, g.band, g.rim, g.frost, g.frostMenu, g.frostRim, g.denseFloat, g.recess, THEMES[variant].content, THEMES[variant].surface]) expect(parseCss(css)[3]).toBeGreaterThan(0)
    }
  })
})

describe('luminance sampling', () => {
  test('Rec. 709 weights on the encoded values', () => {
    expect(luminance([255, 255, 255])).toBeCloseTo(255, 6)
    expect(luminance([0, 0, 0])).toBe(0)
    expect(luminance([63, 63, 63])).toBeCloseTo(63, 6)
    expect(luminance([0, 255, 0])).toBeCloseTo(0.7152 * 255, 6)
  })
  test('the dark thumb (#3f3f3f) clears a black-composited dark recess by more than 14', () => {
    const coat = parseCss(materialFor('dark', 'window', 90, 90).frame)
    const card = stack(parseCss(materialFor('dark', 'window', 90, 90).glass.raised), coat)
    const track = stack(parseCss(materialFor('dark', 'window', 90, 90).glass.recess), card)
    expect(luminance(overBlack([63, 63, 63, 255])) - luminance(overBlack(track))).toBeGreaterThanOrEqual(14)
  })
})

describe('pixel reads', () => {
  test('point coordinates are scaled to device pixels', () => {
    const img = image(10, 10, [0, 0, 0, 255])
    img.data.set([9, 8, 7, 6], (4 * 10 + 6) * 4)
    expect(pointPixel(img, 3, 2)).toEqual([9, 8, 7, 6])
    expect(pointPixel(img, 3.4, 2.2)).toEqual([9, 8, 7, 6])
  })
  test('reads are clamped to the image', () => expect(pointPixel(image(4, 4, [1, 2, 3, 4]), 100, -5)).toEqual([1, 2, 3, 4]))
  test('the median ignores a stray pixel', () => {
    const img = image(10, 10, [20, 20, 20, 255])
    img.data.set([255, 255, 255, 255], (5 * 10 + 5) * 4)
    expect(medianPixel(img, 2.5, 2.5)).toEqual([20, 20, 20, 255])
  })
  test('RGB captures read as opaque', () => {
    const img: Image = { w: 1, h: 1, channels: 3, data: new Uint8Array([4, 5, 6]) }
    expect(pointPixel(img, 0, 0)).toEqual([4, 5, 6, 255])
  })
  test('diffFraction', () => {
    const a = image(4, 4, [10, 10, 10, 255]), b = image(4, 4, [10, 10, 10, 255])
    expect(diffFraction(a, b)).toBe(0)
    b.data.set([14, 10, 10, 255], 0)
    expect(diffFraction(a, b)).toBe(1 / 16)
    expect(diffFraction(a, b, 4)).toBe(0)
    expect(diffFraction(a, image(2, 2, [0, 0, 0, 0]))).toBeNull()
  })
})

describe('sample-point math', () => {
  test('the clamp band sits in the bottom 49 px, the reference above it, both in the right column', () => {
    const box = { x: 100, y: 200, width: 600, height: 159.25 }
    const { band, above } = clampBandPoints(box)
    for (const p of band) { expect(p.x).toBe(676); expect(p.y).toBeGreaterThanOrEqual(359.25 - 49); expect(p.y).toBeLessThan(359.25) }
    for (const p of above) { expect(p.x).toBe(676); expect(p.y).toBeLessThan(359.25 - 49); expect(p.y).toBeGreaterThan(200) }
    expect(band.length).toBe(5)
    expect(above.length).toBe(2)
  })
  test('a short clamp keeps the reference points out of the band', () => {
    const { above } = clampBandPoints({ x: 0, y: 0, width: 100, height: 60 })
    expect(above.every((p) => p.y < 11)).toBe(true)
  })
  test('left interior and rim', () => {
    expect(leftInterior({ x: 10, y: 20, width: 100, height: 40 }, 6)).toEqual({ x: 16, y: 40 })
    expect(leftRimDevice({ x: 10, y: 20, width: 100, height: 40 })).toEqual({ xs: [20, 21], y: 80 })
  })
  test('segmented: thumb padding, track padding and the gap', () => {
    // Solid | Translucent, Translucent selected, 2 pt gap.
    const solid = { x: 100, y: 50, width: 60, height: 24 }, translucent = { x: 162, y: 50, width: 90, height: 24 }
    const p = segmentedPoints(translucent, solid, 10)
    expect(p.thumb).toEqual({ x: 166, y: 62 })
    expect(p.trackPad).toEqual({ x: 104, y: 62 })
    expect(p.trackGap).toEqual({ x: 161, y: 62 })
    // Solid selected: the track sample moves to the right-hand segment's far padding.
    const q = segmentedPoints(solid, translucent, 10)
    expect(q.thumb).toEqual({ x: 104, y: 62 })
    expect(q.trackPad).toEqual({ x: 248, y: 62 })
    expect(segmentedPoints(solid, { ...translucent, x: 160 }, 10).trackGap).toBeNull()
  })
  test('maxDelta', () => expect(maxDelta([1, 2, 3], [4, 2, 1])).toBe(3))
})
