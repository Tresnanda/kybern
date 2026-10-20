import { expect, test } from 'bun:test'
import { PATCHED_NATIVE } from '../native/local-build.ts'
import { THEMES } from '../theme.ts'
import { drawerSlide, fadeTo, pressFill, pressRow } from './motion.ts'

const native = PATCHED_NATIVE ? test : test.skip

test('pressFill strengthens a washed fill so a held row is visibly different in both themes', () => {
  const dark = THEMES.dark, light = THEMES.light
  // The sidebar's hover washes are ~4 % alpha white/black: ×1.08 / ×0.96 on their RGB would change nothing visible.
  expect(pressFill(dark, dark.v('--sidebar-accent'))).toBe('rgba(252, 252, 252, 0.086)')
  expect(pressFill(light, light.v('--sidebar-accent'))).toBe('rgba(13, 13, 13, 0.088)')
  expect(pressFill(dark, 'rgba(0, 0, 0, 0.6)')).toBe('rgba(0, 0, 0, 1)')
})

test('pressFill darkens an opaque fill like brightness(0.96) and lightens it like 1.08 in the dark theme; unparseable input is kept', () => {
  expect(pressFill(THEMES.light, '#808080')).toBe('rgba(123, 123, 123, 1)')
  expect(pressFill(THEMES.dark, 'rgb(100, 100, 100)')).toBe('rgba(108, 108, 108, 1)')
  expect(pressFill(THEMES.dark, 'var(--x)')).toBe('var(--x)')
})

test('pressRow puts the held fill under the native `active` state', () => {
  expect(pressRow(THEMES.dark, 'rgba(252, 252, 252, 0.039)')).toEqual({ active: { backgroundColor: 'rgba(252, 252, 252, 0.086)' } })
})

test('drawerSlide opens in 260 ms and closes in 200 ms on the drawer curve', () => {
  expect(drawerSlide(true)).toEqual({ duration: 0.26, ease: [0.32, 0.72, 0, 1] })
  expect(drawerSlide(false)).toEqual({ duration: 0.2, ease: [0.32, 0.72, 0, 1] })
})

native('fadeTo tweens opacity by paint over 150 ms and keeps the style free of opacity', () => {
  const dim = fadeTo(0.4)
  expect(dim.paintTransform).toEqual({ initial: false, animate: { opacity: 0.4 }, transition: { duration: 0.15, ease: [0.23, 1, 0.32, 1] } })
  expect(dim.style).toEqual({})
})
