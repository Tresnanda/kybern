import { afterEach, describe, expect, test } from 'bun:test'
import { isAltGrText, isAltOnly, isBackKey, isEmacsCtrl, isFocusGroupModifier, isForwardKey, isOpenParentKey, isOtherCommand, isPrimary, isPrimaryChord, isPrimaryNotAltGr, isSpaceModifier, keyCaps, setKeyPlatform, SHORTCUT, shortcutCaps, shortcutLabel } from './keys.ts'

let restore: (() => void) | null = null
const on = (platform: NodeJS.Platform) => { restore?.(); restore = setKeyPlatform(platform) }
afterEach(() => { restore?.(); restore = null })

describe('macOS', () => {
  test('⌘ is primary and ⌃ the excluded key', () => {
    on('darwin')
    expect(isPrimary({ cmd: true })).toBe(true)
    expect(isPrimary({ ctrl: true })).toBe(false)
    expect(isOtherCommand({ ctrl: true })).toBe(true)
    expect(isPrimaryChord({ cmd: true })).toBe(true)
    expect(isPrimaryChord({ cmd: true, ctrl: true })).toBe(false)
    expect(isPrimaryChord({ cmd: true, shift: true })).toBe(false)
    expect(isPrimaryChord({ cmd: true, shift: true }, { shift: true })).toBe(true)
    expect(isPrimaryChord({ cmd: true, shift: true }, { shift: 'any' })).toBe(true)
    expect(isPrimaryChord({ cmd: true, alt: true }, { alt: true })).toBe(true)
    expect(isEmacsCtrl({ ctrl: true })).toBe(true)
  })
  test('labels are unchanged', () => {
    on('darwin')
    for (const label of ['⌘⇧S', '⌘↵', '⌘,', '⌃Tab', '⌥-click', 'Toggle sidebar (⌘B)', 'Send ↵', '⌘+Enter']) expect(shortcutLabel(label)).toBe(label)
    expect(keyCaps(['⇧', '⌘', '↵'])).toEqual(['⇧', '⌘', '↵'])
  })
  test('history, parent, spaces and terminal shortcuts keep their ⌘ and ⌃ keys', () => {
    on('darwin')
    expect(isBackKey({ key: '[', modifiers: { cmd: true } })).toBe(true)
    expect(isBackKey({ key: 'left', modifiers: { alt: true } })).toBe(false)
    expect(isForwardKey({ key: ']', modifiers: { cmd: true } })).toBe(true)
    expect(isOpenParentKey({ key: 'up', modifiers: { cmd: true } })).toBe(true)
    expect(isSpaceModifier({ ctrl: true })).toBe(true)
    expect(isSpaceModifier({ alt: true })).toBe(false)
    expect([SHORTCUT.back, SHORTCUT.forward, SHORTCUT.openParent, SHORTCUT.space, SHORTCUT.terminalCopy, SHORTCUT.terminalLatest]).toEqual(['⌘[', '⌘]', '⌘↑', '⌃', '⌘C', '⌘End'])
  })
})

for (const platform of ['win32', 'linux'] as const) describe(platform, () => {
  test('Ctrl is primary; the Windows / Super key is excluded', () => {
    on(platform)
    expect(isPrimary({ ctrl: true })).toBe(true)
    expect(isPrimary({ cmd: true })).toBe(false)
    expect(isOtherCommand({ cmd: true })).toBe(true)
    expect(isPrimaryChord({ ctrl: true })).toBe(true)
    expect(isPrimaryChord({ ctrl: true, cmd: true })).toBe(false)
    expect(isPrimaryChord({ cmd: true })).toBe(false)
    expect(isPrimaryChord({ ctrl: true, shift: true }, { shift: true })).toBe(true)
    expect(isEmacsCtrl({ ctrl: true })).toBe(false)
    // AltGr arrives as Ctrl+Alt: never Alt alone.
    expect(isAltOnly({ ctrl: true, alt: true })).toBe(false)
    expect(isAltOnly({ alt: true })).toBe(true)
  })
  test('glyph labels read as key names', () => {
    on(platform)
    expect(shortcutLabel('⌘⇧S')).toBe('Ctrl+Shift+S')
    expect(shortcutLabel('⌘↵')).toBe('Ctrl+Enter')
    expect(shortcutLabel('⌘,')).toBe('Ctrl+,')
    expect(shortcutLabel('⌃Tab')).toBe('Ctrl+Tab')
    expect(shortcutLabel('⌃⇧Tab')).toBe('Ctrl+Shift+Tab')
    expect(shortcutLabel('⌥-click')).toBe('Alt-click')
    expect(shortcutLabel('⌘⌥C')).toBe('Ctrl+Alt+C')
    expect(shortcutLabel('⇧⌘↵')).toBe('Ctrl+Shift+Enter')
    expect(shortcutLabel('⌘⌫')).toBe('Ctrl+Backspace')
    expect(shortcutLabel('⌘End')).toBe('Ctrl+End')
    expect(shortcutLabel('⌘\\')).toBe('Ctrl+\\')
    expect(shortcutLabel('⌘⇧9')).toBe('Ctrl+Shift+9')
    expect(shortcutLabel('↵')).toBe('Enter')
    expect(shortcutLabel('↑↓')).toBe('↑↓')
    expect(shortcutLabel('Toggle sidebar (⌘B)')).toBe('Toggle sidebar (Ctrl+B)')
    expect(shortcutLabel('Open right sidebar (⌘J)')).toBe('Open right sidebar (Ctrl+J)')
    expect(shortcutLabel('Bold ⌘B')).toBe('Bold Ctrl+B')
    expect(shortcutLabel('Steer now ⌘↵')).toBe('Steer now Ctrl+Enter')
    expect(shortcutLabel('Send ↵')).toBe('Send Enter')
    expect(shortcutLabel('Guide the current turn immediately · ⌘+Enter')).toBe('Guide the current turn immediately · Ctrl+Enter')
    expect(shortcutLabel('Back (⌥←)')).toBe('Back (Alt+←)')
  })
  test('key caps', () => {
    on(platform)
    expect(keyCaps(['⌘', 'N'])).toEqual(['Ctrl', 'N'])
    expect(keyCaps(['⇧', '⌘', '↵'])).toEqual(['Ctrl', 'Shift', 'Enter'])
    expect(keyCaps(['⌥', '⌘', 'N'])).toEqual(['Ctrl', 'Alt', 'N'])
    expect(keyCaps(['↑', '↓'])).toEqual(['↑', '↓'])
    expect(keyCaps(['esc'])).toEqual(['esc'])
    expect(keyCaps(shortcutCaps(SHORTCUT.back))).toEqual(['Alt', '←'])
  })
  test('back, forward and parent are Alt+arrows; spaces take Alt; the terminal takes Ctrl+Shift', () => {
    on(platform)
    expect(isBackKey({ key: 'left', modifiers: { alt: true } })).toBe(true)
    expect(isBackKey({ key: '[', modifiers: { ctrl: true } })).toBe(false)
    expect(isBackKey({ key: 'left', modifiers: { alt: true, ctrl: true } })).toBe(false)
    expect(isForwardKey({ key: 'right', modifiers: { alt: true } })).toBe(true)
    expect(isOpenParentKey({ key: 'up', modifiers: { alt: true } })).toBe(true)
    expect(isOpenParentKey({ key: 'up', modifiers: { ctrl: true } })).toBe(false)
    expect(isSpaceModifier({ alt: true })).toBe(true)
    expect(isSpaceModifier({ ctrl: true })).toBe(false)
    expect(shortcutLabel(SHORTCUT.terminalCopy)).toBe('Ctrl+Shift+C')
    expect(shortcutLabel(SHORTCUT.terminalPaste)).toBe('Ctrl+Shift+V')
    expect(shortcutLabel(SHORTCUT.terminalFind)).toBe('Ctrl+Shift+F')
    expect(shortcutLabel(SHORTCUT.terminalLatest)).toBe('Ctrl+Shift+End')
    expect(shortcutLabel(SHORTCUT.openParent)).toBe('Alt+↑')
  })
})

test('shortcutCaps splits modifiers from the key', () => {
  expect(shortcutCaps('⌘⇧S')).toEqual(['⌘', '⇧', 'S'])
  expect(shortcutCaps('⌘End')).toEqual(['⌘', 'End'])
  expect(shortcutCaps('⌥-click')).toEqual(['⌥', '-click'])
  expect(shortcutCaps('⌥←')).toEqual(['⌥', '←'])
})

test('focus group: ⌘⌥ on macOS, Alt+Shift elsewhere (not Ctrl+Alt: GNOME workspaces, Intel rotation, AltGr)', () => {
  const m = (mods: { cmd?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean }) => ({ cmd: false, ctrl: false, alt: false, shift: false, ...mods })
  let restore = setKeyPlatform('darwin')
  try {
    expect(isFocusGroupModifier(m({ cmd: true, alt: true }))).toBe(true)
    expect(isFocusGroupModifier(m({ alt: true, shift: true }))).toBe(false)
    expect(SHORTCUT.focusGroup).toBe('⌘⌥')
  } finally { restore() }
  for (const platform of ['win32', 'linux'] as const) {
    restore = setKeyPlatform(platform)
    try {
      expect(isFocusGroupModifier(m({ alt: true, shift: true }))).toBe(true)
      expect(isFocusGroupModifier(m({ ctrl: true, alt: true }))).toBe(false)
      expect(isFocusGroupModifier(m({ ctrl: true, alt: true, shift: true }))).toBe(false)
      expect(isFocusGroupModifier(m({ alt: true }))).toBe(false)
      expect(shortcutLabel(SHORTCUT.focusGroup + '←')).toBe('Alt+Shift+←')
    } finally { restore() }
  }
})

test('AltGr: Ctrl+Alt with a composed character is text, and primary shortcuts off macOS skip it', () => {
  const ev = (key: string, keyChar: string | undefined, mods: { cmd?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean }) => ({ key, keyChar, modifiers: { cmd: false, ctrl: false, alt: false, shift: false, ...mods } })
  expect(isAltGrText(ev('q', '@', { ctrl: true, alt: true }))).toBe(true)
  expect(isAltGrText(ev('7', '{', { ctrl: true, alt: true }))).toBe(true)
  expect(isAltGrText(ev('q', 'q', { ctrl: true, alt: true }))).toBe(false)
  expect(isAltGrText(ev('q', undefined, { ctrl: true, alt: true }))).toBe(false)
  expect(isAltGrText(ev('q', '@', { ctrl: true }))).toBe(false)
  expect(isAltGrText(ev('q', '@', { ctrl: true, alt: true, cmd: true }))).toBe(false)
  let restore = setKeyPlatform('win32')
  try {
    expect(isPrimaryNotAltGr({ ctrl: true })).toBe(true)
    expect(isPrimaryNotAltGr({ ctrl: true, alt: true })).toBe(false)
  } finally { restore() }
  restore = setKeyPlatform('darwin')
  try {
    expect(isPrimaryNotAltGr({ cmd: true, alt: true })).toBe(true)
  } finally { restore() }
})
