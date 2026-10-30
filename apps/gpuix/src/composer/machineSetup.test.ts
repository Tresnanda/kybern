import { expect, test } from 'bun:test'
import type { LogicalProject } from '../../../../packages/kybern-client/src/machineMerge.ts'
import type { Project, ProvisionPlan } from '../../../../packages/kybern-client/src/types.ts'
import { finishMachineSetup } from './machineSetup.ts'

const group = (id: string, paths: string[]): Project => ({ id, kind: 'group', members: paths.map((path) => ({ path, name: path, status: 'ok' })), repos: paths.map((_, index) => ({ root_commit: String(index) })) }) as Project
const source = group('source', ['web', 'api']), target = group('destination', ['backend', 'frontend'])
const logical = { key: 'group:0+1', instances: [{ machineId: 'mac', project: source }, { machineId: 'pc', project: target }] } as LogicalProject
const input = { projectId: source.id, key: logical.key, targetId: 'pc', paneId: 'original-pane', plan: {} as ProvisionPlan }

test('production picker completion refreshes, maps and loads the destination before selecting in its original pane', async () => {
  const calls: unknown[] = []
  let refreshed = false
  await finishMachineSetup(input, {
    refresh: async (id) => { calls.push(['refresh', id]); refreshed = true },
    projects: () => { expect(refreshed).toBe(true); return [logical] }, localMachineId: 'mac',
    paths: async (...args) => { calls.push(['paths', ...args]) },
    providers: async (...args) => { calls.push(['providers', ...args]) },
    select: (...args) => { calls.push(['select', ...args]) },
  })
  expect(calls).toEqual([
    ['refresh', 'pc'], ['paths', 'source', 'pc', 'original-pane', input.plan],
    ['providers', 'pc', true, 'destination'], ['select', logical.key, 'pc', 'original-pane'],
  ])
})

test('completion refuses stale lists, incomplete groups and mapping errors without selecting', async () => {
  const selected: string[] = []
  const actions = {
    refresh: async () => {}, projects: () => [logical], localMachineId: 'mac',
    paths: async () => {}, providers: async () => {}, select: (key: string) => { selected.push(key) },
  }
  await expect(finishMachineSetup(input, { ...actions, projects: () => [] })).rejects.toThrow('not refreshed')
  const missing = { ...logical, instances: [logical.instances[0]!, { machineId: 'pc', project: { ...target, members: target.members!.map((member) => ({ ...member, status: 'missing' as const })) }, offline: false }] }
  await expect(finishMachineSetup(input, { ...actions, projects: () => [missing] })).rejects.toThrow('not refreshed')
  await expect(finishMachineSetup(input, { ...actions, paths: async () => { throw new Error('mapping unavailable') } })).rejects.toThrow('mapping unavailable')
  expect(selected).toEqual([])
})
