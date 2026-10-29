import { expect, test } from 'bun:test'
import type { MachineCard } from '../../../../packages/kybern-client/src/types.ts'
import type { MachineRow } from '../machines/index.ts'
import { buildCards, isBehind, osName, outboxRows, updateResultRows, updateSummary } from './machinesModel.ts'

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

test('OS names', () => {
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
  expect([mac!.os, mac!.osLabel, mac!.version]).toEqual(['macos', 'macOS', '0.19.0'])
  expect(mac!.canPause).toBe(false)
  expect(mac!.behind).toBe(false)
  expect(vps!.status).toBe('Relaying via This Mac')
  expect([vps!.os, vps!.tsName, vps!.version]).toEqual(['linux', 'vps.tail.ts.net', '0.18.0'])
  expect(vps!.harnesses).toEqual([{ kind: 'claude-code', label: 'Claude', signedOut: true }])
  expect(vps!.behind).toBe(true)
  expect(sat!.status).toBe('Offline · last seen 3h ago')
  expect(sat!.specs).toEqual({ cpu: 'Ryzen', cores: '12 cores', memory: null, gpus: [] })
  expect(sat!.canPause).toBe(true)
})

test('a saved machine that is not in the network cannot be paused or renamed', () => {
  const [card] = buildCards({ rows: [row({ machineId: 'old', name: 'Old box', member: false })], members: [], infos: {} })
  expect([card!.canPause, card!.canRename, card!.member]).toEqual([false, false, false])
})

test('a card names the machine without .local and lists only installed harnesses', () => {
  const [card] = buildCards({
    rows: [row({ machineId: 'mac', name: 'Treshnandas-Macbook.local', isLocal: true })],
    members: [member({ machine_id: 'mac', name: 'Treshnandas-Macbook.local', os: 'macos' })],
    infos: { mac: { cpu: { model: 'Apple M1', logical_cores: 8 }, gpu: ['Apple M1'], mem: { total_bytes: 16 * 2 ** 30 }, harnesses: [{ kind: 'claude-code', available: true, signed_in: true, version: '2.1.312 (Claude Code)' }, { kind: 'codex', available: false }] } },
  })
  expect(card!.name).toBe('Treshnandas-Macbook')
  expect(card!.specs).toEqual({ cpu: 'Apple M1', cores: '8 cores', memory: '16 GB', gpus: [] })
  expect(card!.harnesses).toEqual([{ kind: 'claude-code', label: 'Claude 2.1.312', signedOut: false }])
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
  expect(outboxRows([item({ id: '7', kind: 'move' })], names)[0]).toMatchObject({ title: 'Move of a thread', detail: 'Waiting for satyamas' })
})
