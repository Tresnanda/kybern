import { expect, test } from 'bun:test'
import { installFrameSource, onFrame } from './frame.ts'

function source() {
  const callbacks = new Map<number, (error: Error | null, event: { timeMs: number }) => void>()
  const removed: number[] = [], acknowledged: number[] = []
  let next = 0
  return {
    callbacks, removed, acknowledged,
    subscribeAnimationFrames(callback: (error: Error | null, event: { timeMs: number }) => void) { callbacks.set(++next, callback); return next },
    acknowledgeAnimationFrame(token: number) { acknowledged.push(token) },
    unsubscribeAnimationFrames(token: number) { removed.push(token) },
    tick(token: number) { callbacks.get(token)!(null, { timeMs: 0 }) },
  }
}

test('one native subscription, shared timestamp, parked after last subscriber', () => {
  const s = source(); installFrameSource(s)
  const a: number[] = [], b: number[] = []
  const stopA = onFrame(now => a.push(now)), stopB = onFrame(now => b.push(now))
  try {
    expect(s.callbacks.size).toBe(1)
    s.tick(1); expect(a).toEqual(b); expect(a.length).toBe(1)
    stopA(); s.tick(1); expect(a.length).toBe(1); expect(b.length).toBe(2)
  } finally { stopA(); stopB() }
  expect(s.removed).toEqual([1])
  s.tick(1); expect(b.length).toBe(2)
})

test('renderer replacement and unsubscribe reject queued old-generation frames', () => {
  const first = source(), second = source(); installFrameSource(first)
  let calls = 0
  const stop = onFrame(() => calls++)
  try {
    installFrameSource(second)
    first.tick(1); expect(calls).toBe(0)
    second.tick(1); expect(calls).toBe(1)
    expect(first.removed).toEqual([1]); expect(second.acknowledged).toEqual([1])
  } finally { stop() }
  second.tick(1); expect(calls).toBe(1)
})

test('unsubscribe within a callback leaves no native lease or stale acknowledgement', () => {
  const s = source(); installFrameSource(s)
  const stop = onFrame(() => stop())
  s.tick(1)
  expect(s.removed).toEqual([1]); expect(s.acknowledged).toEqual([])
})
