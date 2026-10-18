import {onExit} from '../bench/lifetime.ts'
// Diagnostic isolation: the same source/theme/width on the pre-document addon,
// legacy Markdown on this addon, and canonical documents on this addon.
import assert from 'node:assert/strict'
import {mkdirSync,writeFileSync,existsSync} from 'node:fs'
import path from 'node:path'
import {launchFixture} from '../../src/requests/harness.ts'
import {Telemetry,parseResources} from '../bench/telemetry.ts'
import {drive} from '../bench/input.ts'
import {lease} from '../bench/lease.ts'
import {watchRun} from '../bench/process-gate.ts'
import {screenState} from '../bench/screen-state.ts'
process.env.KYBERN_BENCH_SCREEN_STATE_SCRIPT??='/Users/mymac/projects/ade-gpuix-scratch/screen-state.swift'
if(existsSync('native/build/gpu-final-pending'))throw Error('Complete native updater has not passed')
const out='/Users/mymac/projects/ade/previews/gpuix/perf/gpu/markdown-cost';mkdirSync(out,{recursive:true})
const data='/Users/mymac/projects/ade-gpuix-scratch/perf-gpu-raw';mkdirSync(data,{recursive:true})
const results=[]
for(const [label,document,addon,prune] of [
 ['premarkdown','0','/Users/mymac/projects/ade-gpuix/apps/gpuix/native/build/transcript-1004fcab.node','0'],
 ['legacy-current','0',path.resolve('native/build/gpuix-native.darwin-arm64.node'),'0'],
 ['document-current','1',path.resolve('native/build/gpuix-native.darwin-arm64.node'),'0'],
 ['document-pruned','1',path.resolve('native/build/gpuix-native.darwin-arm64.node'),'1'],
] as const){
 const release=await lease(),t=new Telemetry()
 let launched:Awaited<ReturnType<typeof launchFixture>>|undefined;let cleanupApp=()=>{}
 try{
 screenState('markdown-app-before')
 const f=await launchFixture(path.resolve('native/markdown-document-lab.tsx'),{KYBERN_DATA_DIR:data,KYBERN_CLIENT_CONFIG_DIR:data+'/client',KYBERN_URL:'',KYBERN_TOKEN:'',KYBERN_FULL_RATE:'1',KYBERN_FRAME_TIMES:'1',KYBERN_FRAME_COSTS:'1',KYBERN_GPU_TRACE:'1',KYBERN_GPU_CLIP_PRUNE:prune,KYBERN_APPEARANCE:'dark',GPUIX_BACKGROUND:'1',NAPI_RS_NATIVE_LIBRARY_PATH:addon,MD_DOCUMENT:document,MD_DOC_SOURCE:'/Users/mymac/projects/ade-gpuix-scratch/perf-gpu-bench/projects/project-00/long.md'},{stderr:t.stderr});launched=f;cleanupApp=onExit(async()=>{await f.close()})

  await f.app.getByTestId('ready').waitFor();for(let attempts=0;;attempts++){if((await f.app.call('getPaintedText',{})).text.join('\n').includes('Result 1'))break;if(attempts>3000)throw Error('Missing formatted Markdown');await Bun.sleep(20)}
  await drive(f.app,{x:300,y:350},10000)
  const g=watchRun(),mark=t.mark()
  const sampler=Bun.spawn(['bun','perf/sample.ts','15',`GPUIX=${f.pid}`],{stdout:'pipe',stderr:'pipe'})
  const cleanupSampler=onExit(async()=>{sampler.kill();await sampler.exited})
  const sampled=new Response(sampler.stdout).text()
  let input,raw
  try{input=await drive(f.app,{x:300,y:350},15000);raw=await sampled;assert.equal(await sampler.exited,0)}finally{sampler.kill();await sampler.exited;cleanupSampler()}
  const gate=g.finish();assert.ok(!gate.overlap&&!gate.orphanOverlap,'Measurement overlap')
  const m=t.result(mark,input.sent),resources=parseResources(raw)
  assert.ok(m.frames.count>=30&&resources.gpuMs>0,'Discard inactive/near-zero GPU window')
  const result={label,addon,document,prune,fullRate:'1',diagnostic:true,traceEnabled:true,frames:m.frames,work:m.work,resources,gpuMsPerSubmission:resources.gpuMs/m.frames.count,inputPackets:input.sent.length,...gate}
  results.push(result);writeFileSync(`${out}/${label}.log`,t.raw);writeFileSync(out+'/results.json',JSON.stringify(results,null,2));console.log(JSON.stringify(result))
 }finally{try{await launched?.close();screenState('markdown-app-after')}finally{cleanupApp();release()}}
}
