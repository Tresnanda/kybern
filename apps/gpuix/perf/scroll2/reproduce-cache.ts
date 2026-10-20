/** Correctness diagnostic: no resource/timing acceptance claims. */
import {readFileSync,writeFileSync} from 'node:fs'
const out='/Users/mymac/projects/ade/previews/gpuix/perf/scroll2'
for(const sparse of ['0','1']){
 const label='scroll2-cache-repro-'+(process.env.SCROLL2_CACHE_FIXED==='1'?'fixed-':'')+sparse
 const child=Bun.spawn(['bun','perf/bench/run.ts','older-history','--runs','4','--seconds','1','--warmup','0','--label',label],{env:{...process.env,RUST_BACKTRACE:'1',KYBERN_SPARSE_LIST:sparse,KYBERN_MOTION_SYNC:sparse,KYBERN_BENCH_PORT:'4331',KYBERN_DATA_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-scroll2/cache-repro',KYBERN_BENCH_EVIDENCE:out+'/cache-repro',KYBERN_FULL_RATE:'1'},stdin:'inherit',stdout:'inherit',stderr:'inherit'})
 for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>child.kill(signal))
 const code=await child.exited
 writeFileSync(out+'/'+label+'.json',readFileSync(import.meta.dir+'/../bench/results/'+label+'.json'))
 console.log('Diagnostic exit',sparse,code)
 if(code&&process.env.SCROLL2_CACHE_FIXED==='1')throw Error('Cached view correctness retry failed')
}
export {}
