import { describe, expect, test } from 'bun:test'
import type { TaskItem, TaskRun, Thread } from '../../../../packages/kybern-client/src/types.ts'
import { attachedForProject, continueMeta, continueThreads, heroType, movePickup, pickupRowsFor, toggleAttached, upNextTasks } from './model.ts'
import { attachedTaskId, clearAttachedTask, toggleAttachedTask } from './store.ts'

const thread = (id: string, over: Partial<Thread> = {}): Thread => ({
  id, project_id: 'p1', title: id, provider: { kind: 'claude-code', instance: 'default' }, permission_mode: 'supervised', status: 'idle',
  cwd: '/', pinned: false, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', last_seq: 0, ...over,
} as Thread)

const task = (id: string, over: Partial<TaskItem> = {}): TaskItem => ({
  id, key: id.toUpperCase(), scope: 'project', project_id: 'p1', title: id, body: '', status: 'todo', priority: 0, rank: 0,
  note_ids: [], runs: [], revision: 1, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', status_changed_at: '2026-10-01T00:00:00Z', ...over,
} as TaskItem)

describe('Continue', () => {
  test('the project’s three latest threads, newest first', () => {
    const list = ['a', 'b', 'c', 'd'].map((id, i) => thread(id, { updated_at: `2026-10-0${i + 1}T00:00:00Z` }))
    expect(continueThreads(list, 'p1').map((th) => th.id)).toEqual(['d', 'c', 'b'])
  })
  test('leaves out other projects, subagents, delegated children, archived and the open thread', () => {
    const list = [
      thread('other', { project_id: 'p2' }),
      thread('sub', { subagent: { provider_task_id: 'x' } as never }),
      thread('child', { parent_thread_id: 'a' }),
      thread('delegated', { delegation: {} as never }),
      thread('archived', { status: 'archived' }),
      thread('open'),
      thread('kept'),
    ]
    expect(continueThreads(list, 'p1', 'open').map((th) => th.id)).toEqual(['kept'])
  })
  test('free chat has no pick-up', () => {
    expect(continueThreads([thread('a')], null)).toEqual([])
    expect(upNextTasks([task('a')], null)).toEqual([])
  })
})

describe('Up next', () => {
  const run = (state: TaskRun['state']) => ({ number: 1, state, thread_id: 't' }) as TaskRun
  test('to-do and inbox tasks of the project with no live run', () => {
    const list = [
      task('todo'),
      task('inbox', { status: 'inbox' }),
      task('running', { status: 'running' }),
      task('review', { status: 'needs_review' }),
      task('done', { status: 'done' }),
      task('live', { runs: [run('running')] }),
      task('waiting', { runs: [run('waiting')] }),
      task('finished-run', { runs: [run('finished' as TaskRun['state'])] }),
      task('global', { scope: 'global', project_id: null }),
      task('elsewhere', { project_id: 'p2' }),
    ]
    expect(upNextTasks(list, 'p1', 10).map((t) => t.id).sort()).toEqual(['finished-run', 'inbox', 'todo'])
  })
  test('urgent → high → medium → low → none, then to-do before inbox, then rank, then the latest edit', () => {
    const list = [
      task('none', { priority: 0 }),
      task('low', { priority: 4 }),
      task('urgent', { priority: 1 }),
      task('high-inbox', { priority: 2, status: 'inbox' }),
      task('high-todo-late', { priority: 2, rank: 2 }),
      task('high-todo-old', { priority: 2, rank: 1, updated_at: '2026-09-01T00:00:00Z' }),
      task('high-todo-new', { priority: 2, rank: 1, updated_at: '2026-10-09T00:00:00Z' }),
    ]
    expect(upNextTasks(list, 'p1', 10).map((t) => t.id)).toEqual(['urgent', 'high-todo-new', 'high-todo-old', 'high-todo-late', 'high-inbox', 'low', 'none'])
    expect(upNextTasks(list, 'p1')).toHaveLength(3)
  })
})

describe('the project name steps down by length', () => {
  test('34 up to 28 characters, 28 up to 40, then 24', () => {
    expect(heroType('kybern')).toEqual({ size: 34, lineHeight: 44 })
    expect(heroType('x'.repeat(28)).size).toBe(34)
    expect(heroType('x'.repeat(29)).size).toBe(28)
    expect(heroType('x'.repeat(40)).size).toBe(28)
    expect(heroType('anamorphia-gallery-project-client-portal-migration')).toEqual({ size: 24, lineHeight: 31 })
  })
  test('counts characters, not UTF-16 units', () => {
    expect(heroType('📁'.repeat(28)).size).toBe(34)
  })
})

describe('the attached task', () => {
  test('click attaches, the same click detaches, another replaces', () => {
    expect(toggleAttached(null, 'a')).toBe('a')
    expect(toggleAttached('a', 'a')).toBeNull()
    expect(toggleAttached('a', 'b')).toBe('b')
  })
  test('one task per pane', () => {
    toggleAttachedTask('pane-1', 'a')
    toggleAttachedTask('pane-1', 'b')
    toggleAttachedTask('pane-2', 'c')
    expect(attachedTaskId('pane-1')).toBe('b')
    expect(attachedTaskId('pane-2')).toBe('c')
    toggleAttachedTask('pane-1', 'b')
    expect(attachedTaskId('pane-1')).toBeNull()
    clearAttachedTask('pane-2')
    expect(attachedTaskId('pane-2')).toBeNull()
  })
  test('a task from another project is dropped when the project changes', () => {
    expect(attachedForProject(task('a'), 'p1')?.id).toBe('a')
    expect(attachedForProject(task('a'), 'p2')).toBeNull()
    expect(attachedForProject(task('a'), null)).toBeNull()
  })
})

describe('rows that fit', () => {
  test('floor((space − 24) / 32) rows, at most 3, where space runs from the card + 32 to the pane − 24', () => {
    expect(pickupRowsFor(800, 400)).toBe(3)
    // 600 − 432 − 24 = 144 → floor(120 / 32) = 3; 560 → 104 → 2; 500 → 44 → 0
    expect(pickupRowsFor(600, 400)).toBe(3)
    expect(pickupRowsFor(560, 400)).toBe(2)
    expect(pickupRowsFor(500, 400)).toBe(0)
  })
})

describe('Continue meta', () => {
  const now = Date.parse('2026-10-23T15:00:00')
  const at = (iso: string) => thread('a', { updated_at: new Date(iso).toISOString() })
  test('live state first', () => {
    expect(continueMeta(thread('a', { status: 'running' }), now).text).toBe('Working')
    expect(continueMeta(thread('a', { status: 'awaiting-approval' }), now).text).toBe('Waiting for you')
  })
  test('then how long ago', () => {
    expect(continueMeta(at('2026-10-23T14:59:40'), now).text).toBe('Now')
    expect(continueMeta(at('2026-10-23T14:48:00'), now).text).toBe('12m')
    expect(continueMeta(at('2026-10-23T13:00:00'), now).text).toBe('2h')
    expect(continueMeta(at('2026-10-22T20:00:00'), now).text).toBe('Yesterday')
    expect(continueMeta(at('2026-10-19T12:00:00'), now, 'en-US').text).toBe('Mon')
    expect(continueMeta(at('2026-10-03T12:00:00'), now, 'en-US').text).toBe('Oct 3')
  })
})

describe('keyboard in the pick-up', () => {
  test('↑ ↓ within a group; ↑ from the first row leaves', () => {
    expect(movePickup({ group: 0, row: 1 }, 'up', [3, 3])).toEqual({ group: 0, row: 0 })
    expect(movePickup({ group: 0, row: 0 }, 'up', [3, 3])).toBeNull()
    expect(movePickup({ group: 0, row: 2 }, 'down', [3, 3])).toEqual({ group: 0, row: 2 })
  })
  test('← → keep the row index, clamped to the other group', () => {
    expect(movePickup({ group: 0, row: 2 }, 'right', [3, 1])).toEqual({ group: 1, row: 0 })
    expect(movePickup({ group: 1, row: 0 }, 'left', [3, 1])).toEqual({ group: 0, row: 0 })
    expect(movePickup({ group: 0, row: 1 }, 'right', [3, 0])).toEqual({ group: 0, row: 1 })
  })
})
