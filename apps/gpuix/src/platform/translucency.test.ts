import { describe, expect, test } from 'bun:test'
import { DEFAULT_THEME_STATE, buildThemeCssVariables } from '../../../desktop/src/lib/kit/theme/theme.logic.ts'
import { THEMES, derivedThemeCount, themeFor } from '../theme.ts'
import {
  DEFAULT_VARIANT_MATERIAL, OPACITY_MIN, SIDEBAR_ONLY_PANEL_GLASS, materialFormulas, materialVars, migrateWindow, normalizeVariantMaterial, resolveScope,
  type ThemeVariant, type VariantMaterial,
} from './translucency.ts'

const opaque = (variant: ThemeVariant) => buildThemeCssVariables(
  { codeThemeId: DEFAULT_THEME_STATE.codeThemeIds[variant], theme: DEFAULT_THEME_STATE.chromeThemes[variant] },
  variant, { electron: true, isMac: false, systemUiFont: true },
).variables as Record<string, string>
const none = { reduceTransparency: false, increaseContrast: false }
const glass = (over: Partial<VariantMaterial> = {}): VariantMaterial => ({ ...DEFAULT_VARIANT_MATERIAL, material: 'translucent', sidebarOnly: false, ...over })
const themed = (variant: ThemeVariant, scope: 'none' | 'sidebar' | 'window', opacity: number) => themeFor(variant, scope, opacity, false, false)

describe('formulas (default 90%)', () => {
  test('dark', () => {
    const t = themed('dark', 'window', 90)
    expect(t.glass.window).toBe('rgba(19, 19, 19, 0.9)')
    expect(t.glass.raised).toBe('rgba(46, 46, 46, 0.55)')
    expect(t.glass.dense).toBe('rgba(46, 46, 46, 0.96)')
    expect(themed('dark', 'sidebar', 90).frame).toBe('rgba(45, 45, 45, 0.8)')
    expect(themed('dark', 'sidebar', 90).sidebar).toBe('rgba(19, 19, 19, 0.9)')
  })
  test('light', () => {
    const t = themed('light', 'window', 90)
    expect(t.glass.window).toBe('rgba(255, 255, 255, 0.9)')
    expect(t.glass.raised).toBe('rgba(255, 255, 255, 0.31)')
    expect(t.glass.dense).toBe('rgba(255, 255, 255, 0.96)')
    expect(themed('light', 'sidebar', 90).frame).toBe('rgba(235, 235, 235, 1)')
  })
  test('Solid keeps the opaque tokens', () => {
    expect([THEMES.dark.frame, THEMES.dark.sidebar, THEMES.dark.content]).toEqual(['#2d2d2d', '#212121', '#181818'])
    expect([THEMES.light.frame, THEMES.light.sidebar, THEMES.light.content]).toEqual(['#ebebeb', '#f5f5f5', '#ffffff'])
    expect(THEMES.dark.glass.window).toBe('#2d2d2d')
    expect(THEMES.dark.glass.menu).toBe(THEMES.dark.popover)
  })
  test('the reference vectors', () => {
    expect(materialFormulas('dark', opaque('dark'), 72).raisedPercent).toBe(46)
    expect(materialFormulas('light', opaque('light'), 38).raisedPercent).toBe(15)
    expect(materialFormulas('dark', opaque('dark'), 72).shellPercent).toBe(64)
    expect(materialFormulas('light', opaque('light'), 38).shellPercent).toBe(82)
    expect(materialFormulas('light', opaque('light'), 90).shellPercent).toBe(100)
  })
  test('every opacity resolves to a real color, dark and light', () => {
    for (const variant of ['dark', 'light'] as const) for (const o of [15, 38, 72, 90, 100]) {
      const t = themed(variant, 'window', o)
      for (const color of [t.glass.window, t.glass.raised, t.glass.dense]) expect(color).toMatch(/^rgba\(\d+, \d+, \d+, [\d.]+\)$/)
      const alpha = Number(t.glass.window.match(/([\d.]+)\)$/)![1])
      expect(alpha).toBeCloseTo(o / 100, 2)
    }
  })
})

describe('resolveScope', () => {
  test('truth table', () => {
    for (const material of ['solid', 'translucent'] as const) for (const sidebarOnly of [false, true])
      for (const reduceTransparency of [false, true]) for (const increaseContrast of [false, true]) for (const opaqueWindow of [false, true]) {
        const expected = opaqueWindow || reduceTransparency || increaseContrast || material === 'solid' ? 'none' : sidebarOnly ? 'sidebar' : 'window'
        expect(resolveScope(glass({ material, sidebarOnly }), { reduceTransparency, increaseContrast }, opaqueWindow)).toBe(expected)
      }
  })
})

describe('materialVars', () => {
  const O = opaque('dark')
  test('none changes only the content surface', () => {
    expect(materialVars('dark', O, 'none', 90)).toEqual({ '--app-content-surface': O['--color-background-surface'] })
  })
  test('whole window: one coat on the frame, everything above it clear', () => {
    const v = materialVars('dark', O, 'window', 90)
    expect(v['--app-frame-surface']).toContain('color-mix')
    expect(v['--app-sidebar-surface']).toBe('transparent')
    expect(v['--app-content-surface']).toBe('transparent')
  })
  test('Sidebar only: shell frame, glass panel, opaque content', () => {
    const v = materialVars('dark', O, 'sidebar', 90)
    expect(v['--app-frame-surface']).not.toBe(materialVars('dark', O, 'window', 90)['--app-frame-surface'])
    expect(v['--app-sidebar-surface']).toBe(materialVars('dark', O, 'window', 90)['--app-frame-surface'])
    expect(v['--app-content-surface']).toBe(O['--color-background-surface'])
    expect(SIDEBAR_ONLY_PANEL_GLASS).toBe(true)
  })
  test('the control fill is never overridden', () => {
    for (const variant of ['dark', 'light'] as const) for (const scope of ['none', 'sidebar', 'window'] as const)
      expect(materialVars(variant, opaque(variant), scope, 50)).not.toHaveProperty('--color-background-surface')
  })
})

describe('theme cache', () => {
  test('stays bounded across a drag, and window glass is clear while controls stay opaque', () => {
    for (let o = 15; o <= 100; o++) themeFor('dark', 'window', o, false, false)
    expect(derivedThemeCount()).toBeLessThanOrEqual(16)
    expect(THEMES.dark.surface).toBe('#181818')
    const t = themeFor('dark', 'window', 90, false, false)
    expect(t.content).toBe('rgba(0, 0, 0, 0)')
    expect(t.surface).toBe('#181818')
    expect(t.scope).toBe('window')
  })
  test('Increase contrast and Reduce transparency keep the opaque scope but their own theme', () => {
    expect(themeFor('dark', 'none', 90, true, false).contrast).toBe(true)
    expect(themeFor('dark', 'none', 40, true, false)).toBe(themeFor('dark', 'none', 90, true, false))
  })
})

describe('normalizeVariantMaterial', () => {
  test('edge cases', () => {
    expect(normalizeVariantMaterial({ opacity: 3 }).opacity).toBe(OPACITY_MIN)
    expect(normalizeVariantMaterial({ opacity: 140 }).opacity).toBe(100)
    expect(normalizeVariantMaterial({ opacity: 12.6 }).opacity).toBe(15)
    expect(normalizeVariantMaterial({ opacity: 40.6 }).opacity).toBe(41)
    expect(normalizeVariantMaterial({ opacity: '90' }).opacity).toBe(90)
    expect(normalizeVariantMaterial({ blur: 0 }).blur).toBe(1)
    expect(normalizeVariantMaterial({ blur: 99 }).blur).toBe(64)
    expect(normalizeVariantMaterial({ blur: null }).blur).toBeNull()
    expect(normalizeVariantMaterial({ blur: 'x' }).blur).toBe(64)
    expect(normalizeVariantMaterial({ blur: Number.NaN }).blur).toBe(64)
    expect(normalizeVariantMaterial({ sidebarOnly: 1 }).sidebarOnly).toBe(DEFAULT_VARIANT_MATERIAL.sidebarOnly)
    expect(normalizeVariantMaterial({ material: 'solid' }).material).toBe('solid')
    expect(normalizeVariantMaterial({ material: 'glass' }).material).toBe('translucent')
    expect(normalizeVariantMaterial(null)).toEqual(DEFAULT_VARIANT_MATERIAL)
    expect(normalizeVariantMaterial([])).toEqual(DEFAULT_VARIANT_MATERIAL)
  })
})

describe('migrateWindow', () => {
  test('first launch and the old off state follow the default', () => {
    for (const saved of [undefined, null, 'x', {}, { theme: 'dark' }, { translucent: false }])
      expect(migrateWindow(saved)).toEqual({ dark: DEFAULT_VARIANT_MATERIAL, light: DEFAULT_VARIANT_MATERIAL })
  })
  test('the old switch on keeps glass content, whole window', () => {
    const glassContent: VariantMaterial = { material: 'translucent', opacity: 90, blur: 64, sidebarOnly: false }
    expect(migrateWindow({ translucent: true })).toEqual({ dark: glassContent, light: glassContent })
  })
  test('version 2 normalizes per variant and fills a missing one', () => {
    const w = migrateWindow({ version: 2, window: { dark: { material: 'solid', opacity: 1, blur: null, sidebarOnly: true } } })
    expect(w.dark).toEqual({ material: 'solid', opacity: 15, blur: null, sidebarOnly: true })
    expect(w.light).toEqual(DEFAULT_VARIANT_MATERIAL)
  })
})
