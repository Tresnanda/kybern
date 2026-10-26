import { expect, test } from 'bun:test'
import { fontPlan, installUiFont, INTER, INTER_FILES, MONO_WEIGHT_FILES, SEGOE_VARIABLE, uiFontFiles } from './fonts.ts'

test('macOS keeps the system font and Menlo', () => {
  expect(fontPlan('darwin', { KYBERN_UI_FONT: 'Other' })).toEqual({ systemUi: null, mono: 'Menlo', monoAdvance: 0.602 })
})

test('Windows 11 uses Segoe UI Variable, Windows 10 the bundled Inter', () => {
  const seen: string[] = []
  const win11 = fontPlan('win32', { WINDIR: 'D:\\Windows' }, file => (seen.push(file), true))
  expect(seen).toEqual(['D:\\Windows\\Fonts\\SegUIVar.ttf'])
  expect(win11).toEqual({ systemUi: SEGOE_VARIABLE, mono: 'JetBrains Mono', monoAdvance: 0.6 })
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
