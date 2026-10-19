// Capture-free, same-addon scheduling A/B. The bench owns bounded UI leases.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
const out='/Users/mymac/projects/ade/previews/gpuix/perf/flick'
for(const flag of process.env.FLICK_DEFAULT_PAIR==='1'?['0','default']:['0','1']){
 const label=(process.env.FLICK_PAIR_LABEL??'frame-pair')+'-'+flag
 const flags={...process.env,KYBERN_INPUT_FRAME_DRAW:flag} as Record<string,string|undefined>
 if(flag==='default')delete flags.KYBERN_INPUT_FRAME_DRAW
 const child=Bun.spawn(['bun','perf/bench/run.ts','thread-fling','sidebar-scroll','explorer-scroll','markdown-scroll','code-scroll','older-history','idle-thread','--runs','3','--label',label,'--keep-data'],{env:{...flags,KYBERN_DATA_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-flick-bench',KYBERN_CLIENT_CONFIG_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-flick-bench/client',KYBERN_BENCH_PORT:'4339',KYBERN_BENCH_EVIDENCE:out,KYBERN_FULL_RATE:'1',KYBERN_BENCH_HISTORY_TURNS:'3000',KYBERN_BENCH_COUNTERS:'1'},stdin:'inherit',stdout:'inherit',stderr:'inherit'})
 for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>child.kill(signal))
 const code=await child.exited;if(code)process.exit(code)
 mkdirSync(out,{recursive:true});writeFileSync(`${out}/${label}.json`,readFileSync(`${import.meta.dir}/../bench/results/${label}.json`))
}
