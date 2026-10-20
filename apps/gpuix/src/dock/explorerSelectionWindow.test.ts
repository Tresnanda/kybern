import { expect, test } from 'bun:test'
import { treeWindowRange } from './fileTreeMotion.ts'

test('tree mount window stays stable within its buffer and follows keyboard jumps', () => {
  const initial = { start: 0, end: 128 }
  expect(treeWindowRange(10_000, 0, 30, initial)).toBe(initial)
  expect(treeWindowRange(10_000, 60, 90, initial)).toBe(initial)
  const moved = treeWindowRange(10_000, 100, 130, initial)
  expect(moved.start).toBeLessThanOrEqual(100)
  expect(moved.end).toBeGreaterThanOrEqual(130)
  expect(moved.end - moved.start).toBeLessThanOrEqual(192)
  const end = treeWindowRange(10_000, 9999, 10_000, moved)
  expect(end.end).toBe(10_000)
  expect(end.start).toBeLessThan(9999)
  expect(treeWindowRange(10_000, 0, 1, end).start).toBe(0)
})

test('tree mount window clamps a shortened collection and an at-end sentinel', () => {
  expect(treeWindowRange(0, 0, 0, { start: 100, end: 300 })).toEqual({ start: 0, end: 0 })
  const range = treeWindowRange(250, 250, 250, { start: 0, end: 128 })
  expect(range.end).toBe(250)
  expect(range.start).toBeLessThan(250)
})
