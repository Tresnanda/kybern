import { expect, test } from 'bun:test'
import { sameChrome, takesAppearance, type WindowChrome } from './windowChrome.ts'

test('Linux: the first report does not override a theme read at launch; later changes do', () => {
  // XFCE with Adwaita-dark: the launch read says dark, the portal states no preference, GPUI reports light.
  expect(takesAppearance('linux', null, 'light', true)).toBe(false)
  expect(takesAppearance('linux', 'light', 'light', true)).toBe(false)
  expect(takesAppearance('linux', 'light', 'dark', true)).toBe(true)
  // Nothing read at launch (no gsettings): the first report is all there is.
  expect(takesAppearance('linux', null, 'dark', false)).toBe(true)
})

test('Windows: the first report and every change set the theme', () => {
  expect(takesAppearance('win32', null, 'dark', true)).toBe(true)
  expect(takesAppearance('win32', 'dark', 'dark', true)).toBe(false)
  expect(takesAppearance('win32', 'dark', 'light', true)).toBe(true)
})

test('a report that differs only in bounds keeps the snapshot', () => {
  const chrome: WindowChrome = {
    platform: 'windows', decorations: 'client', tiling: null, maximized: false, fullscreen: false, active: true, resizable: true, minimizable: true,
    controls: { minimize: true, maximize: true, fullscreen: false, windowMenu: true }, buttonLayout: null, appearance: 'dark', reducedMotion: false,
  }
  const report = { ...chrome, bounds: { state: 'windowed' as const, x: 10, y: 20, width: 900, height: 600, display: null } }
  expect(sameChrome(chrome, report)).toBe(true)
  expect(sameChrome(chrome, { ...report, maximized: true })).toBe(false)
  expect(sameChrome(chrome, { ...report, controls: { ...chrome.controls, maximize: false } })).toBe(false)
  expect(sameChrome(null, report)).toBe(false)
})
