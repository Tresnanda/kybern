import { expect, test } from 'bun:test'
import type { GitStatus, RepoGitStatus, ThreadMember } from '../../../../packages/kybern-client/src/types.ts'
import { dirtyTotals, prPlan, repoRows } from './git.ts'

const member = (path: string, included = true): ThreadMember => ({ path, name: path, included, source_path: `/w/acme/${path}` })
const git = (repo: string, patch: Partial<RepoGitStatus> = {}): RepoGitStatus =>
  ({ repo, name: repo, included: true, status: 'ok', is_git: true, branch: 'kybern/x', dirty_files: 0, ahead: 0, behind: 0, remote_url: `git@github.com:acme/${repo}.git`, ...patch }) as RepoGitStatus

test('rows follow the included members and count changed files', () => {
  const rows = repoRows([member('api'), member('web'), member('docs', false)], { files: [{ path: 'api/a.rs', repo: 'api', additions: 1, deletions: 0 } as never], repos: [{ repo: 'web', from: 'a', to: 'b', files: 2, additions: 3, deletions: 0 }] }, null)
  expect(rows.map((r) => [r.member.path, r.files])).toEqual([['api', 1], ['web', 2]])
})

test('a pull request per changed repository with a remote; the rest are named', () => {
  const status = { repos: [git('api'), git('web'), git('infra', { remote_url: null })] } as Pick<GitStatus, 'repos'>
  const diff = { files: [], repos: [{ repo: 'api', from: '', to: '', files: 3, additions: 1, deletions: 1 }, { repo: 'web', from: '', to: '', files: 0, additions: 0, deletions: 0 }, { repo: 'infra', from: '', to: '', files: 1, additions: 1, deletions: 0 }] }
  const plan = prPlan(repoRows([member('api'), member('web'), member('infra')], diff, status))
  expect(plan?.repos).toEqual(['api'])
  expect(plan?.label).toBe('Create pull request')
  expect(plan?.caption).toContain('infra has no GitHub remote')
  expect(plan?.caption).toContain('web has no changes')
  expect(prPlan(repoRows([member('web')], { files: [], repos: [] }, status))).toBeNull()
})

test('dirty totals across repositories', () => {
  const rows = repoRows([member('api'), member('web')], null, { repos: [git('api', { dirty_files: 4 }), git('web', { dirty_files: 2 })] })
  expect(dirtyTotals(rows)).toEqual({ files: 6, repos: 2 })
})
