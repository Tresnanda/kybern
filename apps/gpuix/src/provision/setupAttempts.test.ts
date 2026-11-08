import { expect, test } from 'bun:test'
import type { ProvisionPlan, ProvisionStatus } from '../../../../packages/kybern-client/src/types.ts'
import { SetupAttempts, type SetupAttempt } from './setupAttempts.ts'

test('reopened setup retains the exact queued operation, folder, consent and source mapping', () => {
  const attempts = new SetupAttempts()
  const key = attempts.key('mac', 'source', 'pc')
  const request = { project_id: 'source', machine: 'pc', operation_id: 'original-operation', path: 'D:\\work', env_files: ['api/.env'] }
  const attempt: SetupAttempt = { request, plan: { members: [{ path: 'web', target_path: 'frontend' }] } as ProvisionPlan, status: null, error: 'Response lost' }
  attempts.remember(key, attempt)
  expect(attempts.get(key)?.request).toBe(request)
  attempt.status = { operation_id: request.operation_id, phase: 'queued' } as ProvisionStatus
  expect(attempts.get(key)?.status?.phase).toBe('queued')
  expect(attempts.get(key)?.plan.members?.[0]?.target_path).toBe('frontend')
  expect(attempts.get(attempts.key('other-source', 'source', 'pc'))).toBeUndefined()
  expect(attempts.get(attempts.key('mac', 'source', 'other-target'))).toBeUndefined()
  attempts.forget(key)
  expect(attempts.get(key)).toBeUndefined()
})

test('a finished setup is forgotten so a machine whose copy was removed can be set up again; unfinished ones are kept', () => {
  const attempts = new SetupAttempts()
  const attempt = (phase: string): SetupAttempt => ({ request: { project_id: 'p', machine: 'pc', operation_id: phase }, plan: {} as ProvisionPlan, status: { operation_id: phase, phase } as ProvisionStatus, error: '' })
  attempts.remember('done', attempt('done'))
  attempts.remember('queued', attempt('queued'))
  attempts.remember('failed', attempt('failed'))
  for (const key of ['done', 'queued', 'failed', 'unknown']) attempts.forgetFinished(key)
  expect(attempts.get('done')).toBeUndefined()
  expect(attempts.get('queued')?.status?.phase).toBe('queued')
  expect(attempts.get('failed')?.status?.phase).toBe('failed')
})
