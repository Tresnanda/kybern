import {expect, test} from 'bun:test'
import {taskWindowRange} from './windowRange.ts'

test('task mount window fills the viewport after quick-add splices and variable card measurement', () => {
  const cards = [99, 171, 153, 81, 81, 63, 63, 63, 63, 63, 63, 63]
  const before = taskWindowRange(cards, 0, 700, 2)
  const open = taskWindowRange([96, ...cards], 0, 700, 2)
  expect(before.end).toBeGreaterThan(7)
  expect(open.end).toBeGreaterThan(7)
  expect(taskWindowRange(cards, 0, 700, 2)).toEqual(before)
})
test('task mount window stays bounded around a scrolled anchor in a large list', () => {
  expect(taskWindowRange(Array(10000).fill(40), 500, 600, 4)).toEqual({start:496, end:520})
  expect(taskWindowRange([], 0, 600, 4)).toEqual({start:0, end:0})
  expect(taskWindowRange([40,40], 100, 600, 4)).toEqual({start:0, end:2})
  expect(taskWindowRange(Array(10000).fill(40), 10000, 600, 4)).toEqual({start:9980, end:10000})
})
