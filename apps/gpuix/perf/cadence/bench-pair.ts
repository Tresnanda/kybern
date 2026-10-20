// Same addon / full product; injector control first, then exact fractional input.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const app=path.resolve(import.meta.dir,'../..')
if(process.env.CADENCE_VALIDATE==='1') {
 for(const command of [['pnpm','typecheck'],['pnpm','exec','tsc','-p','native/tsconfig.json'],['pnpm','exec','tsc','-p','perf/cadence/tsconfig.json'],['bun','test','./src'],['bun','test','perf/bench/model.test.ts']]) {
  const test=Bun.spawn(command,{cwd:app,stdout:'inherit',stderr:'inherit'})
  const code=await test.exited;if(code)process.exit(code)
 }
}
const oldSource=process.env.CADENCE_SOURCE==='before'
const scenarios=process.env.CADENCE_SCENARIOS?.split(',')??['thread-scroll','thread-fling','sidebar-scroll','explorer-scroll','markdown-scroll','code-scroll','open-long','older-history']
for(const integer of (process.env.CADENCE_INTEGER==='only'?[true]:process.env.CADENCE_INTEGER==='both'?[true,false]:[false])) {
 const label=`cadence-${oldSource?'before':'after'}-${process.env.KYBERN_BENCH_DIRECT_VIEW!=='0'?(integer?'direct-integer':'direct'):integer?'integer':'fractional'}-3`
 const child=Bun.spawn(['bun','perf/bench/run.ts',...scenarios,'--runs','3','--label',label,'--keep-data'],{cwd:app,env:{...process.env,KYBERN_DATA_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-cadence-bench',KYBERN_CLIENT_CONFIG_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-cadence-bench/client',KYBERN_BENCH_PORT:'4334',KYBERN_BENCH_EVIDENCE:'/Users/mymac/projects/ade/previews/gpuix/perf/cadence',KYBERN_FULL_RATE:'1',KYBERN_BENCH_INTEGER_WHEEL:integer?'1':'0',CADENCE_VISIBILITY_CONTROL:oldSource?'1':'0'},stdout:'inherit',stderr:'inherit'})
 for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>child.kill(signal))
 const code=await child.exited;if(code)process.exit(code)
}
