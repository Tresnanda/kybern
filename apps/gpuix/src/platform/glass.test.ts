import { describe, expect, test } from 'bun:test'
import { THEMES, materialFor, themeFor } from '../theme.ts'
import { FROST_CLASSES, FROST_DEFAULT, parseFrostClasses, type ThemeVariant } from './translucency.ts'
import { frostFill, frosted, frostedWith, raisedFill, raisedRim, wash } from './glass.ts'

const window = (variant: ThemeVariant, surface: number | null = null) => materialFor(variant, 'window', 90, 90, surface).glass
const solid = (variant: ThemeVariant) => materialFor(variant, 'none', 100).glass
const sidebar = (variant: ThemeVariant) => materialFor(variant, 'sidebar', 90).glass

describe('window values (§3.1)', () => {
  test('dark', () => {
    const g = window('dark')
    expect(g).toMatchObject({
      on: true,
      raised: 'rgba(255, 255, 255, 0.045)', raisedHover: 'rgba(255, 255, 255, 0.075)', band: 'rgba(255, 255, 255, 0.03)',
      rim: 'rgba(255, 255, 255, 0.08)', highlight: 'rgba(255, 255, 255, 0.06)',
      frost: 'rgba(46, 46, 46, 0.55)', frostStacked: 'rgba(46, 46, 46, 0.48)', frostMenu: 'rgba(46, 46, 46, 0.66)',
      frostRim: 'rgba(255, 255, 255, 0.1)', frostHighlight: 'rgba(255, 255, 255, 0.08)', pillRim: 'rgba(255, 255, 255, 0.1)',
      denseFloat: 'rgba(46, 46, 46, 0.92)',
      recess: 'rgba(0, 0, 0, 0.22)', recessRim: 'rgba(255, 255, 255, 0.06)', recessShade: 'rgba(0, 0, 0, 0.25)',
    })
    expect(themeFor('dark', 'window', false, false).glass.dense).toBe('rgba(46, 46, 46, 0.96)')
  })
  test('light: the frost tint starts at 0.70, stacked panels scale with it', () => {
    const g = window('light')
    expect(g).toMatchObject({
      on: true,
      raised: 'rgba(255, 255, 255, 0.55)', raisedHover: 'rgba(255, 255, 255, 0.72)', band: 'rgba(13, 13, 13, 0.025)',
      rim: 'rgba(13, 13, 13, 0.08)', highlight: 'rgba(255, 255, 255, 0.9)',
      frost: 'rgba(255, 255, 255, 0.7)', frostStacked: 'rgba(255, 255, 255, 0.6)', frostMenu: 'rgba(255, 255, 255, 0.72)',
      frostRim: 'rgba(13, 13, 13, 0.1)', frostHighlight: 'rgba(255, 255, 255, 0.95)', pillRim: 'rgba(13, 13, 13, 0.14)',
      denseFloat: 'rgba(255, 255, 255, 0.94)',
      recess: 'rgba(13, 13, 13, 0.06)', recessRim: 'rgba(13, 13, 13, 0.08)', recessShade: 'rgba(0, 0, 0, 0.06)',
    })
    expect(themeFor('light', 'window', false, false).glass.dense).toBe('rgba(255, 255, 255, 0.96)')
  })
  test('pill hover is the frost tint with 6% ink stacked on it', () => {
    expect(window('dark').frostHover).toBe('rgba(67, 67, 67, 0.577)')
    expect(window('light').frostHover).toMatch(/^rgba\(\d+, \d+, \d+, 0\.7[0-9]*\)$/)
  })
})

describe('Solid and Sidebar only return the call site\'s own fill', () => {
  for (const [name, glass] of [['Solid', solid], ['Sidebar only', sidebar]] as const) for (const variant of ['dark', 'light'] as const) {
    test(`${name} ${variant}`, () => {
      const g = glass(variant)
      expect(g.on).toBe(false)
      expect(raisedFill(g, '#123456')).toBe('#123456')
      expect(raisedFill(g, '#123456', true)).toBe('#123456')
      expect(raisedRim(g, '#654321')).toBe('#654321')
      expect(frostFill(g, 'composer', '#abcdef')).toBe('#abcdef')
      expect(frostFill(g, 'menus', '#abcdef', 'frostMenu')).toBe('#abcdef')
      expect(g.highlight).toBe('')
      expect(g.frostHighlight).toBe('')
      const t = themeFor(variant, name === 'Solid' ? 'none' : 'sidebar', false, false)
      expect(wash(t, g, 0.05)).toMatch(/^rgba\(\d+, \d+, \d+, 1\)$/)
    })
  }
  test('the popover fallbacks of the frost fills outside whole-window glass', () => {
    expect(solid('dark').frostMenu).toBe(THEMES.dark.popover)
    expect(solid('dark').frostStacked).toBe(THEMES.dark.popover)
    expect(sidebar('light').frostMenu).toBe(THEMES.light.popover)
  })
})

describe('whole-window glass', () => {
  test('wash is the translucent ink, never an opaque slab', () => {
    const t = themeFor('dark', 'window', false, false)
    expect(wash(t, window('dark'), 0.05)).toBe('rgba(252, 252, 252, 0.05)')
    expect(wash(themeFor('light', 'window', false, false), window('light'), 0.05)).toBe('rgba(13, 13, 13, 0.05)')
  })
  test('raised helpers pick the glass tint', () => {
    const g = window('dark')
    expect(raisedFill(g, '#123456')).toBe(g.raised)
    expect(raisedFill(g, '#123456', true)).toBe(g.raisedHover)
    expect(raisedRim(g, '#654321')).toBe(g.rim)
  })
  test('a frost fill is the tint when the class blurs and denseFloat when it does not', () => {
    const g = window('dark')
    for (const c of FROST_CLASSES) expect(frostFill(g, c, '#abcdef')).toBe(frosted(g, c) ? g.frost : g.denseFloat)
    for (const c of FROST_CLASSES) expect(frostFill(g, c, '#abcdef', 'frostMenu')).toBe(frosted(g, c) ? g.frostMenu : g.denseFloat)
  })
  test('frosted(): scope x backdrops allowed x patched addon x enabled class', () => {
    for (const on of [false, true]) for (const backdrops of [false, true]) for (const patched of [false, true]) for (const enabled of [false, true]) {
      const set = new Set<'composer' | 'pills' | 'menus'>(enabled ? ['menus'] : ['composer'])
      expect(frostedWith(on, backdrops, patched, set, 'menus')).toBe(on && backdrops && patched && enabled)
    }
  })
})

describe('frost classes (KYBERN_GLASS_FROST)', () => {
  test('the default is what the gate kept (no class: every one cost 27% or more GPU time per frame)', () => {
    expect([...parseFrostClasses(undefined)]).toEqual([...FROST_DEFAULT])
    expect([...parseFrostClasses('')]).toEqual([...FROST_DEFAULT])
  })
  test('none, all and a comma list; unknown names are ignored', () => {
    expect([...parseFrostClasses('none')]).toEqual([])
    expect([...parseFrostClasses('all')].sort()).toEqual([...FROST_CLASSES].sort())
    expect([...parseFrostClasses('composer, pills')].sort()).toEqual(['composer', 'pills'])
    expect([...parseFrostClasses('menus,bogus')]).toEqual(['menus'])
    expect([...parseFrostClasses(' ALL ')].sort()).toEqual([...FROST_CLASSES].sort())
  })
})
