import assert from 'node:assert/strict'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import type { ThreadEvent, ThreadsGetResult } from '../../../../packages/kybern-client/src/types.ts'
const pending: ((value: ThreadsGetResult) => void)[] = []
const callbacks: ((event: ThreadEvent) => void)[] = []
let subscribed = 0, unsubscribed = 0
KybernClient.prototype.connect = () => {}
KybernClient.prototype.call = (() => new Promise((resolve) => pending.push(resolve))) as typeof KybernClient.prototype.call
KybernClient.prototype.subscribeEvents = ((_params: unknown, callback: (event: ThreadEvent) => void) => {
  subscribed++; callbacks.push(callback)
  return { unsubscribe: () => { unsubscribed++ } }
}) as typeof KybernClient.prototype.subscribeEvents
const { connect, selectThread, getState, resetClient } = await import('../state.ts')
connect()
const result = (seq: number) => ({ thread: { id: 'same', last_seq: seq }, transcript: [], pending_approvals: [], notes: '' }) as unknown as ThreadsGetResult
const first = selectThread('same'), second = selectThread('same')
pending[1]!(result(20)); await second
pending[0]!(result(10)); await first
assert.equal(getState().open.lastSeq, 20)
assert.equal(subscribed, 1)
const third = selectThread('same')
pending[2]!(result(30)); await third
callbacks[0]!({ kind: 'thread_notes_updated', thread_id: 'same', seq: 31, at: new Date().toISOString(), notes: { text: 'stale', revision: 1 } })
assert.equal(getState().open.lastSeq, 30)
assert.equal(unsubscribed, 1)
const fourth = selectThread('same')
resetClient(); pending[3]!(result(40)); await fourth
assert.equal(subscribed, 2)
console.log('PASS same-thread hydration generation and stale callback isolation')
