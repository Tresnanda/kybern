/** Controlled ancestor-invalidation diagnosis, with the region path OFF. */
import path from 'node:path'
import assert from 'node:assert/strict'
import {writeFileSync} from 'node:fs'
import {launchFixture} from '../scripts/idle-harness.ts'
import {pacingLock} from './loops8-lock.ts'
import {waitForNativeBuilds} from './loops8-build-free.ts'
delete process.env.KYBERN_FRAME_TIMES
await waitForNativeBuilds()
const release=await pacingLock(),results=[]
try{for(const addon of ['before.node','gpuix-native.darwin-arm64.node'])for(const hover of [false,true]){
 const f=await launchFixture(path.resolve('native/paint-lab.tsx'),{GPUIX_BACKGROUND:'1',KYBERN_SCOPED_PAINT:'1',KYBERN_DEBUG_ISLANDS:'1',KYBERN_PAINT_LOG_POINTER:'1',KYBERN_REGION_PAINT:'0',KYBERN_REGION_LAYERS:'0',KYBERN_GPU_TRACE:'0',NAPI_RS_NATIVE_LIBRARY_PATH:path.resolve('native/build',addon)})
 try{
  const a=f.app;await a.getByTestId('fill').waitFor({timeoutMs:30000});await a.getByTestId('park').hover()
  const root=(await a.getByTestId('app-ready').element()).id
  const previous=(f.diagnostics().match(/scoped paint/g)??[]).length
  await a.call('keyDown',{elementId:root,key:'t'})
  const deadline=Date.now()+5000
  while((f.diagnostics().match(/scoped paint/g)??[]).length<=previous){assert.ok(Date.now()<deadline);await Bun.sleep(10)}
  const before=f.counts()
  if(hover)await a.getByTestId('button').hover()
  while(!f.diagnostics().includes('[paint-lab] done')){assert.ok(Date.now()<deadline);await Bun.sleep(10)}
  await a.call('getPaintedText',{})
  while((f.diagnostics().match(/scoped paint/g)??[]).length<previous+8){assert.ok(Date.now()<deadline);await Bun.sleep(10)}
  const renders=f.counts().renders-before.renders,diagnostics=f.diagnostics()
  if(hover){assert.match(diagnostics,/pointer enter button/);assert.ok(renders>=2)}else assert.equal(renders,0)
  results.push({addon,hover,region:'0',layers:'0',trace:'0',renders,diagnostics});console.log(JSON.stringify({addon,hover,renders}))
 }finally{await f.close()}
}
}finally{release();writeFileSync('/Users/mymac/projects/ade/previews/gpuix/round8/loops/paint-regression.json',JSON.stringify(results,null,2))}
