// The sidebar pill: one pill whatever the count, gone while automatic updates are on, and dismissed until a newer version.
import { describe, expect, test } from 'bun:test'
import type { HarnessUpdate, ProviderKind } from '../../../../packages/kybern-client/src/types.ts'
import { dismiss, justUpdated, kindsOf, pill, runAllSummary, shortVersion, updatedText } from './model.ts'

const record = (kind: ProviderKind, patch: Partial<HarnessUpdate> = {}): HarnessUpdate =>
  ({ kind, status: 'current', message: '', version: '1.0.0', checked_at: null, ...patch })
const newer = (kind: ProviderKind, latest: string, patch: Partial<HarnessUpdate> = {}) => record(kind, { update_available: true, latest_version: latest, ...patch })

describe('pill', () => {
  test('names the harness and version when one has an update', () => {
    const shown = pill([newer('claude-code', '2.1.330'), record('codex')], {}, false)
    expect(shown?.text).toBe('Claude Code 2.1.330 is out')
    expect(shown?.label).toBe('Claude Code 2.1.330')
    expect(kindsOf(shown!)).toEqual(['claude-code'])
  })

  test('several updates collapse into one pill', () => {
    const shown = pill([newer('claude-code', '2.1.330'), newer('codex', '0.170.0'), newer('grok-build', '0.2.0')], {}, false)
    expect(shown?.text).toBe('3 harness updates')
    expect(kindsOf(shown!)).toEqual(['claude-code', 'codex', 'grok-build'])
  })

  test('nothing while automatic updates are on, nothing without a newer version', () => {
    expect(pill([newer('claude-code', '2.1.330')], {}, true)).toBeNull()
    expect(pill([record('claude-code'), record('codex', { latest_version: '1.0.0' })], {}, false)).toBeNull()
    expect(pill([], {}, false)).toBeNull()
  })

  test('a harness already waiting or updating leaves the pill', () => {
    expect(pill([newer('claude-code', '2.1.330', { status: 'waiting' })], {}, false)).toBeNull()
    expect(pill([newer('claude-code', '2.1.330', { status: 'updating' }), newer('codex', '0.170.0')], {}, false)?.text).toBe('Codex 0.170.0 is out')
  })

  test('dismissing hides it until the version changes', () => {
    const records = [newer('claude-code', '2.1.330'), newer('codex', '0.170.0')]
    const dismissed = dismiss(records, {})
    expect(dismissed).toEqual({ 'claude-code': '2.1.330', codex: '0.170.0' })
    expect(pill(records, dismissed, false)).toBeNull()
    // Claude Code ships again: only it comes back.
    const later = [newer('claude-code', '2.1.331'), newer('codex', '0.170.0')]
    expect(pill(later, dismissed, false)?.text).toBe('Claude Code 2.1.331 is out')
    // Dismissing again keeps what was already dismissed.
    expect(dismiss(later, dismissed)).toEqual({ 'claude-code': '2.1.331', codex: '0.170.0' })
  })
})

describe('after an automatic update', () => {
  test('a record that moved to updated is named once, with its new version', () => {
    const before = [record('claude-code', { status: 'updating', version: '2.1.327 (Claude Code)' }), record('codex')]
    const after = [record('claude-code', { status: 'updated', version: '2.1.330 (Claude Code)' }), record('codex')]
    expect(updatedText(justUpdated(before, after))).toBe('Updated Claude Code to 2.1.330')
    expect(justUpdated(after, after)).toEqual([])
    const both = [record('claude-code', { status: 'updated', version: 'x' }), record('codex', { status: 'updated', version: 'codex-cli 0.170.0' })]
    expect(updatedText(justUpdated(before, both))).toBe('Updated Claude Code and Codex')
    expect(updatedText([])).toBeNull()
  })
  test('versions read as numbers', () => {
    expect(shortVersion('codex-cli 0.170.0')).toBe('0.170.0')
    expect(shortVersion('rust-v0.170.0')).toBe('0.170.0')
    expect(shortVersion('2026.11.17-f532c45')).toBe('2026.11.17-f532c45')
    expect(shortVersion(null)).toBeNull()
  })
})

describe('update on all machines', () => {
  const names: Record<string, string> = { here: 'Fedora', mac: 'Mac', pc: 'SatyaMas', vps: 'VPS' }
  const nameOf = (id: string) => names[id] ?? id
  test('says how many machines started and names the ones that could not', () => {
    const summary = runAllSummary({
      started: [{ machine_id: 'here', kinds: ['codex'] }, { machine_id: 'mac', kinds: ['claude-code'] }],
      skipped: [
        { machine_id: 'pc', reason: 'Offline' },
        { machine_id: 'vps', reason: 'Running Kybern 0.23.0, which cannot update its harnesses from here. Update Kybern there first' },
        { machine_id: 'other', reason: 'Every harness is up to date' },
      ],
    }, nameOf, 'here')
    expect(summary.started).toBe('Updating harnesses on 2 machines')
    expect(summary.problems.map((p) => p.title)).toEqual(['SatyaMas is offline', 'Couldn’t update harnesses on VPS'])
    expect(summary.problems[1].body.endsWith('.')).toBe(true)
  })
  test('one machine, and nothing to do', () => {
    expect(runAllSummary({ started: [{ machine_id: 'here', kinds: ['codex'] }], skipped: [] }, nameOf, 'here').started).toBe('Updating harnesses on this computer')
    expect(runAllSummary({ started: [{ machine_id: 'mac', kinds: ['codex'] }], skipped: [] }, nameOf, 'here').started).toBe('Updating harnesses on Mac')
    const none = runAllSummary({ started: [], skipped: [{ machine_id: 'here', reason: 'Every harness is up to date' }] }, nameOf, 'here')
    expect(none).toEqual({ started: null, problems: [] })
  })
})
