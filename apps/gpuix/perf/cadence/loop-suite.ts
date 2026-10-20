import {onExit} from '../bench/lifetime.ts'
import {statfsSync,writeFileSync} from 'node:fs'
const volume=statfsSync('.'),freeGiB=Number(volume.bavail)*Number(volume.bsize)/1024**3
writeFileSync('/Users/mymac/projects/ade/previews/gpuix/perf/cadence/diagnostics/pre-loop-disk.json',JSON.stringify({freeGiB,at:new Date().toISOString()},null,2))
if(freeGiB<30)throw Error('Disk budget below 30 GiB before artifact compilation')
const strips=Bun.spawn(['swift','-module-cache-path','/Users/mymac/projects/ade-gpuix-scratch/perf-cadence-swift-cache','perf/cadence/strips.swift'],{stdout:'inherit',stderr:'inherit'});if(await strips.exited)throw Error('Frame-strip assembly failed')
await import('./checks.ts')
await import('./smoke.ts')
for(const env of [
 {CADENCE_SOURCE:'before'},
 {CADENCE_SOURCE:'after'},
 {CADENCE_SOURCE:'after',CADENCE_NATIVE:'1',CADENCE_LOOPS:'matrix,connection,task,shimmer'},
 {CADENCE_SOURCE:'before',CADENCE_NATIVE:'1',CADENCE_LOOPS:'connection'},
]){
 const child=Bun.spawn(['bun','perf/cadence/loops.ts'],{env:{...process.env,...env},stdout:'inherit',stderr:'inherit'})
 const stop=onExit(async()=>{child.kill();await Promise.race([child.exited,Bun.sleep(2000)])})
 const code=await child.exited;stop();if(code)throw Error(`Loop controls failed: ${code}`)
}

const idle=Bun.spawn(['bun','perf/bench/run.ts','idle-home','--runs','3','--warmup','20','--label','cadence-after-idle-settled20-3','--keep-data'],{env:{...process.env,KYBERN_DATA_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-cadence-bench',KYBERN_CLIENT_CONFIG_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-cadence-bench/client',KYBERN_BENCH_PORT:'4334',KYBERN_BENCH_EVIDENCE:'/Users/mymac/projects/ade/previews/gpuix/perf/cadence',KYBERN_FULL_RATE:'1',CADENCE_VISIBILITY_CONTROL:'0'},stdout:'inherit',stderr:'inherit'})
const stopIdle=onExit(()=>idle.kill());const idleCode=await idle.exited;stopIdle();if(idleCode)throw Error(`Settled idle failed ${idleCode}`)
