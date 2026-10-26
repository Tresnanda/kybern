import { expect, test } from 'bun:test'
import { setKeyPlatform } from '../platform/keys.ts'
import { terminalCommand, terminalKey, terminalViewportKey } from './keys.ts'

const key = (k: string, modifiers: { cmd?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean }) => ({ key: k, modifiers: { cmd: false, ctrl: false, alt: false, shift: false, ...modifiers } })

test('macOS: ⌘C ⌘V ⌘F ⌘End and ⌘A are the terminal\'s; ⌃C reaches the shell', () => {
  const restore = setKeyPlatform('darwin')
  try {
    expect(terminalCommand(key('c', { cmd: true }))).toBe('copy')
    expect(terminalCommand(key('v', { cmd: true }))).toBe('paste')
    expect(terminalCommand(key('f', { cmd: true }))).toBe('find')
    expect(terminalCommand(key('end', { cmd: true }))).toBe('latest')
    expect(terminalViewportKey(key('a', { cmd: true }))).toBe('selectall')
    expect(terminalCommand(key('c', { ctrl: true }))).toBeNull()
    expect(terminalKey(key('c', { ctrl: true }))).toBe('\x03')
  } finally { restore() }
})

for (const platform of ['win32', 'linux'] as const) test(`${platform}: Ctrl+Shift+C/V/F/End/A are the terminal's; Ctrl+C/V/F/A reach the shell`, () => {
  const restore = setKeyPlatform(platform)
  try {
    expect(terminalCommand(key('c', { ctrl: true, shift: true }))).toBe('copy')
    expect(terminalCommand(key('v', { ctrl: true, shift: true }))).toBe('paste')
    expect(terminalCommand(key('f', { ctrl: true, shift: true }))).toBe('find')
    expect(terminalCommand(key('end', { ctrl: true, shift: true }))).toBe('latest')
    expect(terminalViewportKey(key('a', { ctrl: true, shift: true }))).toBe('selectall')
    for (const k of ['c', 'v', 'f']) expect(terminalCommand(key(k, { ctrl: true }))).toBeNull()
    expect(terminalViewportKey(key('a', { ctrl: true }))).toBeNull()
    expect(terminalCommand(key('c', { cmd: true }))).toBeNull()
    expect(terminalKey(key('c', { ctrl: true }))).toBe('\x03')
    expect(terminalKey(key('a', { ctrl: true }))).toBe('\x01')
    // Ctrl+Shift+C sends nothing of its own to the shell.
    expect(terminalKey(key('c', { ctrl: true, shift: true }))).toBeNull()
  } finally { restore() }
})

for (const platform of ['win32', 'linux'] as const) test(`${platform}: AltGr (Ctrl+Alt with a composed character) types the character`, () => {
  const restore = setKeyPlatform(platform)
  try {
    // German layout: AltGr+Q is `@`, AltGr+7 is `{`, AltGr+E is `€`.
    expect(terminalKey({ ...key('q', { ctrl: true, alt: true }), keyChar: '@' })).toBe('@')
    expect(terminalKey({ ...key('7', { ctrl: true, alt: true }), keyChar: '{' })).toBe('{')
    expect(terminalKey({ ...key('e', { ctrl: true, alt: true }), keyChar: '€' })).toBe('€')
    expect(terminalKey({ ...key('ß', { ctrl: true, alt: true }), keyChar: '\\' })).toBe('\\')
    // Ctrl+Alt with nothing composed behaves as before.
    expect(terminalKey(key('a', { ctrl: true, alt: true }))).toBeNull()
    expect(terminalKey({ ...key('a', { ctrl: true, alt: true }), keyChar: 'a' })).toBeNull()
    expect(terminalKey({ ...key('a', { ctrl: true, alt: true }), keyChar: '\x01' })).toBeNull()
    expect(terminalKey({ ...key('2', { ctrl: true, alt: true }), keyChar: '@' })).toBe('@')
    expect(terminalKey({ ...key('2', { ctrl: true }), keyChar: '@' })).toBe('\0')
  } finally { restore() }
})

test('macOS: ⌃⌥ with a composed character is not AltGr', () => {
  const restore = setKeyPlatform('darwin')
  try {
    expect(terminalKey({ ...key('2', { ctrl: true, alt: true }), keyChar: '@' })).toBe('\0')
  } finally { restore() }
})
