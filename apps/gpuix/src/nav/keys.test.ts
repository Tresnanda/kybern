import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { EventPayload } from '@gpuix/react'
import { setKeyPlatform } from '../platform/keys.ts'
import { getState, set } from '../state.ts'
import { noteTerminalFocus, terminalHasFocus } from '../terminal/focus.ts'
import { addWindowKeyHandler, onWindowKeyDown } from './keys.ts'
import { getNav, setNav } from './store.ts'

const press = (key: string, modifiers: Partial<NonNullable<EventPayload['modifiers']>>) => onWindowKeyDown({ key, modifiers: { cmd: false, ctrl: false, alt: false, shift: false, ...modifiers } } as unknown as EventPayload)

let restore: (() => void) | null = null
beforeEach(() => {
  setNav({ page: 'home', settingsOpen: false, paletteOpen: false, keyboardNav: false })
  set({ sidebarOpen: true })
})
afterEach(() => {
  restore?.(); restore = null
  while (terminalHasFocus()) noteTerminalFocus(false)
})

describe('macOS window shortcuts', () => {
  beforeEach(() => { restore = setKeyPlatform('darwin') })
  test('⌘K opens the palette and ⌘B the sidebar; ⌃K does neither', () => {
    press('k', { cmd: true })
    expect(getNav().paletteOpen).toBe(true)
    press('k', { cmd: true })
    press('b', { cmd: true })
    expect(getState().sidebarOpen).toBe(false)
    press('k', { ctrl: true })
    expect(getNav().paletteOpen).toBe(false)
  })
  test('⌘[ goes back (out of Settings); ⌥← does not', () => {
    setNav({ settingsOpen: true })
    press('left', { alt: true })
    expect(getNav().settingsOpen).toBe(true)
    press('[', { cmd: true })
    expect(getNav().settingsOpen).toBe(false)
  })
  test('a focused terminal does not hold back ⌘ shortcuts', () => {
    noteTerminalFocus(true)
    press('k', { cmd: true })
    expect(getNav().paletteOpen).toBe(true)
  })
})

for (const platform of ['win32', 'linux'] as const) describe(`${platform} window shortcuts`, () => {
  beforeEach(() => { restore = setKeyPlatform(platform) })
  test('Ctrl+K opens the palette, Ctrl+B toggles the sidebar, Ctrl+, opens Settings', () => {
    press('k', { ctrl: true })
    expect(getNav().paletteOpen).toBe(true)
    expect(getNav().keyboardNav).toBe(true)
    press('k', { ctrl: true })
    expect(getNav().paletteOpen).toBe(false)
    press('b', { ctrl: true })
    expect(getState().sidebarOpen).toBe(false)
    press(',', { ctrl: true })
    expect(getNav().settingsOpen).toBe(true)
  })
  test('Alt+← goes back (out of Settings); Ctrl+[ does not', () => {
    setNav({ settingsOpen: true })
    press('[', { ctrl: true })
    expect(getNav().settingsOpen).toBe(true)
    press('left', { alt: true })
    expect(getNav().settingsOpen).toBe(false)
  })
  test('the Windows / Super key is not the shortcut key', () => {
    press('k', { cmd: true })
    expect(getNav().paletteOpen).toBe(false)
    press('b', { cmd: true })
    expect(getState().sidebarOpen).toBe(true)
  })
  test('a focused terminal keeps Ctrl+key and Alt+key; Ctrl+Shift shortcuts still reach the app', () => {
    noteTerminalFocus(true)
    const seen: string[] = []
    const off = addWindowKeyHandler(e => { seen.push(e.key ?? ''); return false })
    press('k', { ctrl: true })
    press('b', { ctrl: true })
    press('left', { alt: true })
    expect(getNav().paletteOpen).toBe(false)
    expect(getState().sidebarOpen).toBe(true)
    expect(seen).toEqual([])
    press('n', { ctrl: true, shift: true })
    expect(seen).toEqual(['n'])
    off()
    noteTerminalFocus(false)
    press('k', { ctrl: true })
    expect(getNav().paletteOpen).toBe(true)
  })
})
