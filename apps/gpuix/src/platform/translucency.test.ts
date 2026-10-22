import { describe, expect, test } from 'bun:test'
import { DEFAULT_THEME_STATE, buildThemeCssVariables } from '../../../desktop/src/lib/kit/theme/theme.logic.ts'
import { THEMES, derivedThemeCount, materialFor, stack, themeFor, windowCoverage } from '../theme.ts'
import {
  DEFAULT_VARIANT_MATERIAL, OPACITY_MIN, OPACITY_VARS, SIDEBAR_ONLY_PANEL_GLASS, coatFloor, effectiveOpacity, materialCoverage, materialFormulas, materialVars, migrateWindow,
  normalizeVariantMaterial, resolveScope, type ThemeVariant, type VariantMaterial, type WindowScope,
} from './translucency.ts'

const opaque = (variant: ThemeVariant) => buildThemeCssVariables(
  { codeThemeId: DEFAULT_THEME_STATE.codeThemeIds[variant], theme: DEFAULT_THEME_STATE.chromeThemes[variant] },
  variant, { electron: true, isMac: false, systemUiFont: true },
).variables as Record<string, string>
const none = { reduceTransparency: false, increaseContrast: false }
const glass = (over: Partial<VariantMaterial> = {}): VariantMaterial => ({ ...DEFAULT_VARIANT_MATERIAL, material: 'translucent', sidebarOnly: false, ...over })
const fills = (variant: ThemeVariant, scope: WindowScope, opacity: number) => materialFor(variant, scope, opacity)
const FLOOR = { dark: 65, light: 55 } as const

describe('formulas (default 90%)', () => {
  test('dark', () => {
    expect(fills('dark', 'window', 90).frame).toBe('rgba(19, 19, 19, 0.9)')
    expect(fills('dark', 'window', 90).menu).toBe('rgba(46, 46, 46, 0.55)')
    expect(themeFor('dark', 'window', false, false).glass.dense).toBe('rgba(46, 46, 46, 0.96)')
    expect(fills('dark', 'sidebar', 90).frame).toBe('rgba(45, 45, 45, 0.8)')
    expect(fills('dark', 'sidebar', 90).sidebar).toBe('rgba(19, 19, 19, 0.9)')
  })
  test('light', () => {
    expect(fills('light', 'window', 90).frame).toBe('rgba(255, 255, 255, 0.9)')
    expect(fills('light', 'window', 90).menu).toBe('rgba(255, 255, 255, 0.31)')
    expect(themeFor('light', 'window', false, false).glass.dense).toBe('rgba(255, 255, 255, 0.96)')
    expect(fills('light', 'sidebar', 90).frame).toBe('rgba(235, 235, 235, 1)')
  })
  test('Solid keeps the opaque tokens', () => {
    expect([fills('dark', 'none', 100).frame, fills('dark', 'none', 100).sidebar, THEMES.dark.content]).toEqual(['#2d2d2d', '#212121', '#181818'])
    expect([fills('light', 'none', 100).frame, fills('light', 'none', 100).sidebar, THEMES.light.content]).toEqual(['#ebebeb', '#f5f5f5', '#ffffff'])
    expect(fills('dark', 'none', 100).menu).toBe(THEMES.dark.popover)
    expect(fills('dark', 'none', 15)).toBe(fills('dark', 'none', 90))
  })
  test('the reference vectors', () => {
    expect(materialFormulas('dark', opaque('dark'), 72).raisedPercent).toBe(46)
    expect(materialFormulas('light', opaque('light'), 38).raisedPercent).toBe(15)
    expect(materialFormulas('dark', opaque('dark'), 72).shellPercent).toBe(64)
    expect(materialFormulas('light', opaque('light'), 38).shellPercent).toBe(82)
    expect(materialFormulas('light', opaque('light'), 90).shellPercent).toBe(100)
  })
  test('every opacity resolves to a real color, dark and light, never below the readability floor', () => {
    for (const variant of ['dark', 'light'] as const) for (const o of [15, 38, 72, 90, 100]) {
      const m = fills(variant, 'window', o)
      for (const color of [m.frame, m.menu, m.settingsCard]) expect(color).toMatch(/^rgba\(\d+, \d+, \d+, [\d.]+\)$/)
      const alpha = Number(m.frame.match(/([\d.]+)\)$/)![1])
      expect(alpha).toBeCloseTo(Math.max(o, FLOOR[variant]) / 100, 2)
    }
  })
})

describe('readability floor (Zeron contrast_checked_tint_alpha)', () => {
  test('the default themes: 65% dark, 55% light, below the 90% default', () => {
    expect(coatFloor('dark', opaque('dark'))).toBe(65)
    expect(coatFloor('light', opaque('light'))).toBe(55)
    for (const variant of ['dark', 'light'] as const) expect(coatFloor(variant, opaque(variant))).toBeLessThan(DEFAULT_VARIANT_MATERIAL.opacity)
  })
  test('the slider holds at the floor and is untouched above it', () => {
    expect([15, 40, 65, 66, 90, 100].map((o) => effectiveOpacity('dark', opaque('dark'), o))).toEqual([65, 65, 65, 66, 90, 100])
    expect([15, 54, 55, 56, 100].map((o) => effectiveOpacity('light', opaque('light'), o))).toEqual([55, 55, 55, 56, 100])
  })
  test('the floor meets the contrast it promises over the adverse backdrop, one step below it does not', () => {
    // dark text over a coat on white: the ratio at the floor reaches 4.5 and 3, and 5% less misses one of them
    const lum = (c: number[]) => { const l = (x: number) => { const y = x / 255; return y <= 0.04045 ? y / 12.92 : ((y + 0.055) / 1.055) ** 2.4 }; return 0.2126 * l(c[0]!) + 0.7152 * l(c[1]!) + 0.0722 * l(c[2]!) }
    const ratio = (a: number[], b: number[]) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)
    const ok = (variant: ThemeVariant, percent: number) => {
      const O = opaque(variant)
      const coat = variant === 'dark' ? [0x18 * 0.8, 0x18 * 0.8, 0x18 * 0.8] : [255, 255, 255]
      const adverse = variant === 'dark' ? 255 : 0
      const p = percent / 100
      const bg = coat.map((c) => c * p + adverse * (1 - p))
      const ink = variant === 'dark' ? 252 : 13
      const text = ratio([ink, ink, ink], bg)
      const alpha = Number(O['--color-text-foreground-secondary']!.match(/([\d.]+)\)$/)![1])
      const muted = ratio([0, 1, 2].map((i) => ink * alpha + bg[i]! * (1 - alpha)), bg)
      return text >= 4.5 && muted >= 3
    }
    for (const variant of ['dark', 'light'] as const) {
      expect(ok(variant, FLOOR[variant])).toBe(true)
      expect(ok(variant, FLOOR[variant] - 5)).toBe(false)
    }
  })
  test('unreadable colours set no floor, and ink that no coat can carry saturates it', () => {
    expect(coatFloor('dark', { '--color-background-surface': 'oklch(0.2 0 0)', '--color-text-foreground': '#fff', '--color-text-foreground-secondary': '#fff' })).toBe(0)
    // Mid-grey ink: under 4.5:1 against both the coat and the white desktop at every step.
    expect(coatFloor('dark', { '--color-background-surface': '#181818', '--color-text-foreground': '#7a7a7a', '--color-text-foreground-secondary': '#7a7a7a' })).toBe(100)
  })
})

describe('coverage and the opaque backing rule', () => {
  const O = { dark: opaque('dark'), light: opaque('light') }
  test('Solid and Reduce transparency scope cover everything', () => {
    for (const variant of ['dark', 'light'] as const) expect(materialCoverage(variant, O[variant], 'none', 15)).toBe(1)
  })
  test('whole window is the coat; Sidebar only is the frame shell', () => {
    expect([15, 65, 90, 100].map((o) => materialCoverage('dark', O.dark, 'window', o))).toEqual([0.65, 0.65, 0.9, 1])
    expect([15, 65, 90, 100].map((o) => materialCoverage('dark', O.dark, 'sidebar', o))).toEqual([0.58, 0.58, 0.8, 0.89])
    expect([15, 47, 90, 100].map((o) => materialCoverage('light', O.light, 'sidebar', o))).toEqual([1, 1, 1, 1])
    expect([15, 55, 90, 100].map((o) => materialCoverage('light', O.light, 'window', o))).toEqual([0.55, 0.55, 0.9, 1])
  })
  test('windowCoverage reads the same default themes', () => {
    expect(windowCoverage('light', 'sidebar', 90)).toBe(1)
    expect(windowCoverage('dark', 'sidebar', 90)).toBe(0.8)
  })
})

describe('Opacity is not part of the theme', () => {
  test('an Opacity step makes no new Theme', () => {
    const before = derivedThemeCount()
    const first = themeFor('dark', 'sidebar', false, false)
    for (let o = 15; o <= 100; o++) expect(themeFor('dark', 'sidebar', false, false)).toBe(first)
    expect(derivedThemeCount()).toBeLessThanOrEqual(before + 1)
  })
  test('a step changes the material only, and the same step gives the same material object', () => {
    const a = fills('dark', 'window', 80), b = fills('dark', 'window', 85)
    expect(a).not.toBe(b)
    expect(a.frame).not.toBe(b.frame)
    expect(fills('dark', 'window', 80)).toBe(a)
  })
  test('the theme carries no opacity-dependent variable', () => {
    for (const scope of ['none', 'sidebar', 'window'] as const) for (const name of OPACITY_VARS) {
      expect(themeFor('light', scope, false, false).raw[name]).toBeUndefined()
    }
  })
  test('every other variable is the same at any opacity', () => {
    for (const variant of ['dark', 'light'] as const) for (const scope of ['sidebar', 'window'] as const) {
      const a = materialVars(variant, opaque(variant), scope, 80), b = materialVars(variant, opaque(variant), scope, 100)
      for (const name of Object.keys(a)) if (!(OPACITY_VARS as readonly string[]).includes(name)) expect(a[name]).toBe(b[name])
    }
  })
})

describe('single fill (KYBERN_TRANSLUCENCY_SINGLE_FILL)', () => {
  test('stacking the coat on the shell is one fill of the same pixels', () => {
    const shell = fills('dark', 'sidebar', 50).frame, coat = fills('dark', 'sidebar', 50).sidebar
    const one = stack(coat, shell)
    // Over a white desktop the pair and the single fill give the same colour.
    const channels = (c: string) => c.match(/[\d.]+/g)!.map(Number) as [number, number, number, number]
    const over = (top: string, base: [number, number, number]) => { const [r, g, b, a] = channels(top); return [r, g, b].map((x, i) => x * a + base[i]! * (1 - a)) }
    const pair = over(coat, over(shell, [255, 255, 255]) as [number, number, number])
    const single = over(one, [255, 255, 255])
    for (let i = 0; i < 3; i++) expect(single[i]!).toBeCloseTo(pair[i]!, 0)
  })
  test('a coat over an opaque frame is opaque, and nothing over nothing is clear', () => {
    expect(stack('rgba(19, 19, 19, 0.9)', '#2d2d2d')).toBe('rgba(22, 22, 22, 1)')
    expect(stack('rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)')).toBe('rgba(0, 0, 0, 0)')
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
    for (let o = 15; o <= 100; o++) { themeFor('dark', 'window', false, false); materialFor('dark', 'window', o) }
    expect(derivedThemeCount()).toBeLessThanOrEqual(24)
    expect(THEMES.dark.surface).toBe('#181818')
    const t = themeFor('dark', 'window', false, false)
    expect(t.content).toBe('rgba(0, 0, 0, 0)')
    expect(t.surface).toBe('#181818')
    expect(t.scope).toBe('window')
  })
  test('Increase contrast and Reduce transparency keep the opaque scope but their own theme', () => {
    expect(themeFor('dark', 'none', true, false).contrast).toBe(true)
    expect(themeFor('dark', 'none', true, false)).toBe(themeFor('dark', 'none', true, false))
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
