import {renameSync,writeFileSync} from 'node:fs'
import path from 'node:path'
/** Complete paired acceptance batch; each fixture gets a bounded UI lease. */
for(const mode of ['timing','resources','active','visuals','profile','app-profile']){
 const child=Bun.spawn(['bun','perf/coldstart/paired.ts',mode,'baseline','candidate'],{env:{...process.env,KYBERN_COLDSTART_LABEL:''},stdout:'inherit',stderr:'inherit'})
 for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>child.kill(signal))
 if(await child.exited)throw Error(`${mode} failed`)
}

const smoke=Bun.spawn(['bun','perf/bench/run.ts','startup-cold','startup-warm','startup-packaged','--runs','1','--seconds','1','--warmup','0','--label','coldstart-milestones-smoke'],{env:{...process.env,KYBERN_FULL_RATE:'1',KYBERN_TEST_DAEMON:path.resolve('dist/coldstart-candidate.app/Contents/MacOS/kybernd'),KYBERN_BENCH_PACKAGED_EXECUTABLE:path.resolve('dist/coldstart-candidate.app/Contents/MacOS/Kybern GPUIX'),KYBERN_DATA_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-coldstart-bench',KYBERN_BENCH_PORT:'4336',KYBERN_BENCH_EVIDENCE:'/Users/mymac/projects/ade/previews/gpuix/perf/coldstart/bench-smoke'},stdout:'inherit',stderr:'inherit'})
for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>smoke.kill(signal))
const code=await smoke.exited
for(const ext of ['json','md'])renameSync(`perf/bench/results/coldstart-milestones-smoke.${ext}`,`/Users/mymac/projects/ade/previews/gpuix/perf/coldstart/bench-smoke.${ext}`)
if(code)throw Error('Benchmark startup milestone smoke failed')

for(const [label,args] of [
 ['summary',['bun','perf/coldstart/summary.ts']],
 ['pixels',['bun','perf/coldstart/pixels.ts']],
 ['bench-typecheck',['pnpm','exec','tsc','--noEmit','-p','perf/bench/tsconfig.json']],
 ['coldstart-typecheck',['pnpm','exec','tsc','--noEmit','-p','perf/coldstart/tsconfig.json']],
] as const){
 const child=Bun.spawn([...args],{stdout:'pipe',stderr:'pipe'})
 const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
 writeFileSync(`/Users/mymac/projects/ade/previews/gpuix/perf/coldstart/${label}.log`,stdout+'\n'+stderr)
 console.log(JSON.stringify({label,code,tail:(stdout+stderr).slice(-1500)}))
 if(code)throw Error(`${label} failed`)
}
