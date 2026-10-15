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
KybernClient.prototype.subscribeEvents = ((p: { thread_id: string }, call: (event: ThreadEvent) => void) => {
  const record = { id: p.thread_id, call, stopped: false }; callbacks.push(record)
  return { unsubscribe: () => { record.stopped = true } }
}) as typeof KybernClient.prototype.subscribeEvents
const state = await import('../state.ts')
const { switchEnvironment, activeEnvironment } = await import('../shell/environment.ts')
const result = (id: string, seq: number) => ({ thread: { id, last_seq: seq }, transcript: [], pending_approvals: [], pending_questions: [], notes: '' }) as unknown as ThreadsGetResult
function resolve(id: string, seq: number) { const item = pending.findIndex(p => p.id === id); assert.ok(item >= 0); pending.splice(item, 1)[0]!.resolve(result(id, seq)) }
state.connect()
state.createPane('two')
const a = state.selectPaneThread('main', 'a'), b = state.selectPaneThread('two', 'b')
resolve('b', 20); await b; resolve('a', 10); await a
assert.equal(state.getPaneState('main').open.lastSeq, 10)
assert.equal(state.getPaneState('two').open.lastSeq, 20)
state.focusPane('two'); assert.equal(state.getState().selectedId, 'b')
const same = state.selectPaneThread('two', 'a'); await same
assert.equal(callbacks.filter(c => c.id === 'a').length, 1)
assert.equal(callbacks.find(c => c.id === 'b')!.stopped, true)
assert.equal(state.getPaneState('main').open, state.getPaneState('two').open)
callbacks[0]!.call({ kind: 'thread_notes_updated', thread_id: 'b', seq: 21, at: '', notes: { text: 'stale', revision: 1 } })
assert.equal(state.getState().open.lastSeq, 10)
callbacks.find(c => c.id === 'a')!.call({ kind: 'thread_notes_updated', thread_id: 'a', seq: 11, at: '', notes: { text: 'shared event', revision: 1 } })
assert.equal(state.getPaneState('main').open.lastSeq, 11)
assert.equal(state.getPaneState('two').open.lastSeq, 11)
assert.equal(state.getPaneState('main').open, state.getPaneState('two').open)
// A shared owner leaving must not stop the surviving pane's subscription.
const c = state.selectPaneThread('two', 'c')
assert.equal(callbacks.find(c => c.id === 'a')!.stopped, false)
state.closePaneState('two'); resolve('c', 30); await c
assert.equal(callbacks.some(c => c.id === 'c'), false)
assert.equal(state.getState().selectedId, 'a')
// Explicit same-thread refresh still rejects the first hydration generation.
const first = state.selectThread('race'), second = state.selectThread('race')
const older = pending.shift()!, newer = pending.shift()!
newer.resolve(result('race', 40)); await second
older.resolve(result('race', 5)); await first
assert.equal(state.getState().open.lastSeq, 40)
assert.equal(callbacks.filter(c => c.id === 'race').length, 1)
// Environment switch invalidates every pending pane and subscription.
state.createPane('two')
const late = state.selectPaneThread('two', 'late')
switchEnvironment({ ...activeEnvironment(), dataDir: process.env.KYBERN_DATA_DIR! + '/next' })
resolve('late', 100); await late
assert.deepEqual(state.getPaneIds(), ['main'])
assert.equal(state.getState().selectedId, null)
assert.ok(callbacks.every(c => c.stopped))
assert.equal(callbacks.some(c => c.id === 'late'), false)
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
const savedRoot = split.getSplitRoot()
flush()
const previous = activeEnvironment()
switchEnvironment({ ...previous, dataDir: process.env.KYBERN_DATA_DIR! + '/third' })
assert.equal(split.getSplitRoot().kind, 'leaf')
switchEnvironment(previous)
assert.deepEqual(split.getSplitRoot(), savedRoot)
state.resetClient()
console.log('PASS topology bounds and environment-specific persistence')
console.log('PASS different threads, shared subscription, pane close, stale hydration and environment reset')
