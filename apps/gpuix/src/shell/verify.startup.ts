import assert from 'node:assert/strict'
import { KybernClient, type ConnectionStatus } from '../../../../packages/kybern-client/src/client.ts'
import type { ThreadsGetResult, ThreadsListResult, ProjectsListResult } from '../../../../packages/kybern-client/src/types.ts'
const calls: string[] = []
const params: unknown[] = []
let status!: (status: ConnectionStatus) => void
let resolveList!: (value: ThreadsListResult) => void
let resolveThread!: (value: ThreadsGetResult) => void
let resolveProjects!: (value: ProjectsListResult) => void
KybernClient.prototype.connect = () => {}
KybernClient.prototype.onStatus = callback => { status = callback; return () => {} }
KybernClient.prototype.call = ((method: string, input: unknown) => {
  calls.push(method)
  params.push(input)
  return new Promise(resolve => { if (method === 'threads.get') resolveThread = resolve; if (method === 'threads.list') resolveList = resolve; if(method === 'projects.list')resolveProjects=resolve })
}) as typeof KybernClient.prototype.call
KybernClient.prototype.subscribeEvents = (() => ({ unsubscribe() {}, lastSeq: 20 })) as typeof KybernClient.prototype.subscribeEvents
const { connect, getState, onThreadActivity, resetClient, setPane } = await import('../state.ts')
await connect()
setPane('main', { selectedId: 'last-open-thread' })
status('open')
assert.ok(calls.includes('threads.get'), 'the restored thread must hydrate before project/thread lists return')
assert.ok(calls.includes('projects.list'))
assert.ok(calls.includes('threads.list'))
assert.ok(calls.indexOf('projects.list') < calls.indexOf('threads.get'), 'queue the project index before transcript reconstruction')
assert.deepEqual(params[calls.indexOf('projects.list')], {refresh_git:false}, 'first sidebar index does not wait for Git subprocesses')
resolveThread({ thread: { id: 'last-open-thread', last_seq: 20 }, transcript: [], pending_approvals: [], notes: { text: '', revision: 0 } } as unknown as ThreadsGetResult)
await Bun.sleep(0)
assert.equal(getState().open.loaded, true)
assert.equal(getState().listsLoaded, false, 'thread content is independent of a slow project Git refresh')
const received: unknown[] = []
const stop = onThreadActivity(value => received.push(value))
const activity = [{ thread_id: 'last-open-thread', tasks: [] }]
resolveList({ threads: [], activity } as unknown as ThreadsListResult)
await Bun.sleep(0)
assert.deepEqual(received, [activity], 'activity is published before the slow project list returns')
const late: unknown[] = []
const stopLate = onThreadActivity(value => late.push(value))
assert.deepEqual(late, [activity], 'late navigation setup reuses the already fetched activity')
resolveProjects({projects:[]})
await Bun.sleep(0)
assert.equal(getState().listsLoaded,true)
assert.equal(calls.filter(method=>method==='projects.list').length,2,'Git status refresh still follows the first index')
assert.deepEqual(params.at(-1),{},'the follow-up preserves normal Git discovery')
const index = getState().projects
resolveProjects({projects:[]})
await Bun.sleep(0)
assert.equal(getState().projects,index,'unchanged Git probes preserve the already mounted sidebar index')
stop(); stopLate(); resetClient()
let leaked = false
const stopReset = onThreadActivity(() => { leaked = true })
assert.equal(leaked, false, 'another connection must not inherit old activity')
stopReset()
