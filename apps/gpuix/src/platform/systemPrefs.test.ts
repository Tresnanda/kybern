import { expect, test } from 'bun:test'
import { parseGsettingsList, parseMonitorLine, parseTitlebarDoubleClick, readLinuxReducedMotion, readSystemVariant } from './systemPrefs.ts'

const answers = (map: Record<string, string | null>) => (command: string, args: string[]) => map[[command, ...args].join(' ')] ?? null
const LIST = 'gsettings list-recursively org.gnome.desktop.interface'
const keys = (lines: Record<string, string>) => answers({ [LIST]: Object.entries(lines).map(([k, v]) => `org.gnome.desktop.interface ${k} ${v}`).join('\n') + '\n' })
const none = answers({})

test('Windows reads AppsUseLightTheme from the registry', () => {
  const dword = (value: number | null) => (subkey: string, name: string) => subkey.endsWith('Themes\\Personalize') && name === 'AppsUseLightTheme' ? value : null
  expect(readSystemVariant('win32', none, dword(0))).toBe('dark')
  expect(readSystemVariant('win32', none, dword(1))).toBe('light')
  expect(readSystemVariant('win32', none, dword(null))).toBeNull()
})

test('Linux reads color-scheme, then the GTK theme name, in one gsettings call', () => {
  expect(readSystemVariant('linux', keys({ 'color-scheme': "'prefer-dark'" }))).toBe('dark')
  expect(readSystemVariant('linux', keys({ 'color-scheme': "'prefer-light'" }))).toBe('light')
  expect(readSystemVariant('linux', keys({ 'color-scheme': "'default'", 'gtk-theme': "'Yaru-dark'" }))).toBe('dark')
  expect(readSystemVariant('linux', keys({ 'color-scheme': "'default'", 'gtk-theme': "'Adwaita'" }))).toBe('light')
  expect(readSystemVariant('linux', none)).toBeNull()
  expect(readSystemVariant('darwin', keys({ 'color-scheme': "'prefer-dark'" }))).toBeNull()
})

test('gsettings list-recursively lines are read by key, for that schema only', () => {
  const out = "org.gnome.desktop.interface color-scheme 'prefer-dark'\norg.gnome.desktop.interface font-name 'Cantarell 11'\norg.gnome.other color-scheme 'x'\n"
  const map = parseGsettingsList(out, 'org.gnome.desktop.interface')
  expect(map.get('color-scheme')).toBe("'prefer-dark'")
  expect(map.get('font-name')).toBe("'Cantarell 11'")
  expect(map.size).toBe(2)
  expect(parseGsettingsList(null, 'org.gnome.desktop.interface').size).toBe(0)
})

test('GNOME enable-animations false is reduced motion', () => {
  expect(readLinuxReducedMotion(keys({ 'enable-animations': 'false' }))).toBe(true)
  expect(readLinuxReducedMotion(keys({ 'enable-animations': 'true' }))).toBe(false)
  expect(readLinuxReducedMotion(none)).toBeNull()
})

test('GNOME title-bar double click maps to the addon actions', () => {
  expect(parseTitlebarDoubleClick("'toggle-maximize'\n")).toBe('maximize')
  expect(parseTitlebarDoubleClick("'minimize'")).toBe('minimize')
  expect(parseTitlebarDoubleClick("'menu'")).toBe('menu')
  expect(parseTitlebarDoubleClick("'lower'")).toBe('none')
  expect(parseTitlebarDoubleClick("'none'")).toBe('none')
  expect(parseTitlebarDoubleClick(null)).toBe('maximize')
})

test('gsettings monitor lines give the key and value', () => {
  expect(parseMonitorLine('enable-animations: false')).toEqual({ key: 'enable-animations', value: 'false' })
  expect(parseMonitorLine("action-double-click-titlebar: 'minimize'")).toEqual({ key: 'action-double-click-titlebar', value: "'minimize'" })
  expect(parseMonitorLine('')).toBeNull()
  expect(parseMonitorLine('enable-animations:')).toBeNull()
})
