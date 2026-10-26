import { expect, test } from 'bun:test'
import { installerName, nsisIncludes, vcRuntimeCandidates, versionQuad } from './lib.ts'

test('version numbers become the four-part form', () => {
  expect(versionQuad('0.15.1')).toBe('0.15.1.0')
  expect(versionQuad('1.20.3-rc.1')).toBe('1.20.3.0')
  expect(() => versionQuad('latest')).toThrow('Not a release version')
})

test('the installer asset name matches the other GPUIX release assets', () => {
  expect(installerName('0.15.1')).toBe('kybern-gpuix_0.15.1_x64-setup.exe')
})

test('the NSIS includes install and remove exactly the payload', () => {
  const { install, uninstall } = nsisIncludes([
    { name: 'src', directory: true },
    { name: 'kybernd.exe', directory: false },
    { name: 'Kybern GPUIX.exe', directory: false },
  ], 'C:\\work\\payload')
  expect(install.split('\r\n').filter(Boolean)).toEqual([
    '!insertmacro InstallFile "Kybern GPUIX.exe" "C:\\work\\payload\\Kybern GPUIX.exe"',
    '!insertmacro InstallFile "kybernd.exe" "C:\\work\\payload\\kybernd.exe"',
    'SetOutPath "$INSTDIR\\src"',
    'SetOverwrite try',
    'ClearErrors',
    'File /r "C:\\work\\payload\\src\\*.*"',
    '!insertmacro CheckWrite "src"',
    'SetOutPath "$INSTDIR"',
  ])
  expect(uninstall.split('\r\n').filter(Boolean)).toEqual([
    'Delete /REBOOTOK "$INSTDIR\\Kybern GPUIX.exe"',
    'Delete /REBOOTOK "$INSTDIR\\kybernd.exe"',
    'RMDir /r /REBOOTOK "$INSTDIR\\src"',
  ])
})

test('names that NSIS would interpret are refused', () => {
  expect(() => nsisIncludes([{ name: 'a"b.exe', directory: false }], 'C:\\p')).toThrow('Unsupported file name')
  expect(() => nsisIncludes([{ name: '$INSTDIR', directory: true }], 'C:\\p')).toThrow('Unsupported file name')
})

test('the newest C++ runtime folder is tried first', () => {
  expect(vcRuntimeCandidates(['Microsoft.VC142.CRT', 'Microsoft.VC143.CRT', 'onecore', 'Microsoft.VC143.DebugCRT'])).toEqual(['Microsoft.VC143.CRT', 'Microsoft.VC142.CRT'])
})
