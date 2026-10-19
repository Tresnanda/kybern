// Run beneath quiet.ts. Same addon, kernel flag only, complete realistic fixture.
import {readFileSync,writeFileSync,copyFileSync} from 'node:fs'
import {onExit} from '../bench/lifetime.ts'
import type {Result} from '../bench/model.ts'
const phase=process.argv[2]??'acceptance'
for(const control of (phase==='diagnosis'?['0','1']:phase==='reverse'?['1','0']:['old','0','1'])) {
 const diagnostic=phase==='diagnosis'
 const label=phase==='reverse'?`backdrop-stream-reverse-${control==='0'?'control':'after'}`:control==='old'?'backdrop-before':`backdrop-${diagnostic?'diagnostic-':''}${control==='0'?'control':'after'}`
 const child=Bun.spawn(['bun','perf/bench/run.ts',...((diagnostic||phase==='reverse')?['streaming']:['streaming','thread-scroll','sidebar-scroll','explorer-scroll','idle-home']),'--runs',diagnostic?'1':'3',...(diagnostic?['--seconds','5']:[]),'--label',label],{env:{...process.env,KYBERN_DATA_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-backdrop-bench',KYBERN_CLIENT_CONFIG_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-backdrop-bench/client',KYBERN_BENCH_PORT:'4337',KYBERN_FULL_RATE:'1',KYBERN_BENCH_RPC_ONLY:'1',KYBERN_MEMORY_COUNTERS:'1',KYBERN_BENCH_COUNTERS:'1',KYBERN_BENCH_STREAM_CATCHUP:'1',NAPI_RS_NATIVE_LIBRARY_PATH:new URL(control==='old'?'../../native/build/backdrop-before.node':'../../native/build/gpuix-native.darwin-arm64.node',import.meta.url).pathname,KYBERN_BACKDROP_KERNEL:control==='old'?'0':control,KYBERN_GPU_TRACE:diagnostic?'1':'0',KYBERN_BENCH_EVIDENCE:'/Users/mymac/projects/ade/previews/gpuix/perf/backdrop'},stdout:'inherit',stderr:'inherit'})
 const unregister=onExit(async()=>{child.kill();await child.exited})
 const code=await child.exited;unregister();if(code)throw Error(`${label} failed`)
 const file=`perf/bench/results/${label}.json`,doc=JSON.parse(readFileSync(file,'utf8'))
 if(doc.aborted||doc.results.some((r:Result)=>r.status!=='ok'||(r.scenario!=='idle-home'&&(r.frames.count<30||(r.resources.gpuMs==null||r.resources.gpuMs<=0)))))throw Error('Invalid active window')
 doc.backdropKernel=control;writeFileSync(file,JSON.stringify(doc,null,2));copyFileSync(file,`/Users/mymac/projects/ade/previews/gpuix/perf/backdrop/${label}.json`)
}
