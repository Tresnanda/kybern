// The rail card's harness rows: one per harness, gone while automatic updates are on, and dismissed until a newer version.
import { describe, expect, test } from 'bun:test'
import type { HarnessUpdate, ProviderKind } from '../../../../packages/kybern-client/src/types.ts'
import { dismiss, justUpdated, railName, runAllSummary, shortVersion, updatedText, updateRows } from './model.ts'

const record = (kind: ProviderKind, patch: Partial<HarnessUpdate> = {}): HarnessUpdate =>
  ({ kind, status: 'current', message: '', version: '1.0.0', checked_at: null, ...patch })
const newer = (kind: ProviderKind, latest: string, patch: Partial<HarnessUpdate> = {}) => record(kind, { update_available: true, latest_version: latest, ...patch })

describe('update rows', () => {
  test('a row names the harness, and says the version to a screen reader', () => {
    const rows = updateRows([newer('claude-code', '2.1.330'), record('codex')], {}, false)
    expect(rows).toEqual([{ kind: 'claude-code', name: 'Claude Code', text: 'Claude Code 2.1.330 is out', busy: false, failed: false }])
  })

  test('each harness with an update has its own row, in order', () => {
    const rows = updateRows([newer('claude-code', '2.1.330'), newer('codex', '0.170.0'), newer('grok-build', '0.2.0')], {}, false)
    expect(rows.map((row) => row.name)).toEqual(['Claude Code', 'Codex', 'Grok Build'])
  })

  test('nothing while automatic updates are on, nothing without a newer version', () => {
    expect(updateRows([newer('claude-code', '2.1.330')], {}, true)).toEqual([])
    expect(updateRows([record('claude-code'), record('codex', { latest_version: '1.0.0' })], {}, false)).toEqual([])
    expect(updateRows([], {}, false)).toEqual([])
  })

  test('a harness waiting or updating keeps its row, busy, until the new version is in', () => {
    const rows = updateRows([newer('claude-code', '2.1.330', { status: 'waiting' }), newer('codex', '0.170.0', { status: 'updating' }), newer('grok-build', '0.2.0')], {}, false)
    expect(rows.map((row) => row.busy)).toEqual([true, true, false])
    // Updated: no newer version is left, so the row goes.
    expect(updateRows([record('claude-code', { status: 'updated', latest_version: '2.1.330', update_available: false })], {}, false)).toEqual([])
  })

  test('a failed attempt keeps its row, marked, for a retry', () => {
    expect(updateRows([newer('codex', '0.170.0', { status: 'failed' })], {}, false)[0]).toMatchObject({ kind: 'codex', failed: true, busy: false })
  })

  test('dismissing hides a harness until its version changes', () => {
    const records = [newer('claude-code', '2.1.330'), newer('codex', '0.170.0')]
    const one = dismiss(records, {}, 'codex')
    expect(one).toEqual({ codex: '0.170.0' })
    expect(updateRows(records, one, false).map((row) => row.kind)).toEqual(['claude-code'])
    const dismissed = dismiss(records, one, 'claude-code')
    expect(dismissed).toEqual({ 'claude-code': '2.1.330', codex: '0.170.0' })
    expect(updateRows(records, dismissed, false)).toEqual([])
    // Claude Code ships again: only it comes back.
    const later = [newer('claude-code', '2.1.331'), newer('codex', '0.170.0')]
    expect(updateRows(later, dismissed, false).map((row) => row.text)).toEqual(['Claude Code 2.1.331 is out'])
    // Dismissing everything keeps what was already dismissed.
    expect(dismiss(later, dismissed)).toEqual({ 'claude-code': '2.1.331', codex: '0.170.0' })
  })
})

describe('the rail update button', () => {
  test('appears for harness updates alone, named for both kinds', () => {
    const rows = updateRows([newer('claude-code', '2.1.330')], {}, false)
    expect(railName(null, rows)).toBe('Updates available')
    expect(railName('v0.26.0', rows)).toBe('Updates available')
  })
  test('a Kybern update alone is named the same; with nothing to show it is hidden', () => {
    expect(railName('v0.26.0', [])).toBe('Updates available')
    expect(railName(null, [])).toBeNull()
    // Automatic updates and dismissed rows leave nothing.
    expect(railName(null, updateRows([newer('codex', '0.170.0')], {}, true))).toBeNull()
    expect(railName(null, updateRows([newer('codex', '0.170.0')], { codex: '0.170.0' }, false))).toBeNull()
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
