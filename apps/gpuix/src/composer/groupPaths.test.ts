import { expect, test } from 'bun:test'
import type { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import type { LogicalProject } from '../../../../packages/kybern-client/src/machineMerge.ts'
import type { Project, ProvisionPlan } from '../../../../packages/kybern-client/src/types.ts'
import { groupCreateParams, mappedGroupChoice } from '../groups/tray.ts'
import { groupPathsFromPlan, readGroupPaths } from './groupPaths.ts'

const source = { id: 'source', kind: 'group', path: '/work/source', members: [{ path: 'web', status: 'ok' }, { path: 'api', status: 'ok' }], repos: [{ root_commit: 'api' }, { root_commit: 'web' }] } as Project
const target = { id: 'target', kind: 'group', path: 'D:\\projects\\renamed', members: [{ path: 'backend', status: 'ok' }, { path: 'frontend', status: 'ok' }], repos: source.repos } as Project
const logical = { key: 'group:api+web', instances: [{ machineId: 'mac', project: source }, { machineId: 'pc', project: target }] } as LogicalProject
const plan = { project_id: 'source', target: { id: 'pc' }, members: [{ path: 'web', target_path: 'frontend', present: true }, { path: 'api', target_path: 'backend', present: true }] } as ProvisionPlan

test('existing complete groups probe the actual folder and preserve exclusions and branches by identity', async () => {
  const calls: unknown[] = []
  const paths = await readGroupPaths(logical, source.id, 'pc', (id) => {
    expect(id).toBe('mac')
    return { call: async (...args: unknown[]) => { calls.push(args); return plan } } as unknown as KybernClient
  })
  expect(calls).toEqual([['projects.provision_plan', { project_id: 'source', machine: 'pc', path: target.path }]])
  expect(paths).toEqual({ web: 'frontend', api: 'backend' })
  const draft = { projectId: source.id, members: ['web'], baseBranches: { web: 'feature', api: 'main' } }
  expect(groupCreateParams(target, mappedGroupChoice(draft, source.id, paths), true)).toEqual({ members: ['frontend'], base_branches: { frontend: 'feature' } })
  expect(mappedGroupChoice(mappedGroupChoice(draft, source.id, paths), source.id, { frontend: 'web', backend: 'api' })).toEqual(draft)
})

test('incomplete or stale probe mappings cannot silently select other repositories', () => {
  expect(() => groupPathsFromPlan(source, target, { ...plan, project_id: 'another-source' })).toThrow('Could not match')
  expect(() => groupPathsFromPlan(source, target, { ...plan, members: plan.members!.slice(0, 1) })).toThrow('Could not match')
  expect(() => groupPathsFromPlan(source, target, { ...plan, members: plan.members!.map((item) => ({ ...item, target_path: 'frontend' })) })).toThrow('Could not match')
})
