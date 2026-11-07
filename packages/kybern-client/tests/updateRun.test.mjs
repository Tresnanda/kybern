import assert from 'node:assert/strict'
import { test } from 'node:test'
import { beginUpdate, reconcileUpdates, acceptUpdates, saveUpdateRun, restoreUpdateRun, updateRunSummary } from '../src/updateRun.ts'
const machine = (update, status = 'online') => ({ machine_id: 'a', name: 'Studio', status, version: update?.current_version ?? '0.22.1', features: ['update.progress.v1'], update })
const update = (status, overrides = {}) => ({ update_id: 'attempt', target_version: '0.23.0', current_version: '0.22.1', latest_version: '0.23.0', status, message: '', checked_at: null, ...overrides })
test('optimistic checking is synchronous for every member', () => {
 const run = beginUpdate([machine(), { ...machine(), machine_id: 'b' }], 0)
 assert.deepEqual(Object.values(run).map(r => r.phase), ['checking','checking'])
})
test('restart stays visible while offline and survives serialization', () => {
 let run = reconcileUpdates(beginUpdate([machine()],0), [machine(update('restarting'))])
 run = restoreUpdateRun(saveUpdateRun(run))
 run = reconcileUpdates(run, [machine(update('failed'), 'offline')])
 assert.equal(run.a.phase, 'restarting')
 assert.equal(run.a.updateId, 'attempt')
 assert.equal(updateRunSummary(run,180_000), 'Waiting for Studio…')
})
test('completion requires matching attempt and target, rollback fails', () => {
 const run = reconcileUpdates(beginUpdate([machine()],0), [machine(update('restarting'))])
 assert.equal(reconcileUpdates(run,[machine(update('current',{update_id:'old',current_version:'0.23.0'}))]).a.phase,'restarting')
 assert.equal(reconcileUpdates(run,[machine(update('current',{current_version:'0.23.0'}))]).a.phase,'updated')
 assert.equal(reconcileUpdates(run,[machine(update('current',{current_version:'0.22.1'}))]).a.phase,'failed')
 assert.equal(updateRunSummary(reconcileUpdates(run,[machine(update('current',{current_version:'0.23.0'}))])),'All machines on 0.23.0')
})
test('old terminal presence does not finish a newly clicked run', () => {
 const m = machine(update('current',{current_version:'0.23.0'}))
 assert.equal(reconcileUpdates(beginUpdate([m],0),[m]).a.phase,'checking')
})
test('legacy answers remain one shot and skips explain versions', () => {
 const m = { ...machine(), features: [] }
 assert.equal(acceptUpdates(beginUpdate([m]),{started:['a'],skipped:[]},[m]).a.phase,'legacy')
 assert.equal(acceptUpdates(beginUpdate([m]),{started:[],skipped:[{machine_id:'a',reason:'Already up to date'}]},[m]).a.text,'Already on 0.22.1')
})
test('waiting names the thread and download has progress', () => {
 const run=beginUpdate([machine()])
 assert.equal(reconcileUpdates(run,[machine(update('waiting',{busy_thread:'Review PR'}))]).a.text,'Waiting for “Review PR”')
 assert.equal(reconcileUpdates(run,[machine(update('updating',{download_percent:64}))]).a.progress,64)
})
test('damaged persistence is discarded', () => {
 for(const input of ['no','{}','{"version":1,"rows":[{}]}']) assert.deepEqual(restoreUpdateRun(input),{})
})

test('restart completion cannot change the original target', () => {
 const run = reconcileUpdates(beginUpdate([machine()],0), [machine(update('restarting'))])
 assert.equal(reconcileUpdates(run,[machine(update('current',{target_version:'0.24.0',current_version:'0.24.0'}))]).a.phase,'failed')
})

test('late storage hydration cannot replace a newly started run', async () => {
 const { UpdateRunStore } = await import('../src/updateRun.ts')
 const store = new UpdateRunStore()
 const saved = saveUpdateRun(reconcileUpdates(beginUpdate([machine()],0),[machine(update('restarting'))]))
 store.begin([machine()],1)
 store.hydrate(saved)
 assert.equal(store.get().a.phase,'checking')
 assert.equal(store.get().a.startedAt,1)
})
test('clicking while an attempt already runs keeps following its identity', () => {
 const m = machine(update('waiting'))
 const run = beginUpdate([m])
 assert.equal(run.a.phase,'checking')
 assert.equal(reconcileUpdates(run,[machine(update('restarting'))]).a.phase,'restarting')
})

test('a later attempt observed on another device uses its own target', () => {
 const run = reconcileUpdates({},[machine(update('current',{current_version:'0.23.0'}))],0)
 const next = reconcileUpdates(run,[machine(update('current',{update_id:'next-attempt',target_version:'0.24.0',current_version:'0.24.0'}))],1)
 assert.equal(next.a.phase,'updated')
 assert.equal(next.a.targetVersion,'0.24.0')
 assert.equal(next.a.startedAt,1)
})
