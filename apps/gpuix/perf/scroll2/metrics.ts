import {readFileSync,writeFileSync} from 'node:fs'
const out='/Users/mymac/projects/ade/previews/gpuix/perf/scroll2'
async function run(command:string[],extra:Record<string,string>={}){
 const child=Bun.spawn(command,{env:{...process.env,...extra},stdin:'inherit',stdout:'inherit',stderr:'inherit'})
 for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>child.kill(signal))
 if(await child.exited)throw Error(command.join(' ')+' failed')
}
await run(['bun','perf/scroll2/lease.ts','bun','perf/scroll2/pair.ts','3000'])
await run(['bun','perf/scroll2/lease.ts','bun','perf/scroll2/pair.ts','30000'],{SCROLL2_SYNTHETIC:'1'})
for(const sparse of ['0','1']){
 const variant=sparse==='1'?'sparse':'dense'
 await run(['bun','perf/bench/run.ts','sidebar-scroll','older-history','idle-thread','--runs','2','--label','scroll2-'+variant],{
  KYBERN_SPARSE_LIST:sparse,KYBERN_MOTION_SYNC:sparse,KYBERN_BENCH_PORT:'4331',KYBERN_DATA_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-scroll2/bench',KYBERN_BENCH_EVIDENCE:out+'/bench-'+variant,KYBERN_BENCH_COUNTERS:'1',KYBERN_FULL_RATE:'1',
 })
 const document=JSON.parse(readFileSync(import.meta.dir+'/../bench/results/scroll2-'+variant+'.json','utf8'));document.scroll2={sparse,motionSync:sparse,sidebarBuffer:'768'};writeFileSync(out+'/bench-'+variant+'.json',JSON.stringify(document,null,2))
}
for(const [variant,sparse] of [['dense','0'],['sparse','1']])for(const fast of [false,true]){
 await run(['bun','perf/scroll2/lease.ts','bun','perf/scroll2/fixture.ts','bun','perf/scroll2/sidebar.ts',variant+(fast?'-fast':'-settled')],{KYBERN_SPARSE_LIST:sparse!,KYBERN_MOTION_SYNC:sparse!,SIDEBAR_MAGNITUDE:fast?'30':'10',SIDEBAR_SCENE:'settled',SIDEBAR_WARM_PACKETS:'1200',SIDEBAR_WARM_MS:'0',SIDEBAR_HOME:'1'})
}
export {}

// Inclusive native profiles perturb scheduling and stay separate from A/B data.
for(const sparse of ['0','1'])await run(['bun','perf/scroll2/lease.ts','bun','perf/scroll2/transcript.ts','diagnostic-'+(sparse==='1'?'sparse':'dense'),'3000'],{KYBERN_SPARSE_LIST:sparse,KYBERN_MOTION_SYNC:sparse,SCROLL2_PROFILE:'1',TRANSCRIPT_INPUT:'appkit',TRANSCRIPT_MATCHED:'1',TRANSCRIPT_SCENES:'scroll'})
