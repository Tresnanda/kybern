import { expect, test } from 'bun:test'
import { glyphRects, isCustomGlyph } from './glyphs.ts'
test('box drawing and blocks fill the cell edge to edge', () => {
  expect(isCustomGlyph(0x2502)).toBe(true); expect(isCustomGlyph(0x41)).toBe(false); expect(isCustomGlyph(0x2571)).toBe(false)
  const vertical = glyphRects(0x2502, 7, 21.5)[0]!, up = glyphRects(0x2502, 7, 21.5)
  expect(up).toHaveLength(2); expect(Math.min(...up.map(r => r.y))).toBe(0); expect(Math.max(...up.map(r => r.y + r.h))).toBeCloseTo(21.5)
  expect(vertical.w).toBe(1)
  expect(glyphRects(0x2588, 7, 21.5)).toEqual([{ x: 0, y: 0, w: 7, h: 21.5 }])
  expect(glyphRects(0x2584, 8, 16)).toEqual([{ x: 0, y: 8, w: 8, h: 8 }])
  expect(glyphRects(0x259a, 8, 16)).toHaveLength(2)
  expect(glyphRects(0x2593, 8, 16)[0]!.alpha).toBe(0.75)
  const corner = glyphRects(0x250c, 7, 21.5)
  expect(corner.map(r => [r.x >= 0, r.w > 0])).toEqual([[true, true], [true, true]])
})
