import {requireScreen,requireActiveSample} from '../bench/screen-state.ts'
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import path from 'node:path'
import {launchFixture} from '../../src/requests/harness.ts'
import {lease} from '../bench/lease.ts'
import {Telemetry,parseResources} from '../bench/telemetry.ts'
import {watchRun} from '../bench/process-gate.ts'
import {onExit} from '../bench/lifetime.ts'
const out=process.env.CADENCE_LOOP_EVIDENCE??'/Users/mymac/projects/ade/previews/gpuix/perf/cadence/loops'
mkdirSync(out,{recursive:true})
const root=path.resolve(import.meta.dir,'../../../..'),appdir=path.join(root,'apps/gpuix')
const label=process.env.CADENCE_SOURCE==='before'?'before':'after',native=process.env.CADENCE_NATIVE==='1',visual=process.env.CADENCE_VISUAL==='1'
const scenes=(process.env.CADENCE_LOOPS??'none,matrix,spin,connection,task,shimmer,skeleton,visual,elapsed,caret').split(',')
const results:unknown[]=[]
for(const scene of scenes){
 const release=await lease()
 let fixture:Awaited<ReturnType<typeof launchFixture>>|undefined
 const stop=onExit(async()=>{await fixture?.close();release()})
 const t=new Telemetry(),base=`${label}-${native?'native':'default'}-${scene}-${process.env.KYBERN_APPEARANCE??'dark'}-${process.env.KYBERN_REDUCED_MOTION??'0'}`
 try{
  requireScreen()
  fixture=await launchFixture(path.join(import.meta.dir,'loops-app.tsx'),{KYBERN_DATA_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-cadence-loops',KYBERN_CLIENT_CONFIG_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-cadence-loops/client',KYBERN_URL:'',KYBERN_TOKEN:'',GPUIX_BACKGROUND:'1',KYBERN_FRAME_TIMES:'1',KYBERN_FRAME_COSTS:'1',KYBERN_FULL_RATE:'1',CADENCE_LOOP:scene,CADENCE_VISIBILITY_CONTROL:label==='before'?'1':'0',KYBERN_NATIVE_PAINT_ANIMATIONS:native?'1':'0',KYBERN_NATIVE_TEXT_PAINT:native?'1':'0'}, {stderr:t.stderr})
  const app=fixture.app,rootNode=app.getByTestId('app-ready')
  await rootNode.waitFor({timeoutMs:30000});await app.call('blur',{});await app.mouse.move({x:710,y:350})
  if(visual){
   // Captures are separate from resource/timing runs; freeze native phases for
   // strips just as the existing native loops harness does.
   await Bun.sleep(1000)
   for(let i=0;i<8;i++){await app.screenshot({path:path.join(out,`${base}-${i}.png`)});await Bun.sleep(({task:3200,skeleton:2000,shimmer:1600,visual:1600,connection:1300,matrix:1200} as Record<string,number>)[scene]/8||125)}
   await rootNode.press('o');await Bun.sleep(700);await app.screenshot({path:path.join(out,`${base}-clipped.png`)})
   requireScreen()
  }else{
   await Bun.sleep(10000)
   const gate=watchRun(),mark=t.mark(),at=performance.now()
   const sampler=Bun.spawn(['bun',path.join(appdir,'perf/sample.ts'),'15',`GPUIX=${fixture.pid}`],{stdout:'pipe',stderr:'pipe'})
   const unsampler=onExit(()=>sampler.kill())
   const raw=await new Response(sampler.stdout).text(),error=await new Response(sampler.stderr).text(),exit=await sampler.exited;unsampler();if(exit)throw Error(error)
   const metrics=t.result(mark),windowMs=performance.now()-at
   let clippedResources:unknown=null
   if(scene==='matrix'||scene==='connection'){
    await rootNode.press('o');await Bun.sleep(10000)
    const clippedMark=t.mark()
    const clippedSampler=Bun.spawn(['bun',path.join(appdir,'perf/sample.ts'),'15',`GPUIX=${fixture.pid}`],{stdout:'pipe',stderr:'pipe'})
    const unclip=onExit(()=>clippedSampler.kill())
    const clippedRaw=await new Response(clippedSampler.stdout).text(),clippedError=await new Response(clippedSampler.stderr).text(),clippedExit=await clippedSampler.exited;unclip();if(clippedExit)throw Error(clippedError)
    clippedResources={...t.result(clippedMark),resources:parseResources(clippedRaw)}
    writeFileSync(path.join(out,`${base}-clipped-resources.txt`),clippedRaw)
    await rootNode.press('o');await Bun.sleep(1000)
   }
   const parked:Record<string,unknown>={}
   for(const [state,key] of [['clipped','o'],['visible-again','o'],['minimized','m'],['restored','r'],['unmounted','h']] as const){
    await rootNode.press(key);await Bun.sleep(1000)
    const m=t.mark();await Bun.sleep(1200);parked[state]=t.result(m)
   }
   if(scene==='none'&&metrics.frames.count!==0)throw Error('Idle loop fixture submitted recurring frames')
   if(scene!=='none')requireActiveSample(metrics.frames.count,parseResources(raw).gpuMs,15)
   if(label==='after')for(const state of ['clipped','minimized','unmounted'])if((parked[state] as any).frames.count!==0)throw Error(`${scene} still submits while ${state}`)
   const status=gate.finish()
   if(status.overlap||status.orphanOverlap||status.screenInvalid)throw Error('Contaminated loop control; discard/repeat')
   const addon=path.join(appdir,'native/build/gpuix-native.darwin-arm64.node')
   results.push({label,scene,native,fullRate:'1',theme:process.env.KYBERN_APPEARANCE??'dark',reduced:process.env.KYBERN_REDUCED_MOTION??'0',addonSha256:createHash('sha256').update(readFileSync(addon)).digest('hex'),windowMs,...metrics,resources:parseResources(raw),clippedResources,parked,status})
   writeFileSync(path.join(out,`${base}-resources.txt`),raw)
  }
  writeFileSync(path.join(out,`${base}.log`),t.raw)
 }finally{stop();await fixture?.close();release()}
 writeFileSync(path.join(out,`${label}-${native?'native':'default'}-${visual?'visual':'resources'}.json`),JSON.stringify(results,null,2))
}
console.log(JSON.stringify(results.map((r:any)=>({...r,status:undefined,parked:Object.fromEntries(Object.entries(r.parked??{}).map(([k,v]:[string,any])=>[k,v.frames.count]))})),null,2))
