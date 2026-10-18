import assert from 'node:assert/strict'
import path from 'node:path'
import {mkdirSync,writeFileSync} from 'node:fs'
import {launchFixture} from '../../src/requests/harness.ts'
import {lease} from '../bench/lease.ts'
import {onExit} from '../bench/lifetime.ts'
import {Telemetry,parseResources} from '../bench/telemetry.ts'
import {drive} from '../bench/input.ts'
import {watchRun} from '../bench/process-gate.ts'
import {requireActiveSample,requireScreen} from '../bench/screen-state.ts'
const out='/Users/mymac/projects/ade/previews/gpuix/perf/backdrop/surface'
mkdirSync(out,{recursive:true});const release=await lease(),results:unknown[]=[]
try{for(const kernel of ['0','1']){
 requireScreen();const telemetry=new Telemetry()
 const f=await launchFixture(path.resolve(import.meta.dir,'surface-entry.ts'),{KYBERN_DATA_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-backdrop-surface',KYBERN_CLIENT_CONFIG_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-backdrop-surface/client',KYBERN_URL:'',KYBERN_TOKEN:'',KYBERN_APPEARANCE:'dark',KYBERN_BACKDROP_KERNEL:kernel,KYBERN_FULL_RATE:'1',KYBERN_FRAME_TIMES:'1',KYBERN_FRAME_COSTS:'1',GPUIX_BACKGROUND:'1'}, {stderr:telemetry.stderr})
 const unfixture=onExit(()=>f.close())
 try{
  await f.app.getByTestId('glass').waitFor();await drive(f.app,{x:100,y:470},10000)
  for(let run=1;run<=4;run++){
   const idle=run===4;if(idle)await Bun.sleep(1000)
   const watch=watchRun(),mark=telemetry.mark()
   const sampler=Bun.spawn(['bun','perf/sample.ts','15',`GPUIX=${f.pid}`],{stdout:'pipe',stderr:'pipe'})
   const unsampler=onExit(async()=>{sampler.kill();await sampler.exited})
   const output=new Response(sampler.stdout).text(),error=new Response(sampler.stderr).text()
   const input=idle?undefined:await drive(f.app,{x:100,y:470},15000)
   if(idle)await Bun.sleep(15000)
   const measured=telemetry.result(mark,input?.sent),text=await output,errors=await error
   assert.equal(await sampler.exited,0,errors);unsampler();const resources=parseResources(text),gate=watch.finish()
   assert.ok(!gate.overlap&&!gate.orphanOverlap&&!gate.screenInvalid,'Invalid measurement window')
   if(!idle)requireActiveSample(measured.frames.count,resources.gpuMs,15)
   else assert.equal(measured.frames.count,0,'Static frosted surface must park')
   results.push({kernel,run,idle,fullRate:'1',deviceSigma:32,logicalBlur:16,frames:measured.frames,proxy:measured.proxy,resources,gpuMsPerSubmission:measured.frames.count?resources.gpuMs/measured.frames.count:null,cpuMsPerSubmission:measured.frames.count?resources.cpuPercent*resources.sampleSeconds*10/measured.frames.count:null,inputPackets:input?.sent.length??0,maxOutstanding:input?.maxOutstanding??0,gate})
   writeFileSync(out+'/results.json',JSON.stringify(results,null,2));writeFileSync(`${out}/${kernel}-${run}-resources.txt`,text)
  }
 }finally{await f.close();unfixture();requireScreen();writeFileSync(`${out}/${kernel}.log`,telemetry.raw)}
}}finally{release()}
