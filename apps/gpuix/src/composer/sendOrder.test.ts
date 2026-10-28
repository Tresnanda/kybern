import { expect, mock, test } from 'bun:test'

// Review 2026-10-21: a second Enter while the first send was still unanswered went to the queue, and `queue.add` on a thread
// that is not running yet starts its turn at once, so on a worktree thread (whose send takes seconds) it overtook the first.
const calls: string[] = []
let answer = () => {}
const client = {
  endpoint: { url: 'ws://127.0.0.1:1/ws', token: 'test' },
  call: (method: string) => {
    calls.push(method)
    if (method === 'threads.send') return new Promise(resolve => { answer = () => { calls.push('threads.send answered'); resolve({}) } })
    if (method === 'queue.list') return Promise.resolve({ messages: [] })
    return Promise.resolve({})
  },
}
const real = await import('../state.ts')
mock.module('../state.ts', () => ({ ...real, getClient: () => client, localClient: () => client, threadClient: () => client, projectClient: () => client }))
const { sendToThread } = await import('./store.ts')
const message = (text: string) => ({ parts: [{ type: 'text' as const, text }] })
const tick = () => new Promise(resolve => setTimeout(resolve, 10))

test('a queued or steered follow-up reaches the daemon only after the send before it is answered', async () => {
  await sendToThread('thread-a' as never, message('first'), 'send')
  const queued = sendToThread('thread-a' as never, message('second'), 'queue')
  void sendToThread('thread-a' as never, message('third'), 'steer')
  await tick()
  expect(calls).toEqual(['threads.send'])
  answer()
  await queued
  await tick()
  expect(calls.slice(0, 2)).toEqual(['threads.send', 'threads.send answered'])
  expect(calls.slice(2).sort()).toEqual(['queue.add', 'queue.list', 'threads.steer'])
  // Another thread is not held up by it.
  calls.length = 0
  await sendToThread('thread-b' as never, message('elsewhere'), 'queue')
  expect(calls[0]).toBe('queue.add')
})
