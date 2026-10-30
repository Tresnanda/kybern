// How other machines' projects and threads join the local lists.
import { expect, test } from 'bun:test'
import { mergeProjects, mergeThreads } from '../../../../packages/kybern-client/src/machineMerge.ts'
import type { MergedView } from '../../../../packages/kybern-client/src/machines.ts'
import { FREE_CHAT_PROJECT_ID, type Project, type Thread } from '../../../../packages/kybern-client/src/types.ts'
import { ListMerger, byPinnedThenNewest, ownProjectOf } from './merged.ts'

const project = (id: string, name: string, root: string | null, extra: Partial<Project> = {}): Project => ({ id, name, path: `/w/${name}`, is_git: true, brief_in_all_threads: false, repo: root ? { root_commit: root } : null, space_id: 's-mac', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', ...extra }) as Project
const thread = (id: string, project_id: string, updated_at: string, extra: Record<string, unknown> = {}): Thread => ({ id, project_id, title: id, status: 'idle', pinned: false, updated_at, ...extra }) as unknown as Thread

function view(local: { projects: Project[]; threads: Thread[] }, remote: { projects: Project[]; threads: Thread[] }, offline = false): MergedView {
  const projects = new Map([['mac', local.projects], ['vps', remote.projects]])
  const logical = mergeProjects(projects, { localMachineId: 'mac', machineOrder: ['mac', 'vps'], offline: offline ? new Set(['vps']) : new Set() })
  const threads = mergeThreads(new Map([['mac', local.threads], ['vps', remote.threads]]), logical, { offline: offline ? new Set(['vps']) : new Set(), lastSeenAt: new Map(offline ? [['vps', 1000]] : []) })
  return { version: 1, machines: [{ machineId: 'mac', isLocal: true }, { machineId: 'vps', isLocal: false }] as never, projects: logical, threads, showGlyphs: true }
}

const space = () => 's-default'

test('the same repository on two machines is one project row, with the remote threads listed under it', () => {
  const localProjects = [project('p-mac', 'kybern', 'r1')]
  const remoteProjects = [project('p-vps', 'kybern', 'r1', { space_id: 's-vps' })]
  const v = view({ projects: localProjects, threads: [thread('t1', 'p-mac', '2026-10-02T00:00:00Z')] }, { projects: remoteProjects, threads: [thread('t2', 'p-vps', '2026-10-03T00:00:00Z')] })
  const lists = new ListMerger().merge({ view: v, localProjects, spaceOfForeign: space })
  expect(lists.projects).toEqual(localProjects)
  expect(lists.projects[0]).toBe(localProjects[0]!)
  expect(lists.threads).toHaveLength(1)
  const remote = lists.threads[0]!
  expect([remote.id, remote.project_id, remote.machineId, remote.ownProjectId]).toEqual(['t2', 'p-mac', 'vps', 'p-vps'])
  expect(ownProjectOf(remote)).toBe('p-vps')
  expect(lists.machinesOf.get('p-mac')).toEqual(['mac', 'vps'])
})

test('a project only the other machine has is listed after the local ones, in the default space, and keeps its own id', () => {
  const localProjects = [project('p-mac', 'kybern', 'r1')]
  const remoteProjects = [project('p-site', 'site', 'r2', { space_id: 's-vps' })]
  const v = view({ projects: localProjects, threads: [] }, { projects: remoteProjects, threads: [thread('t3', 'p-site', '2026-10-03T00:00:00Z')] })
  const lists = new ListMerger().merge({ view: v, localProjects, spaceOfForeign: space })
  expect(lists.projects.map((p) => [p.id, p.space_id])).toEqual([['p-mac', 's-mac'], ['p-site', 's-default']])
  const remote = lists.threads[0]!
  expect([remote.project_id, remote.ownProjectId]).toEqual(['p-site', undefined])
  expect(lists.machinesOf.get('p-site')).toEqual(['vps'])
})

test('a remote free chat is listed with the local chats', () => {
  const localProjects = [project(FREE_CHAT_PROJECT_ID, 'Chats', null)]
  const remoteProjects = [project(FREE_CHAT_PROJECT_ID, 'Chats', null)]
  const v = view({ projects: localProjects, threads: [] }, { projects: remoteProjects, threads: [thread('c1', FREE_CHAT_PROJECT_ID, '2026-10-03T00:00:00Z')] })
  const lists = new ListMerger().merge({ view: v, localProjects, spaceOfForeign: space })
  expect(lists.projects).toHaveLength(1)
  expect(lists.threads[0]!.project_id).toBe(FREE_CHAT_PROJECT_ID)
})

test('subagent and archived threads of other machines are not listed', () => {
  const localProjects = [project('p-mac', 'kybern', 'r1')]
  const remoteProjects = [project('p-vps', 'kybern', 'r1')]
  const v = view({ projects: localProjects, threads: [] }, { projects: remoteProjects, threads: [
    thread('keep', 'p-vps', '2026-10-03T00:00:00Z'),
    thread('child', 'p-vps', '2026-10-03T00:00:00Z', { subagent: { kind: 'x' } }),
    thread('old', 'p-vps', '2026-10-03T00:00:00Z', { status: 'archived' }),
  ] })
  expect(new ListMerger().merge({ view: v, localProjects, spaceOfForeign: space }).threads.map((t) => t.id)).toEqual(['keep'])
})

test('an offline machine’s threads are marked with when it was last seen', () => {
  const localProjects = [project('p-mac', 'kybern', 'r1')]
  const v = view({ projects: localProjects, threads: [] }, { projects: [project('p-vps', 'kybern', 'r1')], threads: [thread('t2', 'p-vps', '2026-10-03T00:00:00Z')] }, true)
  const remote = new ListMerger().merge({ view: v, localProjects, spaceOfForeign: space }).threads[0]!
  expect([remote.offline, remote.lastSeenAt]).toEqual([true, 1000])
})

test('rows that did not change keep their identity between merges', () => {
  const merger = new ListMerger()
  const localProjects = [project('p-mac', 'kybern', 'r1')]
  const remote = { projects: [project('p-vps', 'kybern', 'r1'), project('p-site', 'site', 'r2')], threads: [thread('t2', 'p-vps', '2026-10-03T00:00:00Z'), thread('t3', 'p-site', '2026-10-04T00:00:00Z')] }
  const v = view({ projects: localProjects, threads: [] }, remote)
  const first = merger.merge({ view: v, localProjects, spaceOfForeign: space })
  const second = merger.merge({ view: view({ projects: localProjects, threads: [] }, remote), localProjects, spaceOfForeign: space })
  expect(second.threads[0]).toBe(first.threads[0]!)
  expect(second.threads[1]).toBe(first.threads[1]!)
  expect(second.projects[1]).toBe(first.projects[1]!)
  // A different default space makes a new object for the project only.
  const moved = merger.merge({ view: v, localProjects, spaceOfForeign: () => 's-other' })
  expect(moved.projects[1]).not.toBe(first.projects[1]!)
  expect(moved.threads[1]).toBe(first.threads[1]!)
})

test('pinned threads sort first, then the newest', () => {
  const rows = [thread('a', 'p', '2026-10-01T00:00:00Z'), thread('b', 'p', '2026-10-03T00:00:00Z'), thread('c', 'p', '2026-10-02T00:00:00Z', { pinned: true })]
  expect([...rows].sort(byPinnedThenNewest).map((t) => t.id)).toEqual(['c', 'b', 'a'])
})

test('a child another machine runs for a local thread is a child of that thread, not a thread of its own', () => {
  const localProjects = [project('p-mac', 'kybern', 'r1')]
  const remoteProjects = [project('p-vps', 'kybern', 'r1')]
  const child = thread('c1', 'p-vps', '2026-10-03T00:00:00Z', { delegation: { status: 'running', started_at: '2026-10-03T00:00:00Z' }, origin: { machine_id: 'mac', thread_id: 'parent-1' } })
  const lists = new ListMerger().merge({ view: view({ projects: localProjects, threads: [thread('parent-1', 'p-mac', '2026-10-02T00:00:00Z')] }, { projects: remoteProjects, threads: [child, thread('t2', 'p-vps', '2026-10-03T00:00:00Z')] }), localProjects, spaceOfForeign: space })
  expect(lists.threads.map((t) => t.id)).toEqual(['t2'])
  expect(lists.children.map((t) => [t.id, t.parent_thread_id, t.project_id, t.machineId])).toEqual([['c1', 'parent-1', 'p-mac', 'vps']])
})
