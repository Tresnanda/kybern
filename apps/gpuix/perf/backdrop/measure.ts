// Run beneath quiet.ts. Same addon, kernel flag only, complete realistic fixture.
import {readFileSync,writeFileSync,copyFileSync} from 'node:fs'
import {onExit} from '../bench/lifetime.ts'
import type {Result} from '../bench/model.ts'
const phase=process.argv[2]??'acceptance'
for(const control of (phase==='original-reverse'?['1','old']:phase==='reverse'?['1','0']:['old','0','1'])) {
 const diagnostic=phase==='diagnosis'
 const label=phase==='original-reverse'?`backdrop-original-reverse-${control==='old'?'before':'after'}`:phase==='idle'?`backdrop-idle-${control==='old'?'before':control==='0'?'control':'after'}`:phase==='reverse'?`backdrop-stream-reverse-${control==='0'?'control':'after'}`:control==='old'?`backdrop-${diagnostic?'diagnostic-':''}before`:`backdrop-${diagnostic?'diagnostic-':''}${control==='0'?'control':'after'}`
 const child=Bun.spawn(['bun','perf/bench/run.ts',...(phase==='idle'?['idle-home']:phase==='original-reverse'?['streaming','thread-scroll']:phase==='reverse'?['streaming']:diagnostic?['streaming','thread-scroll','sidebar-scroll','explorer-scroll']:['streaming','thread-scroll','sidebar-scroll','explorer-scroll']),'--runs',diagnostic?'1':'3',...(diagnostic?['--seconds','5']:phase==='idle'?['--warmup','20']:[]),'--label',label],{env:{...process.env,KYBERN_DATA_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-backdrop-bench',KYBERN_CLIENT_CONFIG_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-backdrop-bench/client',KYBERN_BENCH_PORT:'4337',KYBERN_WINDOW_GUARD:new URL('../../native/build/backdrop-window-guard',import.meta.url).pathname,KYBERN_FULL_RATE:'1',KYBERN_BENCH_RPC_ONLY:'1',KYBERN_MEMORY_COUNTERS:'1',KYBERN_BENCH_COUNTERS:phase==='idle'?'0':'1',KYBERN_BENCH_PERSISTED_IDLE:phase==='idle'?'1':'0',KYBERN_BENCH_STREAM_CATCHUP:'1',NAPI_RS_NATIVE_LIBRARY_PATH:new URL(control==='old'?'../../native/build/backdrop-before.node':'../../native/build/gpuix-native.darwin-arm64.node',import.meta.url).pathname,KYBERN_BACKDROP_KERNEL:control==='old'?'0':control,KYBERN_GPU_TRACE:diagnostic?'1':'0',KYBERN_BENCH_EVIDENCE:'/Users/mymac/projects/ade/previews/gpuix/perf/backdrop'},stdout:'inherit',stderr:'inherit'})
 const unregister=onExit(async()=>{child.kill();await child.exited})
 const code=await child.exited;unregister();if(code)throw Error(`${label} failed`)
 const file=`perf/bench/results/${label}.json`,doc=JSON.parse(readFileSync(file,'utf8'))
 const accepted:Result[]=doc.results.filter((r:Result)=>r.status==='ok')
 const expectedRuns=diagnostic?1:3,expectedScenarios=phase==='idle'||phase==='reverse'?1:phase==='original-reverse'?2:4
 if(doc.aborted||doc.results.some((r:Result)=>r.status==='failed')||accepted.length!==expectedRuns*expectedScenarios||accepted.some(r=>r.scenario!=='idle-home'&&(r.frames.count<30||(r.resources.gpuMs==null||r.resources.gpuMs<=0))))throw Error('Invalid active window')
 if(phase==='idle'&&accepted.some(r=>r.frames.count!==0||r.resources.gpuMs!==0))throw Error('Settled idle must have zero submissions and GPU work')
 doc.backdropKernel=control;writeFileSync(file,JSON.stringify(doc,null,2));copyFileSync(file,`/Users/mymac/projects/ade/previews/gpuix/perf/backdrop/${label}.json`)
}
