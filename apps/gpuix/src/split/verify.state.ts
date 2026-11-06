import { writeFileSync } from 'node:fs'
writeFileSync(process.env.KYBERN_DATA_DIR! + '/daemon.port', '1')
writeFileSync(process.env.KYBERN_DATA_DIR! + '/daemon.token', 'fixture')
import assert from 'node:assert/strict'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import type { ThreadEvent, ThreadsGetResult } from '../../../../packages/kybern-client/src/types.ts'
const pending: { id: string; resolve: (value: ThreadsGetResult) => void }[] = []
const callbacks: { id: string; call: (event: ThreadEvent) => void; stopped: boolean }[] = []
KybernClient.prototype.connect = () => {}
KybernClient.prototype.call = ((_method: string, p: { thread_id: string }) => new Promise(resolve => pending.push({ id: p.thread_id, resolve }))) as typeof KybernClient.prototype.call
// Like the real client: a subscription is acknowledged with its head right after it is sent.
KybernClient.prototype.subscribeEvents = ((p: { thread_id: string }, call: (event: ThreadEvent) => void, onSubscribed?: (head: number, replay: { resumed: boolean; supported: boolean }) => void) => {
  const record = { id: p.thread_id, call, stopped: false }; callbacks.push(record)
  queueMicrotask(() => onSubscribed?.(0, { resumed: false, supported: false }))
  return { unsubscribe: () => { record.stopped = true } }
}) as typeof KybernClient.prototype.subscribeEvents
const state = await import('../state.ts')
const result = (id: string, seq: number) => ({ thread: { id, last_seq: seq }, transcript: [], pending_approvals: [], pending_questions: [], notes: '', as_of_seq: seq }) as unknown as ThreadsGetResult
function resolve(id: string, seq: number) { const item = pending.findIndex(p => p.id === id); assert.ok(item >= 0); pending.splice(item, 1)[0]!.resolve(result(id, seq)) }
await state.connect()
state.createPane('two')
const a = state.selectPaneThread('main', 'a'), b = state.selectPaneThread('two', 'b')
// Opens look in the transcript cache first (microtasks), then subscribe and read together.
await Bun.sleep(0)
resolve('b', 20); await b; resolve('a', 10); await a
assert.equal(state.getPaneState('main').open.lastSeq, 10)
assert.equal(state.getPaneState('two').open.lastSeq, 20)
state.focusPane('two'); assert.equal(state.getState().selectedId, 'b')
const same = state.selectPaneThread('two', 'a'); await same
assert.equal(callbacks.filter(c => c.id === 'a').length, 1)
// The thread pane two left lingers (reopened within 5 minutes it draws at once); its events stay its own.
assert.equal(callbacks.find(c => c.id === 'b')!.stopped, false)
assert.equal(state.getPaneState('main').open, state.getPaneState('two').open)
callbacks.find(c => c.id === 'b')!.call({ kind: 'thread_notes_updated', thread_id: 'b', seq: 21, at: '', notes: { text: 'stale', revision: 1 } })
assert.equal(state.getState().open.lastSeq, 10)
assert.equal(state.getThreadOpen('b')?.lastSeq, 21)
callbacks.find(c => c.id === 'a')!.call({ kind: 'thread_notes_updated', thread_id: 'a', seq: 11, at: '', notes: { text: 'shared event', revision: 1 } })
assert.equal(state.getPaneState('main').open.lastSeq, 11)
assert.equal(state.getPaneState('two').open.lastSeq, 11)
assert.equal(state.getPaneState('main').open, state.getPaneState('two').open)
// A shared owner leaving must not stop the surviving pane's subscription.
const c = state.selectPaneThread('two', 'c')
assert.equal(callbacks.find(c => c.id === 'a')!.stopped, false)
// Closed before it loaded: nothing is read or subscribed.
state.closePaneState('two'); await Bun.sleep(0); await c
assert.equal(pending.some(p => p.id === 'c'), false)
assert.equal(callbacks.some(c => c.id === 'c'), false)
assert.equal(state.getState().selectedId, 'a')
// Explicit same-thread refresh still rejects the first hydration generation.
const first = state.selectThread('race'), second = state.selectThread('race')
await Bun.sleep(0)
assert.equal(pending.filter(p => p.id === 'race').length, 1, 'the superseded hydration never reads')
pending.shift()!.resolve(result('race', 40)); await second; await first
assert.equal(state.getState().open.lastSeq, 40)
assert.equal(callbacks.filter(c => c.id === 'race').length, 1)
state.resetClient()
const split = await import('./store.ts')
const { flush } = await import('../shell/persist.ts')
split.startSplitView()
assert.equal(split.splitPane('main', 'horizontal'), true)
const firstPair = split.collectThreadPanes(split.getSplitRoot())
assert.equal(firstPair.length, 2)
assert.equal(split.splitPane('main', 'horizontal'), false)
assert.equal(split.splitPane('main', 'vertical'), true)
assert.equal(split.splitPane(firstPair[1]!.id, 'vertical'), true)
assert.equal(split.collectThreadPanes(split.getSplitRoot()).length, 4)
assert.equal(split.splitPane('main', 'vertical'), false)
flush()
state.resetClient()
console.log('PASS topology bounds')
console.log('PASS different threads, shared subscription, pane close, stale hydration')
