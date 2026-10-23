import { describe, expect, test } from 'bun:test'
import { DEFAULT_THEME_STATE, buildThemeCssVariables } from '../../../desktop/src/lib/kit/theme/theme.logic.ts'
import { THEMES, derivedThemeCount, materialFor, stack, themeFor, windowCoverage } from '../theme.ts'
import {
  DEFAULT_VARIANT_MATERIAL, OPACITY_MIN, OPACITY_VARS, SIDEBAR_ONLY_PANEL_GLASS, SURFACE_DEFAULT, SURFACE_MIN, advancedDefaults, coatFloor, effectiveOpacity, effectiveSurface,
  frostQuietInk, glassContrast, isAdvancedDefault, isSidebarOnly, materialCoverage, materialFormulas, materialVars, migrateWindow, normalizeVariantMaterial, opacityVarsFor, resolveScope, surfaceFloor,
  windowCoats, type ThemeVariant, type VariantMaterial, type WindowScope,
} from './translucency.ts'

const opaque = (variant: ThemeVariant) => buildThemeCssVariables(
  { codeThemeId: DEFAULT_THEME_STATE.codeThemeIds[variant], theme: DEFAULT_THEME_STATE.chromeThemes[variant] },
  variant, { electron: true, isMac: false, systemUiFont: true },
).variables as Record<string, string>
const none = { reduceTransparency: false, increaseContrast: false }
const glass = (over: Partial<VariantMaterial> = {}): VariantMaterial => ({ ...DEFAULT_VARIANT_MATERIAL, material: 'translucent', contentOpacity: 90, ...over })
const fills = (variant: ThemeVariant, scope: WindowScope, opacity: number, content = opacity, surface: number | null = null) => materialFor(variant, scope, opacity, content, surface)
const FLOOR = { dark: 70, light: 55 } as const

describe('formulas (default 90%)', () => {
  test('dark', () => {
    expect(fills('dark', 'window', 90).frame).toBe('rgba(19, 19, 19, 0.9)')
    expect(fills('dark', 'window', 90).glass.frostMenu).toBe('rgba(46, 46, 46, 0.66)')
    expect(themeFor('dark', 'window', false, false).glass.dense).toBe('rgba(46, 46, 46, 0.96)')
    expect(fills('dark', 'sidebar', 90).frame).toBe('rgba(45, 45, 45, 0.8)')
    expect(fills('dark', 'sidebar', 90).sidebar).toBe('rgba(19, 19, 19, 0.9)')
  })
  test('light', () => {
    expect(fills('light', 'window', 90).frame).toBe('rgba(255, 255, 255, 0.9)')
    expect(fills('light', 'window', 90).glass.frostMenu).toBe('rgba(255, 255, 255, 0.72)')
    expect(themeFor('light', 'window', false, false).glass.dense).toBe('rgba(255, 255, 255, 0.96)')
    expect(fills('light', 'sidebar', 90).frame).toBe('rgba(235, 235, 235, 1)')
  })
  test('Solid keeps the opaque tokens', () => {
    expect([fills('dark', 'none', 100).frame, fills('dark', 'none', 100).sidebar, THEMES.dark.content]).toEqual(['#2d2d2d', '#212121', '#181818'])
    expect([fills('light', 'none', 100).frame, fills('light', 'none', 100).sidebar, THEMES.light.content]).toEqual(['#ebebeb', '#f5f5f5', '#ffffff'])
    expect(fills('dark', 'none', 100).glass.frostMenu).toBe(THEMES.dark.popover)
    expect(fills('dark', 'none', 15)).toBe(fills('dark', 'none', 90))
    expect(fills('dark', 'none', 100).glass.on).toBe(false)
  })
  test('the reference vectors', () => {
    expect(materialFormulas('dark', opaque('dark'), 72).shellPercent).toBe(64)
    expect(materialFormulas('light', opaque('light'), 38).shellPercent).toBe(82)
    expect(materialFormulas('light', opaque('light'), 90).shellPercent).toBe(100)
  })
  test('every opacity resolves to a real color, dark and light, never below the readability floor', () => {
    for (const variant of ['dark', 'light'] as const) for (const o of [15, 38, 72, 90, 100]) {
      const m = fills(variant, 'window', o)
      for (const color of [m.frame, m.glass.raised, m.glass.frost, m.glass.frostMenu]) expect(color).toMatch(/^rgba\(\d+, \d+, \d+, [\d.]+\)$/)
      const alpha = Number(m.frame.match(/([\d.]+)\)$/)![1])
      expect(alpha).toBeCloseTo(Math.max(o, FLOOR[variant]) / 100, 2)
    }
  })
})

describe('readability floor (Zeron contrast_checked_tint_alpha)', () => {
  test('the default themes: 70% dark (raised cards stacked on the coat), 55% light, below the 90% default', () => {
    expect(coatFloor('dark', opaque('dark'))).toBe(70)
    expect(coatFloor('light', opaque('light'))).toBe(55)
    for (const variant of ['dark', 'light'] as const) expect(coatFloor(variant, opaque(variant))).toBeLessThan(DEFAULT_VARIANT_MATERIAL.sidebarOpacity)
  })
  test('the slider holds at the floor and is untouched above it', () => {
    expect([15, 40, 70, 71, 90, 100].map((o) => effectiveOpacity('dark', opaque('dark'), o))).toEqual([70, 70, 70, 71, 90, 100])
    expect([15, 54, 55, 56, 100].map((o) => effectiveOpacity('light', opaque('light'), o))).toEqual([55, 55, 55, 56, 100])
  })
  test('the floor meets the contrast it promises over the adverse backdrop, one step below it does not', () => {
    // dark text over a coat on white: the ratio at the floor reaches 4.5 and 3, and 5% less misses one of them
    const lum = (c: number[]) => { const l = (x: number) => { const y = x / 255; return y <= 0.04045 ? y / 12.92 : ((y + 0.055) / 1.055) ** 2.4 }; return 0.2126 * l(c[0]!) + 0.7152 * l(c[1]!) + 0.0722 * l(c[2]!) }
    const ratio = (a: number[], b: number[]) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)
    const ok = (variant: ThemeVariant, percent: number, raised: boolean) => {
      const O = opaque(variant)
      const coat = variant === 'dark' ? [0x18 * 0.8, 0x18 * 0.8, 0x18 * 0.8] : [255, 255, 255]
      const adverse = variant === 'dark' ? 255 : 0
      const p = percent / 100
      let bg = coat.map((c) => c * p + adverse * (1 - p))
      if (raised) { const tint = variant === 'dark' ? [255, 255, 255, 0.045] : [255, 255, 255, 0.55]; bg = bg.map((c, i) => tint[i]! * tint[3]! + c * (1 - tint[3]!)) }
      const ink = variant === 'dark' ? 252 : 13
      const text = ratio([ink, ink, ink], bg)
      const alpha = Number(O['--color-text-foreground-secondary']!.match(/([\d.]+)\)$/)![1])
      const muted = ratio([0, 1, 2].map((i) => ink * alpha + bg[i]! * (1 - alpha)), bg)
      return text >= 4.5 && muted >= 3
    }
    for (const variant of ['dark', 'light'] as const) {
      // Dark: the white raised tint lightens the worst-case backdrop. Light: its white tint only helps, so the coat alone decides.
      expect(ok(variant, FLOOR[variant], variant === 'dark')).toBe(true)
      expect(ok(variant, FLOOR[variant] - 5, variant === 'dark')).toBe(false)
    }
    // The coat alone would have stopped at 65 in dark: the raised tint is what moves the floor.
    expect(ok('dark', 65, false)).toBe(true)
    expect(ok('dark', 65, true)).toBe(false)
  })
  test('unreadable colours set no floor, and ink that no coat can carry saturates it', () => {
    expect(coatFloor('dark', { '--color-background-surface': 'oklch(0.2 0 0)', '--color-text-foreground': '#fff', '--color-text-foreground-secondary': '#fff' })).toBe(0)
    // Mid-grey ink: under 4.5:1 against both the coat and the white desktop at every step.
    expect(coatFloor('dark', { '--color-background-surface': '#181818', '--color-text-foreground': '#7a7a7a', '--color-text-foreground-secondary': '#7a7a7a' })).toBe(100)
  })
})

describe('Surface opacity (user decision, round 2)', () => {
  const O = { dark: opaque('dark'), light: opaque('light') }
  test('the defaults are the recipe: dark frost 0.55, light frost 0.70', () => {
    expect(SURFACE_DEFAULT).toEqual({ dark: 55, light: 70 })
    expect(fills('dark', 'window', 90).glass.frost).toBe('rgba(46, 46, 46, 0.55)')
    expect(fills('light', 'window', 90).glass.frost).toBe('rgba(255, 255, 255, 0.7)')
    expect(fills('dark', 'window', 90).glass.raised).toBe('rgba(255, 255, 255, 0.045)')
    expect(fills('light', 'window', 90).glass.raised).toBe('rgba(255, 255, 255, 0.55)')
    expect(fills('dark', 'window', 90, 90, SURFACE_DEFAULT.dark)).not.toBe(fills('dark', 'window', 90))
    expect(fills('dark', 'window', 90, 90, SURFACE_DEFAULT.dark).glass).toEqual(fills('dark', 'window', 90).glass)
  })
  test('the slider scales every frost and raised tint, and the rims stay', () => {
    const lo = fills('dark', 'window', 90, 90, 40).glass, hi = fills('dark', 'window', 90, 90, 90).glass
    const alpha = (c: string) => Number(c.match(/([\d.]+)\)$/)![1])
    for (const name of ['raised', 'frost', 'frostStacked', 'frostMenu'] as const) expect(alpha(hi[name])).toBeGreaterThan(alpha(lo[name]))
    expect(hi.rim).toBe(lo.rim)
    expect(hi.frostRim).toBe(lo.frostRim)
  })
  test('the floor holds for every glass fill at every step, and the value is clamped to it', () => {
    for (const variant of ['dark', 'light'] as const) {
      const floor = surfaceFloor(variant, O[variant])
      expect(floor).toBeGreaterThanOrEqual(SURFACE_MIN)
      expect(floor).toBeLessThanOrEqual(SURFACE_DEFAULT[variant])
      for (let v = floor; v <= 100; v += 5) for (const [name, text, muted] of glassContrast(variant, O[variant], v)) {
        if (['raisedHover', 'band'].includes(name)) continue
        expect(text).toBeGreaterThanOrEqual(4.5)
        expect(muted).toBeGreaterThanOrEqual(3)
      }
      expect(effectiveSurface(variant, O[variant], 1)).toBe(floor)
      expect(effectiveSurface(variant, O[variant], null)).toBe(SURFACE_DEFAULT[variant])
      expect(effectiveSurface(variant, O[variant], 100)).toBe(100)
    }
  })
  test('the contrast of the recipe defaults matches the spec table', () => {
    const row = (variant: ThemeVariant, name: string) => glassContrast(variant, O[variant], SURFACE_DEFAULT[variant]).find(([n]) => n === name)!
    // §3.1 (dark raised reads 6.0 / 3.21 once the coat floor is 70).
    expect(row('dark', 'raised')[1]).toBeCloseTo(6.0, 0)
    expect(row('dark', 'raised')[2]).toBeCloseTo(3.2, 1)
    for (const variant of ['dark', 'light'] as const) for (const name of ['raised', 'frost', 'frostStacked', 'frostMenu']) {
      expect(row(variant, name)[1]).toBeGreaterThanOrEqual(4.5)
      expect(row(variant, name)[2]).toBeGreaterThanOrEqual(3)
    }
  })
  test('a step makes a new material and no new theme; the same step is the same object', () => {
    const before = derivedThemeCount()
    const first = themeFor('dark', 'window', false, false)
    for (let v = 40; v <= 100; v++) { expect(themeFor('dark', 'window', false, false)).toBe(first); materialFor('dark', 'window', 90, 90, v) }
    expect(derivedThemeCount()).toBeLessThanOrEqual(before + 1)
    expect(fills('dark', 'window', 90, 90, 61)).toBe(fills('dark', 'window', 90, 90, 61))
  })
  test('Solid and Sidebar only ignore it', () => {
    expect(fills('dark', 'sidebar', 90, 100, 40)).toBe(fills('dark', 'sidebar', 90, 70, 90))
    expect(fills('dark', 'none', 90, 100, 40)).toBe(fills('dark', 'none', 15))
  })
})

describe('coverage and the opaque backing rule', () => {
  const O = { dark: opaque('dark'), light: opaque('light') }
  test('Solid and Reduce transparency scope cover everything', () => {
    for (const variant of ['dark', 'light'] as const) expect(materialCoverage(variant, O[variant], 'none', 15)).toBe(1)
  })
  test('whole window is the more transparent coat; Sidebar only is the frame shell', () => {
    expect([15, 70, 90, 100].map((o) => materialCoverage('dark', O.dark, 'window', o, o))).toEqual([0.7, 0.7, 0.9, 1])
    expect([15, 65, 90, 100].map((o) => materialCoverage('dark', O.dark, 'sidebar', o))).toEqual([0.62, 0.62, 0.8, 0.89])
    expect([15, 47, 90, 100].map((o) => materialCoverage('light', O.light, 'sidebar', o))).toEqual([1, 1, 1, 1])
    expect([15, 55, 90, 100].map((o) => materialCoverage('light', O.light, 'window', o, o))).toEqual([0.55, 0.55, 0.9, 1])
  })
  test('the frame follows the more transparent of the two, and the opaque backing needs both at 100', () => {
    expect(materialCoverage('dark', O.dark, 'window', 90, 60)).toBe(0.7)
    expect(materialCoverage('dark', O.dark, 'window', 60, 95)).toBe(0.7)
    expect(materialCoverage('light', O.light, 'window', 60, 95)).toBe(0.6)
    expect(materialCoverage('light', O.light, 'window', 100, 100)).toBe(1)
    expect(materialCoverage('light', O.light, 'window', 100, 90)).toBe(0.9)
  })
  test('windowCoverage reads the same default themes', () => {
    expect(windowCoverage('light', 'sidebar', 90)).toBe(1)
    expect(windowCoverage('dark', 'sidebar', 90)).toBe(0.8)
    expect(windowCoverage('dark', 'window', 100, 100)).toBe(1)
  })
})

describe('whole-window stacking (§5.3)', () => {
  const O = opaque('light')
  const alphaOf = (c: string) => c === 'transparent' ? 0 : Number(c.match(/([\d.]+)\)$/)![1])
  /** The composite alpha of the root coat with a region's extra coat over it. */
  const composite = (frame: string, extra: string) => { const f = alphaOf(frame), e = alphaOf(extra); return e + f * (1 - e) }
  test('every region reads coat(v) for the sliders in the spec', () => {
    for (const [s, c] of [[90, 90], [60, 90], [90, 60], [60, 100], [15, 100], [100, 100], [55, 55]] as const) {
      const f = { sidebar: fills('light', 'window', s, c).sidebar, content: fills('light', 'window', s, c).content, frame: fills('light', 'window', s, c).frame }
      expect(composite(f.frame, f.sidebar)).toBeCloseTo(Math.max(s, 55) / 100, 2)
      expect(composite(f.frame, f.content)).toBeCloseTo(Math.max(c, 55) / 100, 2)
    }
  })
  test('one fill at equal opacities, at most one extra otherwise', () => {
    const fillsOf = (s: number, c: number) => [fills('light', 'window', s, c).frame, fills('light', 'window', s, c).sidebar, fills('light', 'window', s, c).content].filter((x) => alphaOf(x) > 0).length
    expect(fillsOf(90, 90)).toBe(1)
    expect(fillsOf(60, 90)).toBe(2)
    expect(fillsOf(90, 60)).toBe(2)
    expect(fillsOf(60, 60)).toBe(1)
  })
  test('windowCoats: the root takes the lower opacity, the other region the rest', () => {
    expect(windowCoats('light', O, 60, 90)).toEqual({ frame: 60, sidebar: 0, content: 75 })
    expect(windowCoats('light', O, 90, 60)).toEqual({ frame: 60, sidebar: 75, content: 0 })
    expect(windowCoats('light', O, 90, 90)).toEqual({ frame: 90, sidebar: 0, content: 0 })
    expect(windowCoats('light', O, 100, 100)).toEqual({ frame: 100, sidebar: 0, content: 0 })
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
    for (const scope of ['none', 'sidebar', 'window'] as const) for (const name of opacityVarsFor(scope)) {
      expect(themeFor('light', scope, false, false).raw[name]).toBeUndefined()
    }
    expect(OPACITY_VARS).toContain('--app-frame-surface')
  })
  test('every other variable is the same at any opacity', () => {
    for (const variant of ['dark', 'light'] as const) for (const scope of ['sidebar', 'window'] as const) {
      const a = materialVars(variant, opaque(variant), scope, 80, 80), b = materialVars(variant, opaque(variant), scope, 100, 100)
      for (const name of Object.keys(a)) if (!opacityVarsFor(scope).includes(name)) expect(a[name]).toBe(b[name])
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

describe('resolveScope and the Sidebar only preset', () => {
  test('truth table', () => {
    for (const material of ['solid', 'translucent'] as const) for (const contentOpacity of [100, 99, 90])
      for (const reduceTransparency of [false, true]) for (const increaseContrast of [false, true]) for (const opaqueWindow of [false, true]) {
        const expected = opaqueWindow || reduceTransparency || increaseContrast || material === 'solid' ? 'none' : contentOpacity === 100 ? 'sidebar' : 'window'
        expect(resolveScope(glass({ material, contentOpacity }), { reduceTransparency, increaseContrast }, opaqueWindow)).toBe(expected)
      }
  })
  test('isSidebarOnly is content opacity 100', () => {
    expect([100, 99, 15].map((contentOpacity) => isSidebarOnly(glass({ contentOpacity })))).toEqual([true, false, false])
  })
})

describe('materialVars', () => {
  const O = opaque('dark')
  test('none changes only the content surface', () => {
    expect(materialVars('dark', O, 'none', 90)).toEqual({ '--app-content-surface': O['--color-background-surface'] })
  })
  test('whole window at equal opacities: one coat on the frame, everything above it clear', () => {
    const v = materialVars('dark', O, 'window', 90, 90)
    expect(v['--app-frame-surface']).toContain('color-mix')
    expect(v['--app-sidebar-surface']).toBe('transparent')
    expect(v['--app-content-surface']).toBe('transparent')
  })
  test('Sidebar only: shell frame, glass panel, opaque content', () => {
    const v = materialVars('dark', O, 'sidebar', 90)
    expect(v['--app-frame-surface']).not.toBe(materialVars('dark', O, 'window', 90, 90)['--app-frame-surface'])
    expect(v['--app-sidebar-surface']).toBe(materialVars('dark', O, 'window', 90, 90)['--app-frame-surface'])
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
    expect(normalizeVariantMaterial({ sidebarOpacity: 3 }).sidebarOpacity).toBe(OPACITY_MIN)
    expect(normalizeVariantMaterial({ sidebarOpacity: 140 }).sidebarOpacity).toBe(100)
    expect(normalizeVariantMaterial({ sidebarOpacity: 12.6 }).sidebarOpacity).toBe(15)
    expect(normalizeVariantMaterial({ contentOpacity: 40.6 }).contentOpacity).toBe(41)
    expect(normalizeVariantMaterial({ contentOpacity: '60' }).contentOpacity).toBe(DEFAULT_VARIANT_MATERIAL.contentOpacity)
    expect(normalizeVariantMaterial({ lastContentOpacity: 100 }).lastContentOpacity).toBe(90)
    expect(normalizeVariantMaterial({ lastContentOpacity: 3 }).lastContentOpacity).toBe(OPACITY_MIN)
    expect(normalizeVariantMaterial({ lastContentOpacity: 99 }).lastContentOpacity).toBe(99)
    expect(normalizeVariantMaterial({ blur: 0 }).blur).toBe(1)
    expect(normalizeVariantMaterial({ blur: 99 }).blur).toBe(64)
    expect(normalizeVariantMaterial({ blur: null }).blur).toBeNull()
    expect(normalizeVariantMaterial({ blur: 'x' }).blur).toBe(64)
    expect(normalizeVariantMaterial({ blur: Number.NaN }).blur).toBe(64)
    expect(normalizeVariantMaterial({ surfaceOpacity: 5 }).surfaceOpacity).toBe(SURFACE_MIN)
    expect(normalizeVariantMaterial({ surfaceOpacity: 140 }).surfaceOpacity).toBe(100)
    expect(normalizeVariantMaterial({ surfaceOpacity: 'x' }).surfaceOpacity).toBeNull()
    expect(normalizeVariantMaterial({}).surfaceOpacity).toBeNull()
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
    const glassContent: VariantMaterial = { ...DEFAULT_VARIANT_MATERIAL, material: 'translucent', sidebarOpacity: 90, contentOpacity: 90, lastContentOpacity: 90, blur: 64 }
    expect(migrateWindow({ translucent: true })).toEqual({ dark: glassContent, light: glassContent })
  })
  test('version 2: opacity becomes the sidebar opacity, Sidebar only becomes content 100', () => {
    const w = migrateWindow({ version: 2, window: { dark: { material: 'solid', opacity: 1, blur: null, sidebarOnly: true }, light: { material: 'translucent', opacity: 72, blur: 40, sidebarOnly: false } } })
    expect(w.dark).toEqual({ ...DEFAULT_VARIANT_MATERIAL, material: 'solid', sidebarOpacity: 15, contentOpacity: 100, lastContentOpacity: 15, blur: null })
    expect(w.light).toEqual({ ...DEFAULT_VARIANT_MATERIAL, material: 'translucent', sidebarOpacity: 72, contentOpacity: 72, lastContentOpacity: 72, blur: 40 })
  })
  test('version 2: opacity 100 keeps 90 to come back to, a missing variant is the default', () => {
    const w = migrateWindow({ version: 2, window: { dark: { material: 'translucent', opacity: 100, blur: 64, sidebarOnly: false } } })
    expect(w.dark).toMatchObject({ sidebarOpacity: 100, contentOpacity: 100, lastContentOpacity: 90 })
    expect(w.light).toEqual(DEFAULT_VARIANT_MATERIAL)
  })
  test('version 3 is normalized and a missing variant gets the default', () => {
    const w = migrateWindow({ version: 3, window: { dark: { material: 'translucent', sidebarOpacity: 3, contentOpacity: 120, lastContentOpacity: 100, blur: 9, surfaceOpacity: 61 } } })
    expect(w.dark).toEqual({ material: 'translucent', sidebarOpacity: 15, contentOpacity: 100, lastContentOpacity: 90, blur: 9, surfaceOpacity: 61 })
    expect(w.light).toEqual(DEFAULT_VARIANT_MATERIAL)
  })
})

describe('Advanced defaults', () => {
  test('Reset keeps the preset: content 100 when Sidebar only is on, else 90', () => {
    expect(advancedDefaults(glass({ contentOpacity: 100 }))).toEqual({ sidebarOpacity: 90, contentOpacity: 100, lastContentOpacity: 90, blur: 64, surfaceOpacity: null })
    expect(advancedDefaults(glass({ contentOpacity: 40 }))).toEqual({ sidebarOpacity: 90, contentOpacity: 90, lastContentOpacity: 90, blur: 64, surfaceOpacity: null })
  })
  test('isAdvancedDefault ignores the preset and a surface opacity that equals the default', () => {
    expect(isAdvancedDefault(glass({ contentOpacity: 100 }), 'dark')).toBe(true)
    expect(isAdvancedDefault(glass({ contentOpacity: 90 }), 'dark')).toBe(true)
    expect(isAdvancedDefault(glass({ contentOpacity: 80 }), 'dark')).toBe(false)
    expect(isAdvancedDefault(glass({ sidebarOpacity: 80 }), 'dark')).toBe(false)
    expect(isAdvancedDefault(glass({ blur: null }), 'dark')).toBe(false)
    expect(isAdvancedDefault(glass({ surfaceOpacity: 55 }), 'dark')).toBe(true)
    expect(isAdvancedDefault(glass({ surfaceOpacity: 55 }), 'light')).toBe(false)
  })
})

describe('quiet text on a frosted panel', () => {
  test('tertiary, placeholder and disabled text reach 4.5:1 at the floor; secondary keeps its lead', () => {
    const alpha = (c: string) => Number(c.match(/([\d.]+)\)$/)![1])
    for (const [variant, tertiary, secondary] of [['dark', 0.66, 0.73], ['light', 0.62, 0.69]] as const) {
      const ink = frostQuietInk(variant, opaque(variant), fills(variant, 'window', 90).glass.frostStacked)!
      expect([alpha(ink.tertiary), alpha(ink.secondary)]).toEqual([tertiary, secondary])
    }
    // An opaque fill needs no lift: the theme's own alphas stand when they already pass.
    expect(alpha(frostQuietInk('dark', opaque('dark'), 'rgba(0, 0, 0, 1)')!.secondary)).toBe(0.58)
    expect(frostQuietInk('dark', { '--color-background-surface': 'oklch(0.2 0 0)' }, 'rgba(46, 46, 46, 0.48)')).toBeNull()
  })
})
