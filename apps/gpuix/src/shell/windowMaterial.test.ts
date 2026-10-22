import { describe, expect, test } from 'bun:test'
import { DEFAULT_VARIANT_MATERIAL, resolveScope, type ThemeVariant, type VariantMaterial } from '../platform/translucency.ts'
import { backingFor } from './windowMaterial.ts'

type Choice = 'solid' | 'window' | 'sidebar'
const material = (choice: Choice, opacity: number, blur: number | null): VariantMaterial => ({
  material: choice === 'solid' ? 'solid' : 'translucent', opacity, blur, sidebarOnly: choice === 'sidebar',
})
const backing = (variant: ThemeVariant, choice: Choice, opacity: number, blur: number | null, a11y = { reduceTransparency: false, increaseContrast: false }) => {
  const m = material(choice, opacity, blur)
  return backingFor(m, resolveScope(m, a11y, false), variant)
}
const OPAQUE = { mode: 'opaque', radius: 0 } as const

describe('backingFor: the window is opaque exactly when nothing can show through', () => {
  // Explicit, not derived: light Sidebar only has a 100% frame shell at every opacity (the shell ratio is 82/38 and the
  // readability floor is 55); dark Sidebar only peaks at an 89% shell; whole window needs opacity 100.
  const expectOpaque = (variant: ThemeVariant, choice: Choice, opacity: number) =>
    choice === 'solid' || (variant === 'light' && choice === 'sidebar') || (choice === 'window' && opacity === 100)

  for (const variant of ['dark', 'light'] as const) for (const choice of ['solid', 'window', 'sidebar'] as const) for (const opacity of [15, 90, 100]) {
    test(`${variant} ${choice} ${opacity}%`, () => {
      if (expectOpaque(variant, choice, opacity)) {
        expect(backing(variant, choice, opacity, 64)).toEqual(OPAQUE)
        expect(backing(variant, choice, opacity, null)).toEqual(OPAQUE)
      } else {
        expect(backing(variant, choice, opacity, 64)).toEqual({ mode: 'transparent', radius: 64 })
        expect(backing(variant, choice, opacity, 12)).toEqual({ mode: 'transparent', radius: 12 })
        expect(backing(variant, choice, opacity, null)).toEqual({ mode: 'blurred', radius: 0 })
      }
    })
  }

  test('Reduce transparency and Increase contrast win over any glass', () => {
    for (const variant of ['dark', 'light'] as const) for (const choice of ['window', 'sidebar'] as const) for (const opacity of [15, 90, 100]) for (const blur of [64, null]) {
      expect(backing(variant, choice, opacity, blur, { reduceTransparency: true, increaseContrast: false })).toEqual(OPAQUE)
      expect(backing(variant, choice, opacity, blur, { reduceTransparency: false, increaseContrast: true })).toEqual(OPAQUE)
      expect(backing(variant, choice, opacity, blur, { reduceTransparency: true, increaseContrast: true })).toEqual(OPAQUE)
    }
  })

  test('the default: light is opaque, dark keeps the radius-64 blur', () => {
    const m = DEFAULT_VARIANT_MATERIAL
    expect(backingFor(m, resolveScope(m, { reduceTransparency: false, increaseContrast: false }, false), 'light')).toEqual(OPAQUE)
    expect(backingFor(m, resolveScope(m, { reduceTransparency: false, increaseContrast: false }, false), 'dark')).toEqual({ mode: 'transparent', radius: 64 })
  })

  test('the readability floor holds the low end (light window 15% paints 55%, still glass); 99% covers the desktop', () => {
    expect(backing('light', 'window', 15, 64)).toEqual({ mode: 'transparent', radius: 64 })
    // 99% of the desktop covered is the threshold: 1% showing through is not worth a blurred, blended window.
    expect(backing('light', 'window', 98, 64)).toEqual({ mode: 'transparent', radius: 64 })
    expect(backing('light', 'window', 99, 64)).toEqual(OPAQUE)
  })

  test('Blur Auto (the standard material) is a supported backing wherever glass shows', () => {
    // KYBERN_WINDOW_BLUR=auto pins this for the bench.
    expect(backing('dark', 'sidebar', 90, null)).toEqual({ mode: 'blurred', radius: 0 })
    expect(backing('dark', 'window', 15, null)).toEqual({ mode: 'blurred', radius: 0 })
  })
})
