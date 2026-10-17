import type { Thread, RuntimeTask } from '../../../../packages/kybern-client/src/types.ts'
import { getClient } from '../state.ts'
import '../main.tsx'
if (!process.env.KYBERN_DATA_DIR?.includes('gpuix-scratch')) throw Error('Scratch data required')
const client = getClient()!, call = client.call.bind(client)
client.call = (async (method: string, params: unknown) => {
  if (method === 'threads.diff') return { patch: 'diff --git a/dock-example.ts b/dock-example.ts\n--- a/dock-example.ts\n+++ b/dock-example.ts\n@@ -1 +1,2 @@\n export const example = 1;\n+export const next = 2;', files: [{ path: 'dock-example.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n export const example = 1;\n+export const next = 2;' }] }
  if (method === 'threads.list') {
    const result = await call('threads.list', params as never)
    const parent = result.threads.find(thread => thread.id === process.env.KYBERN_GPUIX_THREAD)
    if (parent) {
      const child: Thread = { ...parent, id: 'dock-fixture-child', title: 'Dock review', parent_thread_id: parent.id, status: 'idle', delegation: {
        task_id: 'dock-fixture-delegation', operation_id: 'dock-fixture-operation', parent_thread_id: parent.id,
        depth: 1, role: 'review', workspace: 'shared', status: 'completed',
        result: 'Verified the dock fixture.', started_at: parent.created_at, completed_at: parent.updated_at,
      } }
      return { ...result, threads: [...result.threads, child] }
    }
    return result
  }
  if (method === 'tasks.list') {
    const now = new Date().toISOString()
    const task: RuntimeTask = {
      id: 'dock-fixture-process', thread_id: process.env.KYBERN_GPUIX_THREAD!, origin_turn_id: 'dock-fixture-turn',
      started_seq: 1, updated_seq: 2, kind: 'process', status: 'completed', title: 'Check dock rendering',
      backgrounded: false, stats: { duration_ms: 1200 }, capabilities: { stop: false, background: false },
      started_at: now, updated_at: now, completed_at: now,
    }
    return { tasks: [task] }
  }
  return call(method as never, params as never)
}) as typeof client.call
