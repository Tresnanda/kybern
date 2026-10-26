import { expect, test } from 'bun:test'
import { fontPlan, INTER, SEGOE_VARIABLE } from './fonts.ts'

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
