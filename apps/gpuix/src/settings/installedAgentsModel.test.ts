// Installed agents: each line says only what Kybern has read, and the update button appears only where an updater can run.
import { describe, expect, test } from 'bun:test'
import type { CursorSetupStatus, HarnessUpdate, ProviderStatus } from '../../../../packages/kybern-client/src/types.ts'
import { canCheckForUpdates, canUpdateNow, checkedPhrase, cursorSdkLine, failureDetail, updateLine } from './installedAgentsModel.ts'

const now = Date.parse('2026-11-02T12:00:00Z')
const record = (status: HarnessUpdate['status'], message = '', checked_at: string | null = '2026-11-02T09:00:00Z'): HarnessUpdate =>
  ({ kind: 'antigravity', status, message, version: '1.4.12', checked_at })
const provider = (patch: Partial<ProviderStatus> = {}) => ({ kind: 'antigravity', available: true, ...patch }) as ProviderStatus
const sdk = (patch: Partial<CursorSetupStatus> = {}): CursorSetupStatus =>
  ({ sdk_version: '1.2.0', installed: false, account: 'unknown', installing: false, signing_in: false, ...patch })

describe('update line', () => {
  test('up to date says when it was checked', () => {
    expect(updateLine(record('current'), now)).toEqual({ text: 'Up to date · checked 3h ago', tone: 'normal' })
    expect(checkedPhrase('2026-11-02T11:59:50Z', now)).toBe('checked just now')
    expect(checkedPhrase(null, now)).toBe('')
  })
  test('never checked says nothing rather than guessing', () => {
    expect(updateLine(record('not_checked', 'Not checked yet', null), now)).toBeNull()
    expect(updateLine(undefined, now)).toBeNull()
  })
  test('progress and reasons pass through; a failure is a warning', () => {
    expect(updateLine(record('waiting', 'Waiting for active turns and background work to finish'), now)?.text).toBe('Waiting for active turns and background work to finish')
    // The headline says what to do; the updater's own text is behind Show details.
    expect(updateLine(record('failed', 'agy update exited with 1'), now)).toEqual({ text: 'The last update didn’t finish. Try again, or run the updater in your terminal.', tone: 'warning' })
    expect(failureDetail(record('failed', 'agy update exited with 1'))).toBe('agy update exited with 1')
    expect(failureDetail(record('current'))).toBeNull()
    expect(updateLine(record('updated'), now)?.text).toBe('Updated · checked 3h ago. New turns use this version.')
  })
})

describe('a newer version', () => {
  const newer = (patch: Partial<HarnessUpdate> = {}): HarnessUpdate => ({ ...record('current'), update_available: true, latest_version: '1.5.0', ...patch })
  test('says it is out and offers Update now', () => {
    expect(updateLine(newer(), now)).toEqual({ text: '1.5.0 is out', tone: 'normal' })
    expect(canUpdateNow(provider(), newer(), false)).toBe(true)
    expect(canUpdateNow(provider({ kind: 'cursor' }), newer({ kind: 'cursor' }), false), 'the Cursor CLI updates too').toBe(true)
  })
  test('not for a custom binary, a missing agent, or nothing newer', () => {
    expect(canUpdateNow(provider(), newer(), true)).toBe(false)
    expect(canUpdateNow(provider({ available: false }), newer(), false)).toBe(false)
    expect(canUpdateNow(provider(), record('current'), false)).toBe(false)
  })
  test('while it updates, the progress shows instead', () => {
    expect(updateLine(newer({ status: 'updating', message: 'Checking and installing updates…' }), now)?.text).toBe('Checking and installing updates…')
  })
})

describe('check for updates', () => {
  test('only for an installed agent Kybern can update', () => {
    expect(canCheckForUpdates(provider(), record('current'), false)).toBe(true)
    expect(canCheckForUpdates(provider({ available: false }), record('current'), false)).toBe(false)
    expect(canCheckForUpdates(provider(), record('current'), true)).toBe(false)
    expect(canCheckForUpdates(provider(), record('unsupported', 'Managed or pinned installation.'), false)).toBe(false)
    expect(canCheckForUpdates(provider({ kind: 'cursor' }), undefined, false)).toBe(false)
  })
})

describe('Cursor SDK line', () => {
  test('an earlier release’s SDK reads as an update, not a missing install', () => {
    expect(cursorSdkLine({ status: sdk({ previous_version: '1.0.35' }), error: '' })).toBe('SDK 1.0.35 is installed. This version of Kybern needs 1.2.0.')
  })
  test('missing, installing, a machine problem and a failed install each say so', () => {
    expect(cursorSdkLine({ status: sdk(), error: '' })).toBe('Needs Cursor’s SDK, which installs separately from the Cursor app.')
    expect(cursorSdkLine({ status: sdk({ installing: true, previous_version: '1.0.35' }), error: '' })).toBe('Installing SDK 1.2.0…')
    expect(cursorSdkLine({ status: sdk({ problem: 'Install Node.js, then try again.' }), error: '' })).toBe('Install Node.js, then try again.')
    expect(cursorSdkLine({ status: sdk(), error: 'npm ci failed' })).toBe('npm ci failed')
  })
  test('nothing to add once the SDK is installed', () => {
    expect(cursorSdkLine({ status: sdk({ installed: true }), error: '' })).toBeNull()
    expect(cursorSdkLine({ status: null, error: '' })).toBeNull()
  })
})
