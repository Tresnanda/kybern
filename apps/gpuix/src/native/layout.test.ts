import { expect, test } from 'bun:test'
import { observeElementBounds, onWindowResize } from './layout.ts'

test('a host removed before its effect gets one unpainted event and a safe unsubscribe', () => {
  const values: unknown[] = []
  let removals = 0
  const stop = observeElementBounds({ addLayoutObserver() { throw Error('Element is not mounted') }, removeLayoutObserver() { removals++ } }, { id: 42 }, event => values.push(event))
  expect(values).toEqual([{ elementId: 42, rect: null, clippedRect: null, frame: 0 }])
  stop(); stop()
  expect(removals).toBe(0)
})

test('programming errors still reach the caller', () => {
  for (const message of ['Expected element ID', 'Too many layout observers']) {
    expect(() => observeElementBounds({ addLayoutObserver() { throw Error(message) } }, 1, () => {})).toThrow(message)
  }
  expect(() => onWindowResize({ addLayoutObserver() { throw Error('Element is not mounted') } }, () => {})).toThrow()
})

test('queued deliveries after unsubscribe are ignored', () => {
  let callback!: (error: Error | null, value: unknown) => void
  const values: unknown[] = []
  const stop = observeElementBounds({ addLayoutObserver(_target: unknown, cb: typeof callback) { callback = cb; return 3 }, removeLayoutObserver() {} }, 1, e => values.push(e))
  stop(); callback(null, { rect: null })
  expect(values).toEqual([])
})
