import { expect, test } from 'bun:test'
import type { NetworkStatus } from '../../../../packages/kybern-client/src/types.ts'
import { brokerBlocker } from '../../../../packages/kybern-client/src/loginBroker.ts'
import type { MachineRow } from '../machines/index.ts'
import { loginBrokerCandidates } from './loginBrokerCandidates.ts'

const saved = [{ machineId: 'mac', name: 'Mac', member: false, offline: false }, { machineId: 'old', name: 'Saved SSH', member: false, offline: false }] as MachineRow[]
const status = { enabled: true, broker: null, members: [
  { machine_id: 'mac', name: 'Mac', status: 'online', features: ['login.broker.v1'] },
  { machine_id: 'satya', name: 'SatyaMas', status: 'online', features: ['login.broker.v1'] },
  { machine_id: 'vps', name: 'VPS', status: 'offline', features: ['login.broker.v1'] },
  { machine_id: 'paused', name: 'Paused', status: 'paused', features: ['login.broker.v1'] },
  { machine_id: 'older', name: 'Older', status: 'online', features: ['network.v1'] },
] } as unknown as NetworkStatus

test('broker offers authoritative members while every saved record is false, without selecting a broker', () => {
  const candidates = loginBrokerCandidates(saved, status)
  expect(candidates.map((c) => c.machineId)).toEqual(['mac', 'satya', 'vps', 'paused', 'older'])
  expect(candidates.slice(0, 2).map(brokerBlocker)).toEqual([null, null])
  expect(candidates.slice(2).every((c) => brokerBlocker(c) !== null)).toBe(true)
  expect(status.broker).toBeNull()
  expect(saved.every((m) => !m.member)).toBe(true)
})

test('broker honors disabled and removed networks and never promotes unrelated saved profiles', () => {
  expect(loginBrokerCandidates(saved, null)).toEqual([])
  expect(loginBrokerCandidates(saved, { ...status, enabled: false })).toEqual([])
  expect(loginBrokerCandidates(saved, { ...status, removed: true })).toEqual([])
  expect(loginBrokerCandidates(saved, { ...status, members: [] })).toEqual([])
})

test('a member reachable through a relay can be chosen as the broker', () => {
  const relayed = { ...status, members: [{ ...status.members[1]!, status: 'relaying' as const }] }
  const candidates = loginBrokerCandidates(saved, relayed)
  expect(candidates).toHaveLength(1)
  expect(candidates[0]!.online).toBe(true)
  expect(brokerBlocker(candidates[0]!)).toBeNull()
})
