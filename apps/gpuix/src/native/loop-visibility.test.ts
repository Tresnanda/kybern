import { expect, test } from 'bun:test'
import { hasVisiblePaint, hasWholePaint } from './loop-visibility.ts'

const rect = { x: 10, y: 100, width: 14, height: 14 }
test('a loader cut by a list edge is visible but not whole', () => {
  const cut = { rect, clippedRect: { x: 10, y: 100, width: 14, height: 7 } }
  expect(hasVisiblePaint(cut)).toBe(true)
  expect(hasWholePaint(cut)).toBe(false)
  expect(hasWholePaint({ rect, clippedRect: rect })).toBe(true)
  expect(hasWholePaint({ rect, clippedRect: null })).toBe(false)
})
