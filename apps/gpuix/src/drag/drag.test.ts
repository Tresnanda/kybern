import { expect, test } from 'bun:test'
import { edgeSpeed } from './edge.ts'
import { summarize } from './pacing.ts'
import { createVelocityTracker } from './velocity.ts'
import { newTops } from '../sidebar/reorder.tsx'

test('edge speed grows with depth and is zero in the middle', () => {
  expect(edgeSpeed(300, 0, 600)).toBe(0)
  const shallow = edgeSpeed(590, 0, 600), deep = edgeSpeed(600, 0, 600), past = edgeSpeed(640, 0, 600)
  expect(shallow).toBeGreaterThan(0)
  expect(deep).toBeGreaterThan(shallow)
  expect(past).toBeGreaterThanOrEqual(deep)
  expect(edgeSpeed(10, 0, 600)).toBeLessThan(0)
})
test('a resting pointer releases with no velocity', async () => {
  const tracker = createVelocityTracker()
  tracker.reset(0, 0)
  tracker.push(10, 10)
  await Bun.sleep(80)
  expect(tracker.velocity()).toEqual({ x: 0, y: 0 })
})
test('pacing summary reports intervals', () => {
  const summary = summarize([0, 10, 20, 50])
  expect(summary.frames).toBe(4)
  expect(summary.max).toBe(30)
})
test('moving a project block lays the others out with 12px gaps', () => {
  const blocks = [{ id: 'a', keys: [], top: 0, height: 100 }, { id: 'b', keys: [], top: 112, height: 50 }, { id: 'c', keys: [], top: 174, height: 70 }]
  const tops = newTops(blocks, 0, 2)
  expect([tops.get(1), tops.get(2), tops.get(0)]).toEqual([0, 62, 144])
  expect(newTops(blocks, 2, 0).get(2)).toBe(0)
})
