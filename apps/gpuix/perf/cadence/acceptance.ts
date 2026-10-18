import {onExit} from '../bench/lifetime.ts'
async function run(args:string[],env:Record<string,string>={}){
 const child=Bun.spawn(args,{env:{...process.env,...env},stdout:'inherit',stderr:'inherit'})
 const stop=onExit(async()=>{child.kill();await Promise.race([child.exited,Bun.sleep(2000)])})
 const code=await child.exited;stop();if(code)throw Error(`${args.join(' ')} failed ${code}`)
}
await run(['bun','perf/bench/run.ts','thread-scroll','--runs','1','--seconds','5','--warmup','2','--label','cadence-direct-integer-probe','--keep-data'],{
 KYBERN_DATA_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-cadence-bench',KYBERN_CLIENT_CONFIG_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-cadence-bench/client',KYBERN_BENCH_PORT:'4334',KYBERN_BENCH_EVIDENCE:'/Users/mymac/projects/ade/previews/gpuix/perf/cadence',KYBERN_FULL_RATE:'1',KYBERN_BENCH_INTEGER_WHEEL:'1',KYBERN_BENCH_DIRECT_VIEW:'1',CADENCE_VISIBILITY_CONTROL:'1',
})
for(const source of ['before','after'])await run(['bun','perf/cadence/original-harnesses.ts'],{CADENCE_SOURCE:source})
await run(['bun','perf/bench/run.ts','open-long','older-history','idle-home','idle-thread','--runs','3','--label','cadence-after-settled-3','--keep-data'],{
 KYBERN_DATA_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-cadence-bench',KYBERN_CLIENT_CONFIG_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-cadence-bench/client',KYBERN_BENCH_PORT:'4334',KYBERN_BENCH_EVIDENCE:'/Users/mymac/projects/ade/previews/gpuix/perf/cadence',KYBERN_FULL_RATE:'1',KYBERN_BENCH_NO_RUNNING:'1',KYBERN_BENCH_DIRECT_VIEW:'1',KYBERN_BENCH_INTEGER_WHEEL:'0',CADENCE_VISIBILITY_CONTROL:'0',
})
for(const source of ['before','after'])for(const theme of ['dark','light'])for(const reduced of ['0','1']){
 await run(['bun','perf/cadence/loops.ts'],{CADENCE_SOURCE:source,CADENCE_VISUAL:'1',KYBERN_APPEARANCE:theme,KYBERN_REDUCED_MOTION:reduced,CADENCE_LOOPS:'matrix,spin,connection,task,shimmer,skeleton,visual,elapsed,caret'})
}
// Before/after continuous connection controls are also checked in every mode.
for(const source of ['before','after'])for(const theme of ['dark','light'])for(const reduced of ['0','1'])await run(['bun','perf/cadence/loops.ts'],{CADENCE_SOURCE:source,CADENCE_VISUAL:'1',CADENCE_NATIVE:'1',KYBERN_APPEARANCE:theme,KYBERN_REDUCED_MOTION:reduced,CADENCE_LOOPS:'matrix,connection,task,shimmer'})
for(const source of ['before','after'])for(const theme of ['dark','light'])await run(['bun','perf/cadence/original-harnesses.ts'],{CADENCE_SOURCE:source,KYBERN_APPEARANCE:theme,SIDEBAR_VISUAL:'1',EXPLORER_VISUAL:'1'})
