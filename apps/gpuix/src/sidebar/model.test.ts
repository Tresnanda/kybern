import { expect, test } from 'bun:test'
import type { Thread } from '../../../../packages/kybern-client/src/types.ts'
import { dismissedChildren } from './model.ts'

const delegated = (id: string, status: 'running' | 'completed'): Thread => ({
  id, title: id, status: status === 'running' ? 'running' : 'idle', parent_thread_id: 'parent',
  delegation: { task_id: id, operation_id: id, parent_thread_id: 'parent', depth: 1, role: 'general', workspace: 'shared', status, started_at: '2026-10-20T00:00:00Z' },
} as unknown as Thread)

test('a child that finished, left and was re-woken by a message is listed again', () => {
  const nav = { dismissed: { a: true, b: true, gone: true } as Record<string, true>, children: { a: delegated('a', 'running'), b: delegated('b', 'completed') } }
  expect([...dismissedChildren(nav)].sort()).toEqual(['b', 'gone'])
})
