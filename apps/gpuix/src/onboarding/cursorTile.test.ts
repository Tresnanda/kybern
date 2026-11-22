// While the daemon moves an earlier Cursor SDK to this release's, the tile says Cursor is installing, not missing.
import { expect, test } from 'bun:test'
import type { CursorSetupStatus, ProviderStatus } from '../../../../packages/kybern-client/src/types.ts'

const { agentFor } = await import('./agentsStore.ts')
const provider = (over: Partial<ProviderStatus> = {}): ProviderStatus => ({ kind: 'cursor', display_name: 'Cursor', available: false, supported_permission_modes: [], supports_fork: false, supports_model_switch: false, instances: [], unavailable_reason: 'Updating Cursor’s SDK from 1.2.0 to 1.4.2. Cursor will be ready in a minute.', ...over })
const sdk = (over: Partial<CursorSetupStatus> = {}): CursorSetupStatus => ({ sdk_version: '1.4.2', installed: false, previous_version: '1.2.0', account: 'unknown', installing: false, signing_in: false, ...over })

test('an automatic SDK update reads as installing, and a failed one as an update to run', () => {
  expect(agentFor('cursor', [provider()], [], sdk({ installing: true }), true)).toMatchObject({ state: 'installing', reason: expect.stringContaining('Updating') })
  expect(agentFor('cursor', [provider()], [], sdk({ error: 'npm ERR!', problem: 'Install Node.js' }), true).state).toBe('update')
  expect(agentFor('cursor', [provider()], [], sdk(), true).state).toBe('missing')
})
