import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import type { EventPayload } from '@gpuix/react'
import type { Project, Space } from '../../../../packages/kybern-client/src/types.ts'
import { getNav, setNav } from '../nav/store.ts'
import { set } from '../state.ts'
import { noteTerminalFocus } from '../terminal/focus.ts'
import { setKeyPlatform } from '../platform/keys.ts'
import { spaceForDigit, spaceKey } from './keys.ts'
import { startSpaces } from './current.ts'
import { setSpacesState } from './store.ts'

// Written for macOS shortcuts (⌘, ⌃); the off-macOS cases set their platform themselves. CI runs these on Linux.
const restoreKeys = setKeyPlatform('darwin')
afterAll(() => restoreKeys())

const space = (id: string, position: number): Space => ({
  id, name: id, color: 'blue', logo: { kind: 'initials' }, position, is_default: position === 0, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
})
const project = (id: string, space_id: string): Project => ({ id, name: id, path: `/${id}`, is_git: false, brief_in_all_threads: false, space_id }) as unknown as Project
const press = (key: string, modifiers: Partial<NonNullable<EventPayload['modifiers']>> = { ctrl: true }) => ({ key, modifiers } as unknown as EventPayload)

startSpaces()

beforeEach(() => {
  setSpacesState({ supported: true, spaces: [space('s1', 0), space('s2', 1), space('s3', 2)] })
  set({ projects: [project('a', 's1'), project('b', 's2'), project('c', 's3')], selectedId: null, draft: {} })
  setNav({ spaceId: 's1', keyboardNav: false, spaceViews: {} })
})

test('digit mapping: 1–8 by position, 9 the last', () => {
  expect(spaceForDigit(1, 3)).toBe(0)
  expect(spaceForDigit(3, 3)).toBe(2)
  expect(spaceForDigit(5, 3)).toBeNull()
  expect(spaceForDigit(9, 3)).toBe(2)
  expect(spaceForDigit(9, 12)).toBe(11)
  expect(spaceForDigit(0, 3)).toBeNull()
})

describe('spaceKey', () => {
  test('⌃2 picks the second space and marks the change as keyboard-driven', () => {
    expect(spaceKey(press('2'))).toBe(true)
    expect(getNav().spaceId).toBe('s2')
    expect(getNav().keyboardNav).toBe(true)
  })
  test('⌃1 picks the first, ⌃9 the last', () => {
    spaceKey(press('3'))
    expect(spaceKey(press('1'))).toBe(true)
    expect(getNav().spaceId).toBe('s1')
    expect(spaceKey(press('9'))).toBe(true)
    expect(getNav().spaceId).toBe('s3')
  })
  test('a digit beyond the list is not consumed', () => {
    expect(spaceKey(press('5'))).toBe(false)
    expect(getNav().spaceId).toBe('s1')
  })
  test('other modifiers are left alone', () => {
    expect(spaceKey(press('2', { ctrl: true, shift: true }))).toBe(false)
    expect(spaceKey(press('2', { cmd: true }))).toBe(false)
    expect(spaceKey(press('2', { ctrl: true, alt: true }))).toBe(false)
    expect(spaceKey(press('2', {}))).toBe(false)
  })
  test('ignored while a terminal has focus', () => {
    noteTerminalFocus(true)
    expect(spaceKey(press('2'))).toBe(false)
    noteTerminalFocus(false)
    expect(spaceKey(press('2'))).toBe(true)
  })
  test('ignored with one space or an old daemon', () => {
    setSpacesState({ supported: true, spaces: [space('s1', 0)] })
    expect(spaceKey(press('1'))).toBe(false)
    setSpacesState({ supported: false, spaces: [] })
    expect(spaceKey(press('2'))).toBe(false)
  })
})

describe('spaceKey off macOS', () => {
  // Ctrl+1–9 pick tabs there, so spaces take Alt+1–9.
  test('Alt+2 picks the second space; Ctrl+2 is left to the tabs', () => {
    const restore = setKeyPlatform('win32')
    try {
      expect(spaceKey(press('2', { ctrl: true }))).toBe(false)
      expect(spaceKey(press('2', { alt: true }))).toBe(true)
      expect(getNav().spaceId).toBe('s2')
      // AltGr arrives as Ctrl+Alt.
      expect(spaceKey(press('3', { ctrl: true, alt: true }))).toBe(false)
      noteTerminalFocus(true)
      expect(spaceKey(press('3', { alt: true }))).toBe(false)
      noteTerminalFocus(false)
    } finally { restore() }
  })
})
