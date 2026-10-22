import { afterEach, describe, expect, test } from 'bun:test'
import { clampRadius, setCgsLoaderForTest, setWindowBlurRadius } from './windowBlur.ts'

afterEach(() => { setCgsLoaderForTest(undefined); delete process.env.KYBERN_WINDOW_BLUR_FAIL })

describe('windowBlur', () => {
  test('clampRadius', () => {
    expect(clampRadius(-5)).toBe(0)
    expect(clampRadius(150)).toBe(100)
    expect(clampRadius(12.4)).toBe(12)
    expect(clampRadius(12.6)).toBe(13)
  })
  test('an unresolved loader reports false without throwing', () => {
    setCgsLoaderForTest(() => null)
    expect(setWindowBlurRadius(64)).toBe(false)
  })
  test('a loader that throws is unavailable, not an error', () => {
    setCgsLoaderForTest(() => { throw new Error('no CGS') })
    expect(setWindowBlurRadius(64)).toBe(false)
  })
  test('KYBERN_WINDOW_BLUR_FAIL=1 fails without calling CGS', () => {
    let called = 0
    setCgsLoaderForTest(() => ({ main: () => { called++; return 1 }, set: () => { called++; return 0 } }))
    process.env.KYBERN_WINDOW_BLUR_FAIL = '1'
    expect(setWindowBlurRadius(64)).toBe(false)
    expect(called).toBe(0)
  })
  test('with no app window there is nothing to blur', () => {
    let calls = 0
    setCgsLoaderForTest(() => ({ main: () => 1, set: () => { calls++; return 0 } }))
    expect(setWindowBlurRadius(64)).toBe(false)
    expect(calls).toBe(0)
  })
})
