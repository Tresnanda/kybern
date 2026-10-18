import {onExit} from '../bench/lifetime.ts'
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdirSync,existsSync,rmSync} from 'node:fs'
import path from 'node:path'
import {seed} from '../bench/seed.ts'
import {lease} from '../bench/lease.ts'
import {watchRun} from '../bench/process-gate.ts'
import {screenState} from '../bench/screen-state.ts'
import {Telemetry,parseResources} from '../bench/telemetry.ts'
import {launchFixture} from '../../src/requests/harness.ts'
const evidence='/Users/mymac/projects/ade/previews/gpuix/perf/gpu/'+(process.env.KYBERN_GPU_PRECISE_LABEL??'precise');mkdirSync(evidence,{recursive:true})
process.env.KYBERN_BENCH_SCREEN_STATE_SCRIPT??='/Users/mymac/projects/ade-gpuix-scratch/screen-state.swift'
if(existsSync('native/build/gpu-final-pending'))throw Error('Complete native updater has not passed')
const fixture=await seed('/Users/mymac/projects/ade-gpuix-scratch/perf-gpu-precise',4335)
const results:unknown[]=[]
async function until<T>(fn:()=>Promise<T|false>,label:string,ms=30000):Promise<T>{const end=performance.now()+ms;for(;;){const v=await fn();if(v)return v;if(performance.now()>end)throw Error(label);await Bun.sleep(20)}}
try {
 for(const [scene,prune] of [['markdown-legacy','0'],['markdown','0'],['markdown','1'],['sidebar','0'],['sidebar','1']] as const){
  const release=await lease(),client=path.join(fixture.data,`client-${scene}-${prune}`),t=new Telemetry();mkdirSync(client,{recursive:true});rmSync(path.join(fixture.data,'gpuix-ui.json'),{force:true})
  const plan=path.join(client,'plan.json'),done=path.join(client,'done.json')
  let launched:Awaited<ReturnType<typeof launchFixture>>|undefined;let cleanupApp=()=>{}
 try{
 screenState('precise-app-before')
 const f=await launchFixture(path.resolve(import.meta.dir,'app.ts'),{...fixture.env,NAPI_RS_NATIVE_LIBRARY_PATH:path.resolve('native/build/gpuix-native.darwin-arm64.node'),KYBERN_CLIENT_CONFIG_DIR:client,KYBERN_GPUIX_CREDENTIALS_DIR:path.join(client,'credentials'),KYBERN_GPU_WHEEL:path.resolve('native/build/gpu-wheel.dylib'),KYBERN_GPU_PLAN:plan,KYBERN_GPU_CLIP_PRUNE:prune,KYBERN_GPU_LEGACY_EXPLORER:scene==='markdown-legacy'?'1':'0',KYBERN_GPU_TRACE:scene.startsWith('markdown')?'1':'0',KYBERN_FRAME_TIMES:'1',KYBERN_FRAME_COSTS:'1',KYBERN_FULL_RATE:'1',KYBERN_GPUIX_THREAD:'',KYBERN_APPEARANCE:'dark',KYBERN_REDUCED_MOTION:'0',GPUIX_BACKGROUND:'1',KYBERN_PACING_IGNORE_PHYSICAL_MOUSE:'1'},{stderr:t.stderr});launched=f;cleanupApp=onExit(async()=>{await f.close()})

   const a=f.app;await a.getByTestId('app-ready').waitFor()
   const port=await until(async()=>{try{return JSON.parse(readFileSync(path.join(client,'bench-control.json'),'utf8')).port as number}catch{return false}},'control port')
   const call=async(action:string,args:Record<string,unknown>={})=>{const r=await fetch(`http://127.0.0.1:${port}`,{method:'POST',body:JSON.stringify({action,...args})});assert.ok(r.ok,await r.clone().text());return r.json()}
   await until(async()=>{const s=await call('state');return s.listsLoaded},'lists')
   let point={x:180,y:430}
   if(scene.startsWith('markdown')){
    await call('open',{thread:fixture.manifest.long3000});await a.getByTestId('transcript-surface').waitFor();await call('explorer',{file:fixture.manifest.markdown});await a.getByTestId('dock-file-content').waitFor();await Bun.sleep(1000)
    const b=await a.getByTestId('right-dock').bounds();point={x:b.x+b.width-90,y:b.y+b.height/2}
   }else await call('home')
   await a.mouse.move(point)
   const drive=async(count:number)=>{rmSync(done,{force:true});writeFileSync(plan,JSON.stringify({...point,count,magnitude:scene==='sidebar'?35:10,done}));process.kill(f.pid,'SIGUSR1');await until(async()=>existsSync(done),'native wheel completion',count*1000/120+30000);return JSON.parse(readFileSync(done,'utf8')) as {offered:number[];durationMs:number;deliveredAtOfferEnd:number;handlerLatencies:number[]}}
   await drive(1200);await Bun.sleep(200)
   assert.ok(t.submissions.length>1,'Display/occlusion gate: warmup did not submit active content')
   const gate=watchRun(),mark=t.mark(),at=performance.now()
   const sampler=Bun.spawn(['bun','perf/sample.ts','15',`GPUIX=${f.pid}`],{stdout:'pipe',stderr:'pipe'})
   const cleanupSampler=onExit(async()=>{sampler.kill();await sampler.exited})
   let input,raw
   try{const text=new Response(sampler.stdout).text();input=await drive(1800);raw=await text;assert.equal(await sampler.exited,0)}finally{sampler.kill();await sampler.exited;cleanupSampler()}
   const m=t.result(mark),check=gate.finish();assert.ok(!check.overlap&&!check.orphanOverlap,'Measurement overlap');assert.ok(m.frames.count>0,'Discard active zero-submission window')
   const resources=parseResources(raw!)
   assert.ok(m.frames.count>=30&&resources.gpuMs>0,'Discard inactive/near-zero GPU window')
   const r={scene,prune,traceEnabled:scene.startsWith('markdown'),legacyExplorer:scene==='markdown-legacy',fullRate:'1',warmupSeconds:10,resourceSeconds:15,input:'120 Hz precise fractional CGFloat AppKit NSEvent; contact and momentum phases; background native producer',inputResult:input!,frames:m.frames,work:m.work,resources,gpuMsPerSubmission:resources.gpuMs/m.frames.count,cpuMsPerSubmission:resources.cpuPercent*resources.sampleSeconds*10/m.frames.count,elapsedMs:performance.now()-at,...check}
   results.push(r);writeFileSync(`${evidence}/${scene}-${prune}.log`,t.raw);writeFileSync(evidence+'/results.json',JSON.stringify(results,null,2));console.log(JSON.stringify({scene,prune,frames:r.frames,resources:r.resources,gpuMsPerSubmission:r.gpuMsPerSubmission,delivered:r.inputResult.deliveredAtOfferEnd}))
  }finally{try{await launched?.close();screenState('precise-app-after')}finally{cleanupApp();release()}}
 }
}finally{await fixture.close();fixture.remove()}
