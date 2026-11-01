import { expect, test } from 'bun:test'
import { activeDriver, computerOs, driverHint, driverSetting, noteKey, offeredDrivers, thisComputer } from './computerModel.ts'

test('platform words follow status, then the local OS', () => {
  expect(thisComputer(computerOs({ platform: 'macos' }))).toBe('this Mac')
  expect(thisComputer(computerOs({ platform: 'windows' }, 'darwin'))).toBe('this PC')
  expect(thisComputer(computerOs({ platform: 'linux' }, 'darwin'))).toBe('this computer')
  expect(thisComputer(computerOs(null, 'win32'))).toBe('this PC')
  expect(thisComputer(computerOs({ platform: null }, 'linux'))).toBe('this computer')
})
test('older daemons without drivers fall back to the platform', () => {
  expect(offeredDrivers({}, 'macos')).toEqual(['cua_driver'])
  expect(offeredDrivers({}, 'windows')).toEqual(['agent_desktop'])
  expect(offeredDrivers({ drivers: ['cua_driver', 'agent_desktop'] }, 'macos')).toEqual(['cua_driver', 'agent_desktop'])
  expect(activeDriver({}, 'linux')).toBe('agent_desktop')
  expect(activeDriver({ driver: 'agent_desktop', drivers: ['cua_driver', 'agent_desktop'] }, 'macos')).toBe('agent_desktop')
  expect(activeDriver({ drivers: ['cua_driver', 'agent_desktop'] }, 'macos', 'agent_desktop')).toBe('agent_desktop')
  expect(activeDriver({}, 'macos', 'agent_desktop')).toBe('cua_driver')
})
test('the default driver clears the setting', () => {
  const offered = ['cua_driver', 'agent_desktop'] as const
  expect(driverSetting('cua_driver', [...offered])).toBeNull()
  expect(driverSetting('agent_desktop', [...offered])).toBe('agent_desktop')
  expect(driverHint('macos', true)).toContain('this Mac only')
})
test('notes key by app id', () => {
  expect(noteKey({ bundle_id: 'a', app_id: 'code.exe' })).toBe('code.exe')
  expect(noteKey({ bundle_id: 'a' })).toBe('a')
})
import { checkTitle } from './computerModel.ts'
test('check titles', () => {
  expect(checkTitle('uia')).toBe('UI Automation')
  expect(checkTitle('some_new_check')).toBe('Some new check')
})
