/** Reproduce full-shell pointer routing with either native binary. Scratch only. */
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFileSync, mkdirSync } from 'node:fs'
import { KybernClient } from '../../../packages/kybern-client/src/client.ts'
import { openDock, absent } from '../scripts/dock-waits.ts'
import { launchFixture } from './harness.ts'
const data=process.env.KYBERN_DATA_DIR!
assert.ok(data && (data.includes('gpuix-scratch') || data.endsWith('/apps/gpuix/.combined/data')))
const c=new KybernClient({url:`ws://127.0.0.1:${readFileSync(path.join(data,'daemon.port'),'utf8').trim()}/ws`,token:readFileSync(path.join(data,'daemon.token'),'utf8').trim()})
c.connect();while(c.status!=='open') await Bun.sleep(30)
const fixtureThread=process.env.KYBERN_GPUIX_THREAD
const before=await c.call('settings.get',{})
const f=await launchFixture(path.join(import.meta.dir,'../src/main.tsx'),{GPUIX_BACKGROUND:'1',KYBERN_DATA_DIR:data,KYBERN_URL:'',KYBERN_TOKEN:'',KYBERN_APPEARANCE:'dark'})
try {
 const a=f.app
 await a.getByTestId('app-ready').waitFor({timeoutMs:60000})
 await a.getByTestId('rail-settings').click()
 const control=a.getByTestId('settings-worktrees');await control.waitFor();await Bun.sleep(2000)
 if(process.argv.includes('--clock')) {await a.clock.pause();await a.clock.fastForward(400)}
 await control.click();await Bun.sleep(600)
 const clicked=(await c.call('settings.get',{})).worktrees_default
 console.log('pointer changed worktrees_default:',clicked!==before.worktrees_default)
 await control.press('space');await Bun.sleep(600)
 const keyed=(await c.call('settings.get',{})).worktrees_default
 console.log('Space changed worktrees_default:',keyed!==clicked)
 if(process.env.KYBERN_VERIFY_OUTPUT) {mkdirSync(process.env.KYBERN_VERIFY_OUTPUT,{recursive:true});await a.screenshot({path:path.join(process.env.KYBERN_VERIFY_OUTPUT,'pointer-check.png')})}
 assert.notEqual(clicked,before.worktrees_default,'Pointer click did not reach the switch; compare islands-prev.node')
 assert.notEqual(keyed,clicked,'Space did not reach the switch')
 if(fixtureThread) {
  console.log('shell: close Settings')
  await a.getByTestId('settings-back').click()
  await absent(a.getByTestId('page-settings'))
  console.log('shell: sidebar thread')
  await a.getByTestId(`thread-${fixtureThread}`).click()
  await a.getByTestId('composer').waitFor()
  console.log('shell: dock toggle')
  await a.getByTestId('dock-toggle').click()
  await openDock(a.getByTestId('right-dock'))
  console.log('shell: add Notes')
  await a.getByTestId('dock-add').click()
  await a.getByTestId('dock-add-notes').click()
  await a.getByTestId('dock-notes').waitFor()
  console.log('shell: collapse dock')
  await a.getByTestId('dock-collapse').click()
  await absent(a.getByTestId('dock-notes'))
  console.log('ok  titlebar button, sidebar thread, dock entrance/tab/collapse pointer routing')
 }
}finally {console.log(f.diagnostics());await f.close();await c.call('settings.update',{settings:before});c.close()}
