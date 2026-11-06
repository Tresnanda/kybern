import { describe, expect, test } from 'bun:test'
import { FREE_CHAT_PROJECT_ID, type Project, type Thread } from '../../../../packages/kybern-client/src/types.ts'
import { DEFAULT_FILTER } from '../nav/store.ts'
import { buildRows, dismissedChildren, type Row } from './model.ts'

const delegated = (id: string, status: 'running' | 'completed'): Thread => ({
  id, title: id, status: status === 'running' ? 'running' : 'idle', parent_thread_id: 'parent',
  delegation: { task_id: id, operation_id: id, parent_thread_id: 'parent', depth: 1, role: 'general', workspace: 'shared', status, started_at: '2026-10-20T00:00:00Z' },
} as unknown as Thread)

test('a child that finished, left and was re-woken by a message is listed again', () => {
  const nav = { dismissed: { a: true, b: true, gone: true } as Record<string, true>, children: { a: delegated('a', 'running'), b: delegated('b', 'completed') } }
  expect([...dismissedChildren(nav)].sort()).toEqual(['b', 'gone'])
})

test('the child being viewed stays listed after it was dismissed here, a remote one too', () => {
  const remote = { ...delegated('r', 'completed'), machineId: 'vps' } as unknown as Thread
  const nav = { dismissed: { r: true } as Record<string, true>, children: { r: remote } }
  expect([...dismissedChildren(nav)]).toEqual(['r'])
  expect([...dismissedChildren(nav, 'r')]).toEqual([])
})

describe('buildRows in a space', () => {
  const project = (id: string, space_id: string | null) => ({ id, name: id, path: `/${id}`, is_git: false, brief_in_all_threads: false, space_id }) as unknown as Project
  const thread = (id: string, project_id: string) => ({ id, title: id, project_id, status: 'idle', updated_at: '2026-10-20T00:00:00Z', last_seq: 1, provider: { kind: 'claude-code', instance: 'default' } }) as unknown as Thread
  const nav = { children: {}, activity: {}, unread: {}, dismissed: {}, filter: DEFAULT_FILTER, attentionFilter: false, projectOrder: [] as string[], composerDrafts: {}, attentionDismissals: {} }
  const projects = [project('a', 's1'), project('b', 's2'), project('c', 's1')]
  const threads = [thread('ta', 'a'), thread('tb', 'b'), thread('chat', FREE_CHAT_PROJECT_ID)]
  const input = (spaceId: string | null, projectOrder: string[] = [], count = 2) => ({
    projects, threads, selectedId: null, draft: null, collapsed: {}, showAll: {}, expanded: {}, nav: { ...nav, projectOrder }, now: 0,
    space: { id: spaceId, name: spaceId && count >= 2 ? `space ${spaceId}` : null, count },
  })
  const kinds = (rows: Row[]) => rows.map((row) => (row.kind === 'project' ? `project:${row.project.id}` : row.kind === 'thread' ? `thread:${row.thread.id}` : row.kind))

  test('holds only its projects and their threads, and keeps Recents', () => {
    const rows = buildRows(input('s1'))
    expect(kinds(rows)).toEqual(['label', 'project:a', 'create-coordinator', 'thread:ta', 'project:c', 'create-coordinator', 'no-threads', 'recents', 'thread:chat'])
  })

  test('the label names the space only with two or more', () => {
    expect(buildRows(input('s1'))[0]).toMatchObject({ kind: 'label', text: 'space s1' })
    expect(buildRows(input('s1', [], 1))[0]).toEqual({ kind: 'label', key: '__projects' })
    expect(buildRows(input(null))[0]).toEqual({ kind: 'label', key: '__projects' })
  })

  test('the reader’s order applies within the space', () => {
    const rows = buildRows(input('s1', ['c', 'b', 'a']))
    expect(kinds(rows).filter((k) => k.startsWith('project:'))).toEqual(['project:c', 'project:a'])
  })

  test('a space without projects shows the empty row; with no spaces it keeps the old message', () => {
    expect(buildRows(input('s3')).map((row) => row.kind)).toEqual(['label', 'empty-space', 'recents', 'thread'])
    expect(buildRows(input('s3'))[1]).toMatchObject({ kind: 'empty-space', onlySpace: false })
    expect(buildRows(input('s3', [], 1))[1]).toMatchObject({ kind: 'empty-space', onlySpace: true })
    expect(buildRows({ ...input(null), projects: [] })[1]).toMatchObject({ kind: 'message' })
  })

  test('without a space every project shows', () => {
    expect(kinds(buildRows(input(null))).filter((k) => k.startsWith('project:'))).toEqual(['project:a', 'project:b', 'project:c'])
  })
})

describe('"Show more" with a bounded list (#248)', () => {
  const project = { id: 'p', name: 'p', path: '/p', is_git: false, brief_in_all_threads: false, space_id: null } as unknown as Project
  const thread = (i: number) => ({ id: `t${i}`, title: `t${i}`, project_id: 'p', status: 'idle', updated_at: `2026-10-${String(28 - i).padStart(2, '0')}T00:00:00Z`, last_seq: 1, provider: { kind: 'claude-code', instance: 'default' } }) as unknown as Thread
  const nav = { children: {}, activity: {}, unread: {}, dismissed: {}, filter: DEFAULT_FILTER, attentionFilter: false, projectOrder: [] as string[], composerDrafts: {}, attentionDismissals: {} }
  const more = (count: number, omitted: Record<string, number>, showAll = false) => {
    const rows = buildRows({ projects: [project], threads: Array.from({ length: count }, (_, i) => thread(i)), selectedId: null, draft: null, collapsed: {}, showAll: { p: showAll }, omitted, expanded: {}, nav, now: 0 })
    return rows.find((row) => row.kind === 'more') as Extract<Row, { kind: 'more' }> | undefined
  }

  test('counts the rows the daemon left out', () => {
    expect(more(12, {})).toMatchObject({ count: 4, showAll: false })
    expect(more(12, { p: 30 })).toMatchObject({ count: 34, showAll: false })
    // Fewer listed rows than the panel shows, but more on the daemon: the row is still offered.
    expect(more(3, { p: 5 })).toMatchObject({ count: 5, showAll: false })
  })

  test('once opened it offers the rows still on the daemon, then "Show less"', () => {
    expect(more(12, { p: 30 }, true)).toMatchObject({ count: 30, showAll: false })
    expect(more(12, {}, true)).toMatchObject({ count: 4, showAll: true })
  })
})
