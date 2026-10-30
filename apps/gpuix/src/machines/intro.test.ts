import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { INTRO_FILE, introAction, introChoice, recordIntroChoice, tailscaleNote } from './intro.ts'

let dir = ''
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'kybern-intro-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
const off = { enabled: false }
const on = { enabled: true }

test('shows once the network is known to be off and the first run has ended', () => {
  expect(introAction({ decided: false, status: off, onboarding: false })).toBe('show')
  expect(introAction({ decided: false, status: off, onboarding: true })).toBe('wait')
  expect(introAction({ decided: false, status: null, onboarding: false })).toBe('wait')
})
test('never shows after an answer, while the network is on, or on a daemon without it', () => {
  expect(introAction({ decided: true, status: off, onboarding: false })).toBe('none')
  expect(introAction({ decided: false, status: on, onboarding: false })).toBe('record-on')
  expect(introAction({ decided: false, status: on, onboarding: true })).toBe('record-on')
  expect(introAction({ decided: false, status: false, onboarding: false })).toBe('none')
})
test('either answer is remembered across restarts', () => {
  expect(introChoice(dir)).toBeNull()
  recordIntroChoice(dir, 'later')
  expect(introChoice(dir)).toBe('later')
  recordIntroChoice(dir, 'on')
  expect(introChoice(dir)).toBe('on')
  expect(introAction({ decided: !!introChoice(dir), status: off, onboarding: false })).toBe('none')
})
test('a missing folder or a damaged file reads as not answered', () => {
  expect(introChoice(path.join(dir, 'nope'))).toBeNull()
  writeFileSync(path.join(dir, INTRO_FILE), '{"choice":"maybe"}')
  expect(introChoice(dir)).toBeNull()
  writeFileSync(path.join(dir, INTRO_FILE), 'not json')
  expect(introChoice(dir)).toBeNull()
})
test('the requirement line reads Tailscale', () => {
  expect(tailscaleNote(undefined)).toBe('unknown')
  expect(tailscaleNote({ installed: false, running: false })).toBe('missing')
  expect(tailscaleNote({ installed: true, running: false })).toBe('stopped')
  expect(tailscaleNote({ installed: true, running: true })).toBe('running')
})
