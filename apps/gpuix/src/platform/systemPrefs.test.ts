import { expect, test } from 'bun:test'
import { readLinuxReducedMotion, readSystemVariant, readTitlebarDoubleClick } from './systemPrefs.ts'

const answers = (map: Record<string, string | null>) => (command: string, args: string[]) => map[[command, ...args].join(' ')] ?? null

test('Windows reads AppsUseLightTheme', () => {
  const key = 'reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize /v AppsUseLightTheme'
  expect(readSystemVariant('win32', answers({ [key]: '\r\nHKEY_CURRENT_USER\\...\\Personalize\r\n    AppsUseLightTheme    REG_DWORD    0x0\r\n' }))).toBe('dark')
  expect(readSystemVariant('win32', answers({ [key]: '    AppsUseLightTheme    REG_DWORD    0x1\r\n' }))).toBe('light')
  expect(readSystemVariant('win32', answers({}))).toBeNull()
})

test('Linux reads color-scheme, then the GTK theme name', () => {
  const scheme = 'gsettings get org.gnome.desktop.interface color-scheme'
  const theme = 'gsettings get org.gnome.desktop.interface gtk-theme'
  expect(readSystemVariant('linux', answers({ [scheme]: "'prefer-dark'\n" }))).toBe('dark')
  expect(readSystemVariant('linux', answers({ [scheme]: "'prefer-light'\n" }))).toBe('light')
  expect(readSystemVariant('linux', answers({ [scheme]: "'default'\n", [theme]: "'Yaru-dark'\n" }))).toBe('dark')
  expect(readSystemVariant('linux', answers({ [scheme]: "'default'\n", [theme]: "'Adwaita'\n" }))).toBe('light')
  expect(readSystemVariant('linux', answers({}))).toBeNull()
  expect(readSystemVariant('darwin', answers({ [scheme]: "'prefer-dark'" }))).toBeNull()
})

test('GNOME enable-animations false is reduced motion', () => {
  const key = 'gsettings get org.gnome.desktop.interface enable-animations'
  expect(readLinuxReducedMotion(answers({ [key]: 'false\n' }))).toBe(true)
  expect(readLinuxReducedMotion(answers({ [key]: 'true\n' }))).toBe(false)
  expect(readLinuxReducedMotion(answers({}))).toBeNull()
})

test('GNOME title-bar double click maps to the addon actions', () => {
  const key = 'gsettings get org.gnome.desktop.wm.preferences action-double-click-titlebar'
  expect(readTitlebarDoubleClick(answers({ [key]: "'toggle-maximize'\n" }))).toBe('maximize')
  expect(readTitlebarDoubleClick(answers({ [key]: "'minimize'\n" }))).toBe('minimize')
  expect(readTitlebarDoubleClick(answers({ [key]: "'menu'\n" }))).toBe('menu')
  expect(readTitlebarDoubleClick(answers({ [key]: "'lower'\n" }))).toBe('none')
  expect(readTitlebarDoubleClick(answers({ [key]: "'none'\n" }))).toBe('none')
  expect(readTitlebarDoubleClick(answers({}))).toBe('maximize')
})
