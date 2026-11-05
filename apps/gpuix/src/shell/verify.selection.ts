process.env.KYBERN_TRANSCRIPT_CACHE ??= '0'
import assert from 'node:assert/strict'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import type { ThreadEvent, ThreadsGetResult } from '../../../../packages/kybern-client/src/types.ts'
const pending: ((value: ThreadsGetResult) => void)[] = []
const callbacks: ((event: ThreadEvent) => void)[] = []
let subscribed = 0, unsubscribed = 0
KybernClient.prototype.connect = () => {}
KybernClient.prototype.call = (() => new Promise((resolve) => pending.push(resolve))) as typeof KybernClient.prototype.call
// Like the real client: a subscription is acknowledged with its head right after it is sent.
KybernClient.prototype.subscribeEvents = ((_params: unknown, callback: (event: ThreadEvent) => void, onSubscribed?: (head: number, replay: { resumed: boolean; supported: boolean }) => void) => {
  subscribed++; callbacks.push(callback)
  queueMicrotask(() => onSubscribed?.(0, { resumed: false, supported: false }))
  return { unsubscribe: () => { unsubscribed++ } }
}) as typeof KybernClient.prototype.subscribeEvents
const { connect, selectThread, getState, resetClient } = await import('../state.ts')
connect()
// `as_of_seq` covers the subscription's head, so no gap read follows the page.
const result = (seq: number) => ({ thread: { id: 'same', last_seq: seq }, transcript: [], pending_approvals: [], notes: '', as_of_seq: seq }) as unknown as ThreadsGetResult
const first = selectThread('same'), second = selectThread('same')
await Bun.sleep(0)
assert.equal(pending.length, 1, 'a superseded selection never reads the thread')
pending[0]!(result(20)); await second; await first
assert.equal(getState().open.lastSeq, 20)
assert.equal(subscribed, 1)
// An explicit reselect refreshes the thread: the old subscription goes, and its late events are ignored.
const third = selectThread('same')
await Bun.sleep(0)
pending[1]!(result(30)); await third
callbacks[0]!({ kind: 'thread_notes_updated', thread_id: 'same', seq: 31, at: new Date().toISOString(), notes: { text: 'stale', revision: 1 } } as unknown as ThreadEvent)
assert.equal(getState().open.lastSeq, 30)
assert.equal(unsubscribed, 1)
assert.equal(subscribed, 2)
const fourth = selectThread('same')
await Bun.sleep(0)
resetClient(); pending[2]!(result(40)); await fourth
assert.notEqual(getState().open.lastSeq, 40, 'a page answered after a reset never reaches the pane')
assert.equal(unsubscribed, 3, 'the reset drops the reselected session too')
console.log('PASS same-thread hydration generation and stale callback isolation')
