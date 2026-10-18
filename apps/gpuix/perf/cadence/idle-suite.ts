import { onExit } from '../bench/lifetime.ts'
import { readFileSync } from 'node:fs'
async function run(args:string[],env:Record<string,string>={}){
 const child=Bun.spawn(args,{env:{...process.env,...env},stdout:'inherit',stderr:'inherit'})
 const stop=onExit(()=>child.kill());const code=await child.exited;stop();if(code)throw Error(`${args.join(' ')} failed ${code}`)
}
await run(['bun','perf/cadence/checks.ts'],{CADENCE_SOURCE_CHECKS_ONLY:'1'})
await run(['bun','perf/bench/run.ts','idle-home','--runs','3','--warmup','20','--label','cadence-after-idle-limits-3','--keep-data'],{
 KYBERN_DATA_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-cadence-bench',KYBERN_CLIENT_CONFIG_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-cadence-bench/client',KYBERN_BENCH_PORT:'4334',KYBERN_BENCH_EVIDENCE:'/Users/mymac/projects/ade/previews/gpuix/perf/cadence',KYBERN_FULL_RATE:'1',CADENCE_VISIBILITY_CONTROL:'0',
})
const result=JSON.parse(readFileSync('perf/bench/results/cadence-after-idle-limits-3.json','utf8'))
if(result.aborted||result.results.length!==3||result.results.some((r:any)=>r.status!=='ok'||r.frames.count!==0||r.work.reactCommits!==0||r.resources.gpuMs!==0))throw Error('Minute-boundary idle is not free; investigate before cleanup')
await run(['python3','perf/cadence/report.py'])
await run(['python3','perf/cadence/cleanup.py'])
