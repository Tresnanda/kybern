import { expect, test } from 'bun:test'
import { actionParts, keyGlyphs } from './action.ts'
test('quoted subjects and key chords split like the desktop caption', () => {
  expect(actionParts('Pressed “Continue”')).toEqual([{ text: 'Pressed', subject: false }, { text: 'Continue', subject: true }])
  expect(actionParts('Pressed cmd+shift+s')).toEqual([{ text: 'Pressed', subject: false }, { text: '⌘⇧S', subject: true, keys: true }])
  expect(actionParts('Scrolled down')).toEqual([{ text: 'Scrolled down', subject: true }])
  expect(keyGlyphs('ctrl+return')).toBe('⌃↩')
})
