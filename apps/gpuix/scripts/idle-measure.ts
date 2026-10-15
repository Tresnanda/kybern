/** bun scripts/idle-measure.ts [home|thread|tasks|settings]. Owns a fresh scratch fixture. */
import path from 'node:path'
import {cpuSeconds,gpuNs,footprintMiB} from './idle-metrics.ts'
import {launchFixture} from './idle-harness.ts'
if(process.env.KYBERN_IDLE_OWNED !== '1') {
 const runner=Bun.spawn(['bun',path.resolve(import.meta.dir,'idle-fixture.ts'),'--','bun',import.meta.path,...process.argv.slice(2)],{stdout:'inherit',stderr:'inherit',env:process.env})
 process.exit(await runner.exited)
}
if(!process.env.KYBERN_DATA_DIR?.includes('gpuix-scratch-idle-')) throw Error('Invalid scratch fixture')
const fixture=await launchFixture(path.resolve(import.meta.dir,'idle-app.ts'),{GPUIX_BACKGROUND:'1',KYBERN_APPEARANCE:'dark',KYBERN_DEBUG_ISLANDS:'1'})
try {
 const app=fixture.app
 await app.getByTestId('app-ready').waitFor({timeoutMs:60000});await Bun.sleep(3000)
 for(const scene of process.argv.slice(2).length?process.argv.slice(2):['home','thread','tasks','settings']) {
  if(scene==='thread') {const row=app.getByTestId(`thread-${process.env.KYBERN_IDLE_THREAD}`); await row.waitFor({timeoutMs:30000});await row.click()}
  else await app.getByTestId(`rail-${scene}`).click()
  if(scene==='tasks') {await app.getByTestId('task-filter-all').waitFor();await app.getByTestId('task-filter-all').click();if(await app.getByTestId('task-view-board').count()) await app.getByTestId('task-view-board').click(); else await app.getByText('Board').click()}
  await Bun.sleep(10000)
  const cpu0=cpuSeconds(fixture.pid), gpu0=gpuNs().get(fixture.pid)??0, before=fixture.counts(), started=performance.now()
  await Bun.sleep(15000)
  const cpu1=cpuSeconds(fixture.pid), gpu1=gpuNs().get(fixture.pid)??0, elapsed=(performance.now()-started)/1000, after=fixture.counts()
  // Read footprint after both time deltas: memory-query overhead is not CPU idle work.
  const footprint=footprintMiB(fixture.pid)
  console.log(JSON.stringify({scene,pid:fixture.pid,seconds:elapsed,cpuPercent:100*(cpu1-cpu0)/elapsed,gpuMs:(gpu1-gpu0)/1e6,footprintMiB:footprint,islandRenders:after.renders-before.renders,islandWakes:after.wakes-before.wakes,reactCommits:after.commits-before.commits}))

 }
 if(process.env.KYBERN_IDLE_LOGS==='1') console.log(fixture.diagnostics())
}finally{await fixture.close()}
