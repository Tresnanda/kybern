import { expect, test } from 'bun:test'
import { parseGsettingsBool, parsePortalContrast, readOsDisplay, solidReason } from './osDisplay.ts'

test('reads gsettings and portal replies', () => {
  expect(parseGsettingsBool('true\n')).toBe(true)
  expect(parseGsettingsBool('false')).toBe(false)
  expect(parseGsettingsBool('high-contrast: true')).toBe(true)
  expect(parseGsettingsBool('No such schema “org.gnome.desktop.a11y.interface”')).toBe(null)
  expect(parsePortalContrast('(<uint32 1>,)')).toBe(true)
  expect(parsePortalContrast('(<<uint32 0>>,)')).toBe(false)
  expect(parsePortalContrast('Error: GDBus.Error:org.freedesktop.portal.Error.NotFound')).toBe(null)
})

test('names the setting that keeps Kybern solid in each OS’s words', () => {
  const off = { reduceTransparency: false, increaseContrast: false }
  for (const platform of ['darwin', 'win32', 'linux'] as const) expect(solidReason(off, platform)).toBeUndefined()
  expect(solidReason({ reduceTransparency: true, increaseContrast: false }, 'darwin')).toBe('Reduce transparency is on in System Settings, so Kybern stays solid.')
  expect(solidReason({ reduceTransparency: true, increaseContrast: true }, 'darwin')).toContain('Reduce transparency and Increase contrast')
  expect(solidReason({ reduceTransparency: true, increaseContrast: false }, 'win32')).toBe('Transparency effects are off in Windows Settings, so Kybern stays solid.')
  expect(solidReason({ reduceTransparency: false, increaseContrast: true }, 'win32')).toBe('A contrast theme is on in Windows Settings, so Kybern stays solid.')
  expect(solidReason({ reduceTransparency: false, increaseContrast: true }, 'linux')).toBe('High contrast is on in your system settings, so Kybern stays solid.')
})

test('macOS is read by material.ts, not here', () => {
  expect(readOsDisplay('darwin')).toBeNull()
})
