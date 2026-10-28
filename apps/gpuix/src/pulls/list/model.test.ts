import { describe, expect, test } from 'bun:test'
import type { Project, PullRequest } from '../../../../../packages/kybern-client/src/types.ts'
import { ALL_PROJECTS, chooseRepo, groupRows, inScope, pickProject, readRepoMemory, rememberRepos, REPO_MEMORY_LIMIT, repoHue, scopeTargets, toggleRepo, validRepos, type Row } from './model.ts'

const now = '2026-10-28T10:00:00Z'
const member = (path: string, status: 'ok' | 'missing' = 'ok') => ({ path, name: path, status })
const group = { id: 'g', name: 'BeMe', path: '/g', is_git: false, brief_in_all_threads: false, kind: 'group', members: [member('core'), member('tele'), member('landing'), member('gone', 'missing')], created_at: now, updated_at: now } as unknown as Project
const single = { id: 's', name: 'Kybern', path: '/s', is_git: true, brief_in_all_threads: false, created_at: now, updated_at: now } as unknown as Project
const folder = { ...single, id: 'f', is_git: false } as Project
const pr = (over: Partial<PullRequest>): PullRequest => ({ number: 1, title: 't', url: '', state: 'OPEN', head: 'a', base: 'main', is_draft: false, author: 'x', updated_at: now, ...over })
const rows = (project: Project, ...prs: Partial<PullRequest>[]): Row[] => prs.map(p => ({ project, pr: pr(p) }))

describe('groupRows', () => {
  test('orders open pull requests by readiness and drops empty groups', () => {
    const all = rows(single,
      { number: 1, is_draft: true },
      { number: 2, review_decision: 'APPROVED', merge_state_status: 'CLEAN' },
      { number: 3, review_decision: 'REVIEW_REQUIRED', merge_state_status: 'BLOCKED' },
      { number: 4, mergeable: 'CONFLICTING' },
      { number: 5, checks_summary: { total: 4, passed: 1, failed: 2, pending: 1, skipped: 0 } })
    const groups = groupRows(all)
    expect(groups.map(g => g.label)).toEqual(['Needs attention', 'Awaiting review', 'Approved', 'Drafts'])
    expect(groups.map(g => g.rows.map(r => r.pr.number))).toEqual([[4, 5], [3], [2], [1]])
    expect(groupRows(rows(single, { number: 9 })).map(g => g.group)).not.toContain('draft')
  })
  test('keeps the given order inside a group and puts merged and closed last under their own heading', () => {
    const groups = groupRows(rows(single, { number: 1, state: 'MERGED' }, { number: 2, is_draft: true }, { number: 3, is_draft: true }, { number: 4, state: 'CLOSED' }))
    expect(groups.map(g => g.group)).toEqual(['draft', null])
    expect(groups[0]!.rows.map(r => r.pr.number)).toEqual([2, 3])
    expect(groups[1]).toMatchObject({ label: 'Merged and closed' })
    expect(groupRows(rows(single, { number: 7, state: 'MERGED' }))[0]).toMatchObject({ group: null, label: '' })
    expect(groups[1]!.rows.map(r => r.pr.number)).toEqual([1, 4])
  })
  test('an empty list has no groups', () => expect(groupRows([])).toEqual([]))
})

describe('scope', () => {
  test('targets: every project with pull requests, or the one chosen', () => {
    const projects = [group, single, folder]
    expect(scopeTargets(projects, ALL_PROJECTS).map(p => p.id)).toEqual(['g', 's'])
    expect(scopeTargets(projects, { project: 'g', repos: [] }).map(p => p.id)).toEqual(['g'])
  })
  test('inScope filters a group project by its repositories only', () => {
    const [a, b, c] = rows(group, { repo: 'core' }, { repo: 'tele' }, { repo: 'landing' })
    const scope = { project: 'g', repos: ['core', 'landing'] }
    expect([a!, b!, c!].map(r => inScope(r, scope))).toEqual([true, false, true])
    expect(inScope(b!, { project: 'g', repos: [] })).toBe(true)
    expect(inScope(rows(single, {})[0]!, scope)).toBe(false)
    expect(inScope(b!, ALL_PROJECTS)).toBe(true)
  })
  test('picking a group restores its remembered repositories, and ignores ones that are gone', () => {
    expect(pickProject(group, ['tele', 'ghost'])).toEqual({ project: 'g', repos: ['tele'] })
    expect(pickProject(group)).toEqual({ project: 'g', repos: [] })
    expect(pickProject(single, ['tele'])).toEqual({ project: 's', repos: [] })
    expect(pickProject(null)).toEqual(ALL_PROJECTS)
  })
  test('validRepos treats "every listable repository" as the whole group', () => {
    expect(validRepos(group, ['core', 'tele', 'landing'])).toEqual([])
    expect(validRepos(group, ['gone'])).toEqual([])
  })
  test('toggleRepo: ticking from another scope narrows to one repository', () => {
    expect(toggleRepo(ALL_PROJECTS, group, 'tele')).toEqual({ project: 'g', repos: ['tele'] })
    expect(toggleRepo({ project: 's', repos: [] }, group, 'tele')).toEqual({ project: 'g', repos: ['tele'] })
  })
  test('toggleRepo: multi-select in project order; all or none means the whole group', () => {
    let scope = toggleRepo(ALL_PROJECTS, group, 'landing')
    scope = toggleRepo(scope, group, 'core')
    expect(scope).toEqual({ project: 'g', repos: ['core', 'landing'] })
    expect(toggleRepo(scope, group, 'tele')).toEqual({ project: 'g', repos: [] })
    expect(toggleRepo(scope, group, 'core')).toEqual({ project: 'g', repos: ['landing'] })
    expect(toggleRepo({ project: 'g', repos: ['landing'] }, group, 'landing')).toEqual({ project: 'g', repos: [] })
  })
  test('toggleRepo on the whole group narrows to that repository', () => {
    expect(toggleRepo({ project: 'g', repos: [] }, group, 'tele')).toEqual({ project: 'g', repos: ['tele'] })
  })
  test('chips pick one repository or All', () => {
    expect(chooseRepo(group, 'tele')).toEqual({ project: 'g', repos: ['tele'] })
    expect(chooseRepo(group, null)).toEqual({ project: 'g', repos: [] })
  })
})

describe('repository memory', () => {
  test('remembers per group, forgets the choice for All, and stays bounded', () => {
    let memory = rememberRepos({}, 'g', ['core'])
    expect(memory).toEqual({ g: ['core'] })
    expect(rememberRepos(memory, 'g', [])).toEqual({})
    for (let i = 0; i < REPO_MEMORY_LIMIT + 10; i++) memory = rememberRepos(memory, `group-${i}`, ['a'])
    expect(Object.keys(memory)).toHaveLength(REPO_MEMORY_LIMIT)
    expect(memory.g).toBeUndefined()
    expect(memory[`group-${REPO_MEMORY_LIMIT + 9}`]).toEqual(['a'])
  })
  test('reads only well-formed saved values', () => {
    expect(readRepoMemory({ a: ['x'], b: 'x', c: [1], d: null })).toEqual({ a: ['x'] })
    expect(readRepoMemory(null)).toEqual({})
    expect(readRepoMemory([['a']])).toEqual({})
  })
})

test('repoHue is stable and in range', () => {
  expect(repoHue('g/core')).toBe(repoHue('g/core'))
  for (const key of ['', 'a', 'g/tele', 'a-very-long-repository-name']) expect(repoHue(key)).toBeLessThan(360)
})
