import { expect, test } from 'bun:test'
import { setKeyPlatform } from '../platform/keys.ts'
import { actionParts, keyGlyphs } from './action.ts'
test('quoted subjects and key chords split like the desktop caption', () => {
  expect(actionParts('Pressed “Continue”')).toEqual([{ text: 'Pressed', subject: false }, { text: 'Continue', subject: true }])
  expect(actionParts('Pressed cmd+shift+s')).toEqual([{ text: 'Pressed', subject: false }, { text: '⌘⇧S', subject: true, keys: true }])
  expect(actionParts('Scrolled down')).toEqual([{ text: 'Scrolled down', subject: true }])
  expect(keyGlyphs('ctrl+return')).toBe('⌃↩')
})
test('off macOS the chord names its keys', () => {
  const restore = setKeyPlatform('win32')
  try {
    expect(keyGlyphs('ctrl+shift+s')).toBe('Ctrl+Shift+S')
    expect(keyGlyphs('cmd+return')).toBe('Win+Enter')
    expect(keyGlyphs('alt+left')).toBe('Alt+←')
  } finally { restore() }
  const linux = setKeyPlatform('linux')
  try { expect(keyGlyphs('cmd+space')).toBe('Super+Space') } finally { linux() }
})
