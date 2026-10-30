import { expect, spyOn, test } from 'bun:test'
import { installFrameSource, onFrame, resubscribeIfStalled } from './frame.ts'

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

test('a subscription that stops delivering is replaced', () => {
  const s = source(); installFrameSource(s)
  const errors = spyOn(console, 'error').mockImplementation(() => {})
  let calls = 0
  const stop = onFrame(() => calls++)
  try {
    s.tick(1); expect(calls).toBe(1)
    expect(resubscribeIfStalled(performance.now() + 100)).toBe(false)
    // The native entry never got its acknowledge back, so frame 2 never comes.
    expect(resubscribeIfStalled(performance.now() + 1500)).toBe(true)
    expect(s.removed).toEqual([1]); expect(s.callbacks.size).toBe(2)
    s.tick(1); expect(calls).toBe(1)
    s.tick(2); expect(calls).toBe(2); expect(s.acknowledged).toEqual([1, 2])
    expect(errors).toHaveBeenCalledTimes(1)
  } finally { stop(); errors.mockRestore() }
})

test('a throwing acknowledge or unsubscribe cannot wedge the clock', () => {
  const s = source(); installFrameSource(s)
  const errors = spyOn(console, 'error').mockImplementation(() => {})
  s.acknowledgeAnimationFrame = () => { throw Error('GPUI window is not initialized') }
  s.unsubscribeAnimationFrames = () => { throw Error('GPUI window is not initialized') }
  let calls = 0
  const stop = onFrame(() => calls++)
  try {
    expect(() => s.tick(1)).not.toThrow(); expect(calls).toBe(1)
    expect(resubscribeIfStalled(performance.now() + 1500)).toBe(true)
    s.tick(2); expect(calls).toBe(2)
  } finally { stop(); errors.mockRestore() }
  expect(resubscribeIfStalled(performance.now() + 5000)).toBe(false)
})
