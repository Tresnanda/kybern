// Interleaved repeats investigate the first code-preview GPU increase.
import {readFileSync,writeFileSync} from 'node:fs'
for(const [index,flag] of ['0','1','1','0'].entries()){
 const label=`code-abba-${index}-${flag}`
 const child=Bun.spawn(['bun','perf/bench/run.ts','code-scroll','--runs','1','--label',label,'--keep-data'],{env:{...process.env,KYBERN_DATA_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-flick-bench',KYBERN_CLIENT_CONFIG_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-flick-bench/client',KYBERN_BENCH_PORT:'4339',KYBERN_BENCH_EVIDENCE:'/Users/mymac/projects/ade/previews/gpuix/perf/flick',KYBERN_FULL_RATE:'1',KYBERN_INPUT_FRAME_DRAW:flag},stdin:'inherit',stdout:'inherit',stderr:'inherit'})
 for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>child.kill(signal))
 const code=await child.exited;if(code)process.exit(code)
 writeFileSync(`/Users/mymac/projects/ade/previews/gpuix/perf/flick/${label}.json`,readFileSync(`${import.meta.dir}/../bench/results/${label}.json`))
}
