// N1 scratch pool. After a menu-sized wide backdrop closes, the process
// footprint returns within 2 MiB of its pre-open value within 1 s (the idle
// scratch is purgeable at once); 30 presented frames without a backdrop release
// it; a scratch much larger than recent requests is re-created smaller. Runs the
// default (half-resolution) and KYBERN_BACKDROP_HALFRES=0 (4× larger scratch).
// Gauges come from KYBERN_MEMORY_COUNTERS (metalGauges[5] = scratch bytes).
import '../../src/native/local-build.ts'
import assert from 'node:assert/strict'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {mkdirSync,writeFileSync} from 'node:fs'
import {launchFixture} from '../../src/requests/harness.ts'
const out=process.env.KYBERN_VERIFY_OUTPUT??path.resolve(import.meta.dir,'../../native/build/scratch')
// The fixture never talks to a daemon; the harness still requires a scratch data dir outside ~/.kybern.
const scratch=process.env.KYBERN_HALFRES_SCRATCH??path.join(process.env.TMPDIR??'/tmp','kybern-halfres-check')
mkdirSync(out,{recursive:true});mkdirSync(scratch,{recursive:true})
const MiB=1024*1024,results:unknown[]=[]
for(const half of ['1','0']){
 const f=await launchFixture(path.resolve(import.meta.dir,'scratch-lab.tsx'),{KYBERN_DATA_DIR:scratch,KYBERN_CLIENT_CONFIG_DIR:path.join(scratch,'client'),KYBERN_URL:'',KYBERN_TOKEN:'',GPUIX_BACKGROUND:'1',KYBERN_MEMORY_COUNTERS:'1',KYBERN_BACKDROP_HALFRES:half})
 const footprint=()=>Number(execFileSync('footprint',['-f','bytes','-p',String(f.pid)],{encoding:'utf8'}).match(/Footprint:\s+(\d+) B/)![1])
 try{
  await f.app.getByTestId('app-ready').waitFor();await Bun.sleep(1000)
  const root=(await f.app.getByTestId('app-ready').element()).id
  const key=async(k:string,wait=150)=>{await f.app.call('keyDown',{elementId:root,key:k});await Bun.sleep(wait)}
  const scratchBytes=async()=>{await key('s');return (JSON.parse(await f.app.getByTestId('stats').textContent()) as number[])[5]!}
  // Presented frames: a label that changes every few ms.
  const frames=async(ms:number)=>{await key('p',ms);await key('q')}
  // Warm-up: the first backdrop compiles its pipelines; those stay and are not scratch.
  await key('o',600);await key('c',300);await frames(800)
  assert.equal(await scratchBytes(),0,'30 presented frames without a backdrop must release the scratch')
  await Bun.sleep(500)
  const before=footprint()
  await key('o',800)
  const open=await scratchBytes(),opened=footprint()
  assert.ok(open>0,'An open menu must hold a scratch')
  await key('c',1000)
  const closed=footprint(),kept=await scratchBytes()
  const row={halfres:half,scratchBytes:open,footprintBefore:before,footprintOpen:opened,footprintClosed1s:closed,deltaMiB:+((closed-before)/MiB).toFixed(3),keptPurgeableBytes:kept}
  await frames(800)
  const released=await scratchBytes()
  // Shrink: a large menu, then a small one held open (frames keep presenting).
  await key('n');await key('o',400)
  const large=await scratchBytes()
  await key('n');await key('p',3000);await key('q')
  const small=await scratchBytes()
  await key('c');await frames(800)
  Object.assign(row,{releasedAfterFrames:released,largeBytes:large,afterShrinkBytes:small})
  results.push(row);console.log(JSON.stringify(row))
  assert.ok(closed-before<=2*MiB,`halfres=${half}: footprint ${(closed-before)/MiB} MiB above the pre-open value 1 s after closing`)
  assert.equal(released,0,'the closed menu’s scratch must be released after 30 presented frames')
  assert.ok(large>open&&small>0&&small*2<=large,`halfres=${half}: the scratch must shrink once the large request is gone (${large} → ${small})`)
 }catch(e){console.error(f.diagnostics());throw e}finally{await f.close()}
}
writeFileSync(out+'/results.json',JSON.stringify(results,null,2))
console.log(`ok scratch pool: ${out}`)
