import path from 'node:path'
import {writeFileSync} from 'node:fs'
import assert from 'node:assert/strict'
import {launchFixture} from '../native/frame-harness.ts'
import {footprintMiB} from '../scripts/idle-metrics.ts'
import {pacingLock} from './pacing-lock.ts'
if(process.env.KYBERN_PACING_FIXTURE!=='1')throw Error('Use pacing-fixture.ts')
const release=await pacingLock(),enabled=process.argv[2]??'1'
const f=await launchFixture(path.join(import.meta.dir,'pacing-app.ts'),{KYBERN_NATIVE_PAINT_ANIMATIONS:'1',KYBERN_NATIVE_TEXT_PAINT:'1',KYBERN_REGION_PAINT:enabled,KYBERN_FULL_RATE:'1',KYBERN_VSYNC_WAKE:'1',KYBERN_FRAME_TIMES:'1',KYBERN_DEBUG_REGION:'1',NAPI_RS_NATIVE_LIBRARY_PATH:process.env.KYBERN_PACING_ADDON??path.join(import.meta.dir,'../native/build/gpuix-native.darwin-arm64.node')})
try {
 const a=f.app;await a.getByTestId('app-ready').waitFor({timeoutMs:60000});await a.getByTestId('composer').waitFor();await Bun.sleep(10000)
 const before=footprintMiB(f.pid)
 await a.getByTestId('rail-tasks').click();await a.getByTestId('task-filter-all').waitFor();await a.getByTestId('task-filter-all').click();if(await a.getByTestId('task-view-board').count())await a.getByTestId('task-view-board').click();else await a.getByText('Board').click()
 await a.mouse.move({x:1276,y:816})
 await Bun.sleep(2000);const active=footprintMiB(f.pid)
 await a.getByTestId('rail-home').click();await a.getByTestId('composer').waitFor();await Bun.sleep(2000)
 await a.mouse.move({x:1276,y:816})
 const count=f.counts().frames;await Bun.sleep(1000);assert.ok(f.counts().frames-count<=1,'home retained a recurring paint loop')
 const parked=footprintMiB(f.pid),regions=f.regions()
 if(enabled==='1'){assert.ok(regions.some(v=>v.includes('allocate')));assert.equal(regions.at(-1),'[paint-region] release')}
 const result={enabled,beforeMiB:before,activeMiB:active,parkedMiB:parked,regions}
 writeFileSync(`/Users/mymac/projects/ade/previews/gpuix/round7/pacing/memory-${enabled}.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result))
}finally{await f.close();release()}
