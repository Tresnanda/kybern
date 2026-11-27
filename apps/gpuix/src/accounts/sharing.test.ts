// Choosing who lends one agent's sign-ins: the daemon reads a cleared agent as "follow the network-wide lender", so
// "each machine signs in" for one agent pins the others before it clears that default.
import { describe, expect, test } from 'bun:test'
import type { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { setSharing } from './adapter.ts'

function fake(status: object) {
  const calls: unknown[] = []
  const client = { call: async (method: string, params: unknown) => { if (method === 'login.broker.status') return status; calls.push(params); return {} } } as unknown as KybernClient
  return { client, calls }
}

describe('sharing one agent', () => {
  test('from a machine is one call for that agent', async () => {
    const { client, calls } = fake({})
    await setSharing(client, 'kdi', undefined, 'codex')
    expect(calls).toEqual([{ machine_id: 'kdi', sign_out_old: false, provider: 'codex' }])
  })
  test('each machine signs in, while another machine lends every agent: the others stay where they were', async () => {
    const { client, calls } = fake({ broker: { machine_id: 'fedora' }, lenders_by_kind: { 'claude-code': { machine_id: 'fedora' }, codex: { machine_id: 'fedora' }, omp: { machine_id: 'kdi' } } })
    await setSharing(client, null, undefined, 'codex')
    expect(calls).toEqual([
      { machine_id: 'fedora', sign_out_old: false, provider: 'claude-code' },
      { machine_id: 'kdi', sign_out_old: false, provider: 'omp' },
      { machine_id: null, sign_out_old: false },
      { machine_id: null, sign_out_old: false, provider: 'codex' },
    ])
  })
  test('each machine signs in with no network-wide lender clears only that agent', async () => {
    const { client, calls } = fake({ lenders_by_kind: { codex: { machine_id: 'kdi' } } })
    await setSharing(client, null, undefined, 'codex')
    expect(calls).toEqual([{ machine_id: null, sign_out_old: false, provider: 'codex' }])
  })
})
