import { expect, test } from 'bun:test'
import { pixelWindowRange } from './windowRange.ts'

test('sidebar slots cover a partially scrolled viewport and both native overdraw edges', () => {
  const heights = Array.from({ length: 300 }, (_, i) => i % 16 === 0 ? 40 : 30)
  const range = pixelWindowRange(heights.length, i => heights[i]!, 100, 29, 700, 512)
  expect(range.start).toBeLessThan(100)
  expect(heights.slice(range.start, 100).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(512)
  expect(heights.slice(100, range.end).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(700 + 512 + 29)
  expect(range.end - range.start).toBeLessThan(65)
})

test('end anchors fill backwards after collapse and empty slots make forward progress', () => {
  expect(pixelWindowRange(0, () => 30, 0, 0, 700)).toEqual({ start: 0, end: 0 })
  const range = pixelWindowRange(12, () => 30, 300, 0, 700)
  expect(range).toEqual({ start: 0, end: 12 })
  expect(pixelWindowRange(300, () => 0, 0, 0, 20, 0)).toEqual({ start: 0, end: 20 })
})

test('window calculation reads the local neighborhood, not every thread', () => {
  let reads = 0
  const range = pixelWindowRange(30_000, () => { reads++; return 30 }, 15_000, 20, 700)
  expect(reads).toBeLessThan(140)
  expect(range.start).toBeLessThan(15_000)
  expect(range.end).toBeGreaterThan(15_020)
})
