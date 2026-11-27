import assert from 'node:assert/strict'
import { test } from 'node:test'
import { beginUpdate, reconcileUpdates, acceptUpdates, saveUpdateRun, restoreUpdateRun, updateRunSummary, RESTORE_MAX_AGE_MS } from '../src/updateRun.ts'
const machine = (update, status = 'online', version) => ({ machine_id: 'a', name: 'Studio', status, version: version ?? update?.current_version ?? '0.22.1', features: ['update.progress.v1'], update })
const update = (status, overrides = {}) => ({ update_id: 'attempt', target_version: '0.23.0', current_version: '0.22.1', latest_version: '0.23.0', status, message: '', checked_at: null, ...overrides })
test('optimistic checking is synchronous for every member', () => {
 const run = beginUpdate([machine(), { ...machine(), machine_id: 'b' }], 0)
 assert.deepEqual(Object.values(run).map(r => r.phase), ['checking','checking'])
})
test('restart stays visible while offline and survives serialization', () => {
 let run = reconcileUpdates(beginUpdate([machine()],0), [machine(update('restarting'))], 0)
 run = restoreUpdateRun(saveUpdateRun(run), 1_000)
 run = reconcileUpdates(run, [machine(update('failed'), 'offline')], 2_000)
 assert.equal(run.a.phase, 'restarting')
 assert.equal(run.a.updateId, 'attempt')
 assert.equal(updateRunSummary(run,180_000), 'Waiting for Studio…')
})
test('completion requires matching attempt and target (or newer), rollback fails', () => {
 const run = reconcileUpdates(beginUpdate([machine()],0), [machine(update('restarting'))], 0)
 assert.equal(reconcileUpdates(run,[machine(update('current',{update_id:'old',current_version:'0.23.0'}))], 1).a.phase,'restarting')
 assert.equal(reconcileUpdates(run,[machine(update('current',{current_version:'0.23.0'}))], 1).a.phase,'updated')
 assert.equal(reconcileUpdates(run,[machine(update('current',{current_version:'0.22.1'}))], 1).a.phase,'failed')
 assert.equal(updateRunSummary(reconcileUpdates(run,[machine(update('current',{current_version:'0.23.0'}))], 1)),'All machines on 0.23.0')
})
test('old terminal presence does not finish a newly clicked run', () => {
 const m = machine(update('current',{current_version:'0.23.0'}))
 assert.equal(reconcileUpdates(beginUpdate([m],0),[m], 1).a.phase,'checking')
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

test('running the target or a newer version reads as updated, even if daemon reported failed', () => {
 const run = reconcileUpdates(beginUpdate([machine()],0), [machine(update('restarting'))], 0)
 assert.equal(reconcileUpdates(run,[machine(update('current',{target_version:'0.24.0',current_version:'0.24.0'}))], 1).a.phase,'updated')
 // Peer upgraded 0.21.6 → 0.27.1 whose daemon falsely persisted failed: "The requested version did not start."
 const falseFail = machine(
   update('failed', { update_id: 'legacy-1', target_version: null, current_version: '0.27.1', latest_version: '0.27.1', message: 'The requested version did not start. Retry the update.' }),
   'online',
   '0.27.1',
 )
 const reconciled = reconcileUpdates({}, [falseFail], 1)
 assert.equal(reconciled.a.phase, 'updated')
 assert.equal(reconciled.a.currentVersion, '0.27.1')
})

test('stale restored runs are discarded by age or superseded version, and offline completed rows clear', () => {
 const oldRun = reconcileUpdates(beginUpdate([machine(undefined, 'online', '0.25.3')], 0), [machine(update('current', { target_version: null, current_version: '0.25.3' }), 'online', '0.25.3')], 0)
 const serialized = saveUpdateRun(oldRun)
 assert.deepEqual(restoreUpdateRun(serialized, RESTORE_MAX_AGE_MS + 1), {})
 // Even within the time window, a machine that moved to a newer version drops the old row.
 const freshRestored = restoreUpdateRun(serialized, 1000)
 const afterUpgrade = reconcileUpdates(freshRestored, [machine(undefined, 'online', '0.27.1')], 2000)
 assert.equal(afterUpgrade.a, undefined)
 // An offline machine drops a prior completed row instead of showing "Updated · 0.26.0".
 const doneRun = reconcileUpdates(beginUpdate([machine(undefined, 'online', '0.26.0')], 0), [machine(update('current', { target_version: '0.26.0', current_version: '0.26.0' }), 'online', '0.26.0')], 1)
 assert.equal(doneRun.a.phase, 'updated')
 const offlineRun = reconcileUpdates(doneRun, [machine(undefined, 'offline', '0.26.0')], 2)
 assert.equal(offlineRun.a, undefined)
})

test('rows prefer MachineCard.version over stale update.current_version and unsupported desktop machine on newest reads up to date', () => {
 const desktop = machine(
   update('unsupported', { update_id: null, target_version: null, current_version: '0.25.3', latest_version: null, message: 'Managed by the Kybern desktop app on this machine; updating the app updates it.' }),
   'online',
   '0.27.1',
 )
 const peer = { ...machine(update('current', { update_id: 'peer-new', target_version: '0.27.1', current_version: '0.27.1', latest_version: '0.27.1' }), 'online', '0.27.1'), machine_id: 'b', name: 'fedora' }
 const peerBefore = { ...peer, update: undefined }
 const run = reconcileUpdates(beginUpdate([desktop, peerBefore], 100), [desktop, peer], 101)
 assert.equal(run.a.currentVersion, '0.27.1')
 assert.equal(run.a.phase, 'skipped')
 assert.equal(run.a.text, 'Already on 0.27.1')
 assert.equal(updateRunSummary(run, 102), 'All machines on 0.27.1')
 // A behind unsupported desktop machine still keeps its guidance message.
 const behindDesktop = { ...desktop, version: '0.26.0' }
 const behindRun = reconcileUpdates(beginUpdate([behindDesktop, peerBefore], 100), [behindDesktop, peer], 101)
 assert.equal(behindRun.a.currentVersion, '0.26.0')
 assert.equal(behindRun.a.phase, 'skipped')
 assert.match(behindRun.a.text, /desktop app/)
})

test('late storage hydration cannot replace a newly started run', async () => {
 const { UpdateRunStore } = await import('../src/updateRun.ts')
 const store = new UpdateRunStore()
 const saved = saveUpdateRun(reconcileUpdates(beginUpdate([machine()],0),[machine(update('restarting'))], 0))
 store.begin([machine()],1)
 store.hydrate(saved, 1)
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

test('approved copy avoids repeating version or download percentage', () => {
 const run = beginUpdate([machine()])
 assert.equal(reconcileUpdates(run,[machine(update('updating',{download_percent:64}))]).a.text,'Downloading')
 assert.equal(reconcileUpdates(run,[machine(update('current',{current_version:'0.23.0'}))]).a.text,'Updated')
})
test('mixed running and failed updates keep the retry count visible', () => {
 const run = beginUpdate([machine()],0)
 run.b = { ...run.a, machineId:'b', phase:'failed' }
 assert.equal(updateRunSummary(run,1),'Updating 1 machine · 1 needs a retry')
})
test('a failed request is actionable and a retry changes only that machine', async () => {
 const { UpdateRunStore } = await import('../src/updateRun.ts')
 const store = new UpdateRunStore()
 store.begin([machine(),{...machine(),machine_id:'b'}],0)
 store.fail(['a'])
 assert.equal(store.get().a.phase,'failed')
 assert.match(store.get().a.text,/retry/)
 const other = store.get().b
 store.begin([machine()],1)
 assert.equal(store.get().a.phase,'checking')
 assert.equal(store.get().b,other)
})
