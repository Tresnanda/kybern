import { expect, mock, test } from 'bun:test'

// "Steer now" on a queued follow-up: it leaves the queue before it is sent, so the turn's end cannot deliver it a second time.
const calls: string[] = []
let gone = false
const client = {
  endpoint: { url: 'ws://127.0.0.1:1/ws', token: 'test' },
  call: (method: string) => {
    calls.push(method)
    if (method === 'queue.remove' && gone) return Promise.reject(new Error('no such queued message'))
    if (method === 'queue.list') return Promise.resolve({ messages: [] })
    return Promise.resolve({})
  },
}
const real = await import('../state.ts')
mock.module('../state.ts', () => ({ ...real, getClient: () => client }))
const { steerQueued } = await import('./store.ts')
const item = (id: string) => ({ id, thread_id: 'thread-s', message: { parts: [{ type: 'text' as const, text: 'also check the tests' }] } })
const tick = () => new Promise(resolve => setTimeout(resolve, 10))

test('a steered follow-up leaves the queue before it is sent', async () => {
  await steerQueued('thread-s' as never, item('q1') as never)
  await tick()
  const send = calls.findIndex(c => c === 'threads.steer' || c === 'threads.send')
  expect(calls.indexOf('queue.remove')).toBeGreaterThanOrEqual(0)
  expect(send).toBeGreaterThan(calls.indexOf('queue.remove'))
})

test('a follow-up the queue no longer has (the turn already sent it) is not sent again', async () => {
  calls.length = 0
  gone = true
  await expect(steerQueued('thread-s' as never, item('q2') as never)).rejects.toThrow()
  await tick()
  expect(calls).toEqual(['queue.remove'])
})
