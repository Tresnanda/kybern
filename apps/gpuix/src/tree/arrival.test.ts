import { expect, test } from 'bun:test'
import { ARRIVAL, nextArrival } from './Tree.tsx'

// Review 2026-10-23: arrivals queued 65 ms apart without a bound, so a burst (a reconnect's catch-up of 30 calls) waited ~2 s.
test('arrivals stagger 65 ms apart, start at once after a pause, and a burst never waits longer than the cap', () => {
  expect(nextArrival(0, 10_000)).toBe(10_000)
  expect(nextArrival(10_000, 10_000)).toBe(10_000 + ARRIVAL.stagger * 1000)
  let last = 0
  const starts: number[] = []
  for (let i = 0; i < 30; i++) starts.push((last = nextArrival(last, 50_000)))
  expect(starts[1]! - starts[0]!).toBeCloseTo(ARRIVAL.stagger * 1000)
  expect(Math.max(...starts) - 50_000).toBeCloseTo(ARRIVAL.cap * 1000)
})
