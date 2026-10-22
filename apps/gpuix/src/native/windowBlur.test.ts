import { afterEach, describe, expect, test } from 'bun:test'
import { blurCallAvailable, claimTransparentFlags, clampRadius, forgetTransparentFlags, setCgsLoaderForTest, setWindowBlurRadius } from './windowBlur.ts'

afterEach(() => { forgetTransparentFlags(); setCgsLoaderForTest(undefined); delete process.env.KYBERN_WINDOW_BLUR_FAIL })

describe('windowBlur', () => {
  test('clampRadius', () => {
    expect(clampRadius(-5)).toBe(0)
    expect(clampRadius(150)).toBe(100)
    expect(clampRadius(12.4)).toBe(12)
    expect(clampRadius(12.6)).toBe(13)
  })
  test('an unresolved loader reports unavailable without throwing', () => {
    setCgsLoaderForTest(() => null)
    expect(blurCallAvailable()).toBe(false)
    expect(setWindowBlurRadius(64)).toBe('unavailable')
  })
  test('a loader that throws is unavailable, not an error', () => {
    setCgsLoaderForTest(() => { throw new Error('no CGS') })
    expect(setWindowBlurRadius(64)).toBe('unavailable')
  })
  test('KYBERN_WINDOW_BLUR_FAIL=1 fails without calling CGS', () => {
    let called = 0
    setCgsLoaderForTest(() => ({ main: () => { called++; return 1 }, set: () => { called++; return 0 } }))
    process.env.KYBERN_WINDOW_BLUR_FAIL = '1'
    expect(blurCallAvailable()).toBe(false)
    expect(setWindowBlurRadius(64)).toBe('unavailable')
    expect(called).toBe(0)
  })
  test('with no app window there is nothing to blur yet', () => {
    let calls = 0
    setCgsLoaderForTest(() => ({ main: () => 1, set: () => { calls++; return 0 } }))
    expect(setWindowBlurRadius(64)).toBe(process.platform === 'darwin' ? 'not-ready' : 'unavailable')
    expect(calls).toBe(0)
  })
  test('the window flags are set once on entering the transparent mode, not on every radius', () => {
    expect(claimTransparentFlags(7, 64)).toBe(true)
    for (const radius of [60, 40, 12, 1]) expect(claimTransparentFlags(7, radius)).toBe(false)
    // Another window enters on its own.
    expect(claimTransparentFlags(8, 64)).toBe(true)
  })
  test('radius 0 sets no flags, and leaving the mode makes the next blur enter again', () => {
    expect(claimTransparentFlags(7, 0)).toBe(false)
    expect(claimTransparentFlags(7, 30)).toBe(true)
    forgetTransparentFlags()
    expect(claimTransparentFlags(7, 30)).toBe(true)
  })
})
