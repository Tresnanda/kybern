import assert from 'node:assert/strict'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import type { ThreadEvent, ThreadsGetResult } from '../../../../packages/kybern-client/src/types.ts'
const reads: { before?: number; through?: number; resolve: (page: ThreadsGetResult) => void }[] = []
let live!: (event: ThreadEvent) => void
const at = '2026-10-18T00:00:00Z'
const response = (before: number, through: number, id: string, text: string, complete = true) => ({
  thread: { id: 'history', last_seq: through }, next_before_seq: before,
  transcript: [{ role: 'assistant', id, turn_id: 'turn', seq: before, at, origin: { kind: 'root' }, text, thinking: null, complete }],
  pending_approvals: [], notes: { text: '', revision: 0 },
}) as unknown as ThreadsGetResult
KybernClient.prototype.connect = () => {}
KybernClient.prototype.call = ((_method: string, params: { before_seq?: number; through_seq?: number }) => {
  if (params.before_seq === undefined) return Promise.resolve(response(1000, 10000, 'tail', 'start', false))
  return new Promise(resolve => reads.push({ before: params.before_seq, through: params.through_seq, resolve }))
}) as typeof KybernClient.prototype.call
KybernClient.prototype.subscribeEvents = ((_params: unknown, callback: typeof live) => {
  live = callback; return { unsubscribe() {}, lastSeq: 10000 }
}) as typeof KybernClient.prototype.subscribeEvents
const { connect, getState, resetClient, selectThread } = await import('../state.ts')
const { loadEarlier } = await import('../transcript/store.ts')
await connect(); await selectThread('history')
await Bun.sleep(280)
assert.equal(reads.length, 1, 'exactly one page is prepared')
reads[0]!.resolve(response(999, 10000, 'earlier', 'prepared'))
await Bun.sleep(0)
const originalTail = getState().open.blocks.find(block => block.id === 'tail#0')
await loadEarlier()
assert.equal(reads.length, 1, 'demand consumes the prepared RPC instead of duplicating it')
assert.equal(getState().open.blocks.find(block => block.id === 'tail#0'), originalTail)
process.env.KYBERN_HISTORY_PREFETCH = '0'

let expected = 'start', seq = 10000
for (let index = 0; index < 100; index++) {
  const before = getState().open.nextBeforeSeq!, barrier = getState().open.lastSeq
  const pending = loadEarlier(), repeated = loadEarlier()
  assert.equal(pending, repeated, 'panes share one pending page')
  const request = reads.at(-1)!
  assert.equal(request.before, before); assert.equal(request.through, barrier)
  expected += ` ${index}`
  live({ kind: 'assistant_text_delta', thread_id: 'history', turn_id: 'turn', seq: ++seq, at, message_id: 'tail', origin: { kind: 'root' }, delta: ` ${index}` })
  const visibleTail = getState().open.blocks.find(block => block.id === 'tail#0')
  request.resolve(response(before - 1, barrier, `older-${index}`, `older ${index}`))
  await pending
  const open = getState().open
  assert.equal(open.lastSeq, seq)
  assert.equal(open.blocks.find(block => block.kind === 'assistant' && block.messageId === 'tail')?.kind, 'assistant')
  const tail = open.blocks.find(block => block.kind === 'assistant' && block.messageId === 'tail')
  assert.ok(tail?.kind === 'assistant'); assert.equal(tail.text, expected)
  assert.equal(tail, visibleTail, 'settled/live visible row identity survives the prepend')
  assert.equal(new Set(open.blocks.map(block => block.id)).size, open.blocks.length)
}
assert.equal(reads.length, 101)

// A live event arriving while an older snapshot is prepared invalidates it.
process.env.KYBERN_HISTORY_PREFETCH = '1'
await selectThread('history'); await Bun.sleep(280)
const stale = reads.at(-1)!, count = reads.length
live({ kind: 'assistant_text_delta', thread_id: 'history', turn_id: 'turn', seq: 10001, at, message_id: 'tail', origin: { kind: 'root' }, delta: ' live' })
const demand = loadEarlier()
assert.equal(reads.length, count + 1)
const current = reads.at(-1)!
assert.equal(current.through, 10001)
stale.resolve(response(999, 10000, 'old-snapshot', 'must not appear'))
current.resolve(response(999, 10001, 'new-snapshot', 'current'))
await demand
assert.equal(getState().open.blocks.some(block => block.id === 'old-snapshot#0'), false)
assert.equal(getState().open.blocks.some(block => block.id === 'new-snapshot#0'), true)
resetClient()
