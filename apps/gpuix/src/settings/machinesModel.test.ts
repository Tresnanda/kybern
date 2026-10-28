import { expect, test } from 'bun:test'
import type { MachineCard } from '../../../../packages/kybern-client/src/types.ts'
import type { MachineRow } from '../machines/index.ts'
import { buildCards, hardwareText, harnessText, isBehind, osName, outboxRows, updateResultRows, updateSummary } from './machinesModel.ts'

const row = (over: Partial<MachineRow> & { machineId: string; name: string }): MachineRow => ({ status: 'online', offline: false, isLocal: false, glyph: { letter: over.name[0]!, hue: 10 }, showGlyph: true, member: true, paused: false, ...over })
const member = (over: Partial<MachineCard> & { machine_id: string; name: string }): MachineCard => ({ os: 'linux', status: 'online', ...over })

test('versions compare by number, never by text', () => {
  expect(isBehind('0.18.2', '0.19.0')).toBe(true)
  expect(isBehind('0.9.0', '0.19.0')).toBe(true)
  expect(isBehind('0.19.0', '0.19.0')).toBe(false)
  expect(isBehind('0.20.0', '0.19.0')).toBe(false)
  expect(isBehind('0.19.0-rc1', '0.19.0')).toBe(false)
  expect(isBehind(undefined, '0.19.0')).toBe(false)
  expect(isBehind('dev', '0.19.0')).toBe(false)
})

test('harnesses say whether they are usable on that machine', () => {
  expect(harnessText({ kind: 'claude-code', available: true, signed_in: true })).toBe('Claude Code signed in')
  expect(harnessText({ kind: 'codex', available: true, signed_in: false })).toBe('Codex not signed in')
  expect(harnessText({ kind: 'cursor', available: false })).toBe('Cursor not installed')
  expect(harnessText({ kind: 'opencode', available: true })).toBe('OpenCode')
})

test('hardware: CPU, GPU and memory, whatever the machine reports', () => {
  expect(hardwareText({ cpu: { model: 'Apple M2', logical_cores: 8 }, gpu: ['Apple M2'], mem: { total_bytes: 16 * 2 ** 30 } })).toBe('Apple M2 · 8 cores · Apple M2 · 16 GB')
  expect(hardwareText({ cpu: { model: 'Ryzen 7', logical_cores: 16 }, gpu: ['RTX 3060', 'AMD Radeon'] })).toBe('Ryzen 7 · 16 cores · RTX 3060, AMD Radeon')
  expect(hardwareText({})).toBeNull()
  expect(hardwareText(false)).toBeNull()
  expect(osName('macos')).toBe('macOS')
  expect(osName('freebsd')).toBe('freebsd')
})

test('a card: status, facts, harnesses, relay name, and whether it is behind', () => {
  const cards = buildCards({
    rows: [row({ machineId: 'mac', name: 'This Mac', isLocal: true, version: '0.19.0' }), row({ machineId: 'vps', name: 'VPS', status: 'relaying', version: '0.18.0' }), row({ machineId: 'sat', name: 'satyamas', status: 'offline', offline: true, lastSeenAt: 0 })],
    members: [member({ machine_id: 'mac', name: 'Mac', os: 'macos' }), member({ machine_id: 'vps', name: 'VPS', ts_name: 'vps.tail.ts.net', relay_via: 'mac', harnesses: [{ kind: 'claude-code', available: true, signed_in: false }] }), member({ machine_id: 'sat', name: 'satyamas', os: 'windows' })],
    infos: { sat: { cpu: { model: 'Ryzen', logical_cores: 12 } } },
    latest: '0.19.0',
    now: 3 * 3600_000,
  })
  const [mac, vps, sat] = cards
  expect(mac!.facts).toEqual(['macOS', 'Version 0.19.0'])
  expect(mac!.canPause).toBe(false)
  expect(mac!.behind).toBe(false)
  expect(vps!.status).toBe('Relaying via This Mac')
  expect(vps!.facts).toEqual(['Linux', 'vps.tail.ts.net', 'Version 0.18.0'])
  expect(vps!.harnesses).toEqual(['Claude Code not signed in'])
  expect(vps!.behind).toBe(true)
  expect(sat!.status).toBe('Offline · last seen 3h ago')
  expect(sat!.hardware).toBe('Ryzen · 12 cores')
  expect(sat!.canPause).toBe(true)
})

test('a saved machine that is not in the network cannot be paused or renamed', () => {
  const [card] = buildCards({ rows: [row({ machineId: 'old', name: 'Old box', member: false })], members: [], infos: {} })
  expect([card!.canPause, card!.canRename, card!.member]).toEqual([false, false, false])
})

test('harness versions show beside the name', () => {
  expect(harnessText({ kind: 'claude-code', available: true, signed_in: true, version: '2.1.4' })).toBe('Claude Code 2.1.4 signed in')
  expect(harnessText({ kind: 'codex', available: true, signed_in: false, version: '0.60.0' })).toBe('Codex 0.60.0 not signed in')
  expect(harnessText({ kind: 'cursor', available: false, version: '1.0' })).toBe('Cursor not installed')
})

test('update results list every machine with its reason', () => {
  const names = new Map([['b', 'satyamas'], ['c', 'vps']])
  const result = { started: ['b'], skipped: [{ machine_id: 'c', reason: 'Offline' }, { machine_id: 'x', reason: 'Already up to date' }] }
  expect(updateResultRows(result, names)).toEqual([
    { machineId: 'b', name: 'satyamas', started: true, text: 'Update started' },
    { machineId: 'c', name: 'vps', started: false, text: 'Offline' },
    { machineId: 'x', name: 'A machine', started: false, text: 'Already up to date' },
  ])
  expect(updateSummary(result)).toBe('Started 1 update, 2 skipped.')
  expect(updateSummary({ started: [], skipped: [{ machine_id: 'c', reason: 'Offline' }] })).toBe('Nothing was updated.')
  expect(updateSummary({ started: [], skipped: [] })).toBe('No other machines to update.')
})

test('the outbox lists only work that has not arrived, with the actions that make sense', () => {
  const names = new Map([['b', 'satyamas']])
  const item = (over: Record<string, unknown>) => ({ id: 'i', operation_id: 'o', target: 'b', kind: 'thread_send', payload: {}, state: 'queued', attempts: 0, created_at: '', expires_at: '', updated_at: '', ...over }) as never
  const rows = outboxRows([item({ id: '1' }), item({ id: '2', state: 'delivered' }), item({ id: '3', state: 'failed', kind: 'fork', last_error: 'No matching project', attempts: 2 }), item({ id: '4', state: 'expired', kind: 'settings_patch' }), item({ id: '5', state: 'sending' }), item({ id: '6', state: 'cancelled' })], names)
  expect(rows.map((row) => row.id)).toEqual(['1', '3', '4', '5'])
  expect(rows[0]).toEqual({ id: '1', title: 'Message', detail: 'Waiting for satyamas', canRetry: false, canCancel: true })
  expect(rows[1]).toEqual({ id: '3', title: 'Fork of a thread', detail: 'Did not reach satyamas: No matching project', canRetry: true, canCancel: true })
  expect(rows[2]!.detail).toBe('Not delivered to satyamas in time')
  expect(rows[3]).toMatchObject({ detail: 'Sending to satyamas', canCancel: false })
})
