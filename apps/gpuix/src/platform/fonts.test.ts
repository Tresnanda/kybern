import { expect, test } from 'bun:test'
import { chipPad, CHIP_ICON_GAP, fontPlan, installUiFont, INTER, INTER_FILES, MONO_WEIGHT_FILES, SEGOE_VARIABLE, uiFontFiles } from './fonts.ts'

test('macOS keeps the system font and Menlo', () => {
  expect(fontPlan('darwin', { KYBERN_UI_FONT: 'Other' })).toEqual({ systemUi: null, mono: 'Menlo', monoAdvance: 0.602, uiSpaceAdvance: null, uiXCentre: (0.952 - 0.241 - 0.527) / 2 })
})

test('Windows 11 uses Segoe UI Variable, Windows 10 the bundled Inter', () => {
  const seen: string[] = []
  const win11 = fontPlan('win32', { WINDIR: 'D:\\Windows' }, file => (seen.push(file), true))
  expect(seen).toEqual(['D:\\Windows\\Fonts\\SegUIVar.ttf'])
  expect(win11).toEqual({ systemUi: SEGOE_VARIABLE, mono: 'JetBrains Mono', monoAdvance: 0.6, uiSpaceAdvance: 561 / 2048, uiXCentre: (2210 - 514 - 1024) / 2 / 2048 })
  expect(fontPlan('win32', {}, () => false).systemUi).toBe(INTER)
})

test('Linux uses Inter; KYBERN_UI_FONT overrides off macOS', () => {
  expect(fontPlan('linux', {}, () => true).systemUi).toBe(INTER)
  expect(fontPlan('win32', { KYBERN_UI_FONT: INTER }, () => true).systemUi).toBe(INTER)
})

test('Inter is registered only when the plan draws with it; macOS registers nothing', () => {
  expect(uiFontFiles(fontPlan('darwin', {}))).toEqual([])
  expect(uiFontFiles(fontPlan('win32', {}, () => true))).toEqual(MONO_WEIGHT_FILES)
  expect(uiFontFiles(fontPlan('win32', {}, () => false))).toEqual([...INTER_FILES, ...MONO_WEIGHT_FILES])
  expect(uiFontFiles(fontPlan('linux', {}))).toEqual([...INTER_FILES, ...MONO_WEIGHT_FILES])
})

test('installUiFont registers the plan files and sets the UI family', () => {
  const registered: number[] = [], families: (string | null)[] = []
  const host = { registerFont: (bytes: Uint8Array) => registered.push(bytes.length), setSystemUiFont: (family: string | null) => families.push(family) }
  installUiFont(host, fontPlan('win32', {}, () => true))
  expect(registered.length).toBe(MONO_WEIGHT_FILES.length)
  expect(families).toEqual([SEGOE_VARIABLE])
  installUiFont(host, fontPlan('darwin', {}))
  expect(families).toEqual([SEGOE_VARIABLE])
})

// The room a chip reserves under its 13.3 px icon at the composer's 14 px (`chipPad`).
test('the chip pad clears the icon whichever face draws its spaces', () => {
  expect(chipPad(fontPlan('darwin', {}), 14, 13.3)).toEqual({ text: '  ', ui: false })
  for (const [platform, plan] of [['win32', fontPlan('win32', {}, () => true)], ['win32', fontPlan('win32', {}, () => false)], ['linux', fontPlan('linux', {})]] as const) {
    const pad = chipPad(plan, 14, 13.3)
    expect(pad.ui, platform).toBe(true)
    expect(pad.text.trim(), platform).toBe('')
    // Wide enough for the icon and its gap, and no more than a space wider than that.
    const width = pad.text.length * plan.uiSpaceAdvance! * 14
    expect(width, platform).toBeGreaterThanOrEqual(13.3 + CHIP_ICON_GAP)
    expect(width, platform).toBeLessThan(13.3 + CHIP_ICON_GAP + plan.uiSpaceAdvance! * 14)
  }
  // Never fewer than the two spaces the native input draws under the icon, and more for a bigger icon or a narrower space.
  expect(chipPad(fontPlan('linux', {}), 14, 1).text.length).toBe(2)
  expect(chipPad(fontPlan('linux', {}), 14, 40).text.length).toBeGreaterThan(chipPad(fontPlan('linux', {}), 14, 13.3).text.length)
})
