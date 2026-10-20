import { afterEach, expect, test } from 'bun:test'
import type { Block } from '../../../../packages/kybern-client/src/transcript.ts'
import { addPending, pendingFor, removePending, settledPending, subscribePending, updatePending, withPending, type PendingSend } from './pending.ts'

const message = { parts: [{ type: 'text' as const, text: 'Ship it' }] }
const send = (id: string, delivery: PendingSend['delivery'] = 'send'): PendingSend => ({ id, threadId: 'thread', message, at: '2026-10-21T10:00:00.000Z', delivery, state: 'sending' })
const history: Block[] = [
  { kind: 'user', id: 'm0', turnId: 't0', at: '2026-10-21T09:00:00.000Z', seq: 1, message },
  { kind: 'turn_end', id: 'e0', turnId: 't0', at: '2026-10-21T09:00:01.000Z', seq: 2, stopReason: 'completed', usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }, costUsd: null, durationMs: 1, terminalMessageId: null, error: null },
]
afterEach(() => { for (const p of pendingFor('thread')) removePending('thread', p.id) })

test('a pending send is its own turn after the history, with the same array for the same inputs', () => {
  addPending(send('m1'))
  const pending = pendingFor('thread')
  const merged = withPending(history, pending)
  expect(merged.slice(0, 2)).toEqual(history)
  expect(merged[2]).toMatchObject({ kind: 'user', id: 'm1', turnId: 'pending:m1', message })
  expect(withPending(history, pending)).toBe(merged)
  expect(withPending(history, [])).toBe(history)
})

test('a steer joins the running turn, as its message_steered block will', () => {
  addPending(send('m2', 'steer'))
  const live: Block[] = [...history, { kind: 'user', id: 'm1', turnId: 't1', at: '2026-10-21T10:00:00.000Z', seq: 3, message }]
  expect(withPending(live, pendingFor('thread')).at(-1)).toMatchObject({ id: 'm2', turnId: 't1' })
})

test("the daemon's block with the same id replaces the pending one", () => {
  addPending(send('m1'))
  const real: Block[] = [...history, { kind: 'user', id: 'm1', turnId: 't1', at: '2026-10-21T10:00:00.050Z', seq: 3, message }]
  expect(settledPending(real, pendingFor('thread'))).toEqual(['m1'])
  expect(withPending(real, pendingFor('thread'))).toBe(real)
})

test('state changes notify, and a failed send keeps its error', () => {
  let calls = 0
  const stop = subscribePending(() => calls++)
  addPending(send('m1'))
  updatePending('thread', 'm1', { state: 'failed', error: 'Thread not found.' })
  expect(pendingFor('thread')[0]).toMatchObject({ state: 'failed', error: 'Thread not found.' })
  removePending('thread', 'm1')
  expect(pendingFor('thread')).toEqual([])
  expect(calls).toBe(3)
  stop()
})
