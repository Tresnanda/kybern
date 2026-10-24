import { expect, test } from 'bun:test'
import type { ProjectMember } from '../../../../packages/kybern-client/src/types.ts'
import { branchOf, choiceFor, groupCreateParams, includedMembers, toggleMember } from './tray.ts'

const member = (path: string, status: ProjectMember['status'] = 'ok'): ProjectMember => ({ path, name: path, status })
const project = { members: [member('api'), member('web'), member('infra'), member('docs', 'missing')] }

test('a fresh choice includes every member on disk', () => {
  const choice = choiceFor(null, 'p1')
  expect(includedMembers(project, choice, true).map((m) => m.path)).toEqual(['api', 'web', 'infra'])
  expect(choiceFor({ projectId: 'p2', members: ['api'], baseBranches: {} }, 'p1').members).toBeNull()
})

test('unticking keeps project order, never drops the last one, and all ticked is null', () => {
  let choice = choiceFor(null, 'p1')
  choice = toggleMember(project, choice, 'web')
  expect(choice.members).toEqual(['api', 'infra'])
  choice = toggleMember(project, choice, 'infra')
  choice = toggleMember(project, choice, 'api')
  expect(choice.members).toEqual(['api'])
  choice = toggleMember(project, choice, 'web')
  choice = toggleMember(project, choice, 'infra')
  expect(choice.members).toBeNull()
})

test('create params name members only for a partial worktree chat', () => {
  const choice = { projectId: 'p1', members: ['api', 'web'], baseBranches: { web: 'feat/login', infra: 'main' } }
  expect(groupCreateParams(project, choice, true)).toEqual({ members: ['api', 'web'], base_branches: { web: 'feat/login' } })
  expect(groupCreateParams(project, choice, false)).toEqual({ base_branches: { web: 'feat/login', infra: 'main' } })
  expect(groupCreateParams(project, choiceFor(null, 'p1'), true)).toEqual({})
})

test('a picked branch wins over the checkout', () => {
  const status = [{ path: 'api', name: 'api', status: 'ok' as const, branch: 'main', dirty_files: 0 }]
  expect(branchOf({ projectId: 'p', members: null, baseBranches: {} }, 'api', status)).toBe('main')
  expect(branchOf({ projectId: 'p', members: null, baseBranches: { api: 'dev' } }, 'api', status)).toBe('dev')
  expect(branchOf({ projectId: 'p', members: null, baseBranches: {} }, 'web', status)).toBeNull()
})
