/** Isolate disposal notifications, then compare sidebar buffer choices. */
async function run(args:string[],extra:Record<string,string>={}){
 const child=Bun.spawn(args,{env:{...process.env,...extra},stdin:'inherit',stdout:'inherit',stderr:'inherit'})
 for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>child.kill(signal))
 if(await child.exited)throw Error(args.join(' ')+' failed')
}
await run(['pnpm','typecheck']);await run(['pnpm','exec','tsc','-p','perf/scroll2/tsconfig.json']);await run(['bun','test','./src'])
for(const [label,sparse,buffer,fast] of [
 ['dense-retention-settled','0','768',false],['dense-retention-fast','0','768',true],
 ['sparse-retention-settled','1','768',false],['sparse-retention-fast','1','768',true],
 ['sparse-buffer1152-fast','1','1152',true],['sparse-buffer1536-fast','1','1536',true],
] as const)await run(['bun','perf/scroll2/lease.ts','bun','perf/scroll2/fixture.ts','bun','perf/scroll2/sidebar.ts',label],{KYBERN_SPARSE_LIST:sparse,KYBERN_MOTION_SYNC:'0',KYBERN_SIDEBAR_ROW_OBSERVERS:'1',KYBERN_SIDEBAR_BUFFER:buffer,SIDEBAR_MAGNITUDE:fast?'30':'10',SIDEBAR_SCENE:'settled',SIDEBAR_WARM_PACKETS:'1200',SIDEBAR_WARM_MS:'0',SIDEBAR_HOME:'1'})
for(const sparse of ['0','1'])await run(['bun','perf/scroll2/lease.ts','bun','perf/scroll2/fixture.ts','bun','perf/scroll2/sidebar.ts',(sparse==='1'?'sparse':'dense')+'-diagnostic-fast'],{KYBERN_SPARSE_LIST:sparse,KYBERN_MOTION_SYNC:'0',KYBERN_SIDEBAR_ROW_OBSERVERS:'1',KYBERN_SIDEBAR_BUFFER:'768',SIDEBAR_PROFILE:'1',SIDEBAR_MAGNITUDE:'30',SIDEBAR_SCENE:'settled',SIDEBAR_WARM_PACKETS:'1200',SIDEBAR_WARM_MS:'0',SIDEBAR_HOME:'1'})
export {}
