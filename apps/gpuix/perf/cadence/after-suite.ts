import path from 'node:path'
import {onExit} from '../bench/lifetime.ts'
const app=path.resolve(import.meta.dir,'../..')
async function run(args:string[],env:Record<string,string>){const child=Bun.spawn(args,{cwd:app,env:{...process.env,...env},stdout:'inherit',stderr:'inherit'});const stop=onExit(async()=>{child.kill();await child.exited});const code=await child.exited;stop();if(code)throw Error(`${args.join(' ')} exited ${code}`)}
const env={KYBERN_DATA_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-cadence-bench',KYBERN_CLIENT_CONFIG_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-cadence-bench/client',KYBERN_BENCH_PORT:'4334',KYBERN_BENCH_EVIDENCE:'/Users/mymac/projects/ade/previews/gpuix/perf/cadence',KYBERN_FULL_RATE:'1'}
for(const [label,integer,direct] of [['cadence-route-integer-probe','1','0'],['cadence-route-fractional-probe','0','0'],['cadence-direct-probe','0','1']]) {
 await run(['bun','perf/bench/run.ts','thread-scroll','--runs','1','--seconds','5','--warmup','2','--label',label!,'--keep-data'],{...env,KYBERN_BENCH_INTEGER_WHEEL:integer!,KYBERN_BENCH_DIRECT_VIEW:direct!,CADENCE_VISIBILITY_CONTROL:'1'})
}
const {readFileSync}=await import('node:fs')
const probe=JSON.parse(readFileSync(path.join(app,'perf/bench/results/cadence-direct-probe.json'),'utf8')).results[0]
if(probe.status!=='ok'||probe.frames.count<250||probe.frames.p99>80)throw Error('Direct fractional NSEvent probe still has a cadence defect; investigate before measuring controls')
// One original sidebar repeat overlapped our own short TypeScript check. Keep
// its raw row, explicitly exclude it, and supply a clean replacement here.
await run(['bun','perf/bench/run.ts','sidebar-scroll','--runs','1','--label','cadence-before-integer-sidebar-replacement','--keep-data'],{...env,KYBERN_BENCH_INTEGER_WHEEL:'1',KYBERN_BENCH_DIRECT_VIEW:'0',CADENCE_VISIBILITY_CONTROL:'1'})
await run(['bun','perf/cadence/bench-pair.ts'],{...env,CADENCE_SOURCE:'before',CADENCE_INTEGER:'skip',KYBERN_BENCH_DIRECT_VIEW:'1'})
await run(['bun','perf/cadence/bench-pair.ts'],{...env,CADENCE_SOURCE:'after',CADENCE_INTEGER:'skip',KYBERN_BENCH_DIRECT_VIEW:'1'})
