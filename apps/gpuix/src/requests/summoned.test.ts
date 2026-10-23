import { describe, expect, test } from 'bun:test'
import { isStale } from './progress.ts'
import { codeRuns } from './summoned.tsx'
import { loginView } from './Login.tsx'
import { permissionView } from './Permission.tsx'

describe('summoned cards', () => {
  test('splits backticked runs as code', () => {
    expect(codeRuns('`gh` for this Mac')).toEqual([{ text: 'gh', code: true }, { text: ' for this Mac', code: false }])
    expect(codeRuns('no code')).toEqual([{ text: 'no code', code: false }])
  })

  test('maps the sign-in phases to the card body', () => {
    expect(loginView(undefined)).toBe('ask')
    expect(loginView('asking')).toBe('ask')
    expect(loginView('failed')).toBe('ask')
    expect(loginView('waiting')).toBe('wait')
    expect(loginView('verifying')).toBe('wait')
    expect(loginView('paste_code')).toBe('paste')
    expect(loginView('done')).toBe('done')
  })

  test('maps the permission phases to the card body', () => {
    expect(permissionView(undefined)).toBe('ask')
    expect(permissionView('waiting')).toBe('wait')
    expect(permissionView('not_granted')).toBe('off')
    expect(permissionView('done')).toBe('done')
  })

  test('drops a progress update older than the one kept', () => {
    expect(isStale(undefined, { updated_at: '2026-10-23T00:00:00Z' })).toBe(false)
    expect(isStale({ updated_at: '2026-10-23T00:00:02Z' }, { updated_at: '2026-10-23T00:00:01Z' })).toBe(true)
    expect(isStale({ updated_at: '2026-10-23T00:00:01Z' }, { updated_at: '2026-10-23T00:00:01Z' })).toBe(false)
  })
})
