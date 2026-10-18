/** Same sparse window: isolate the global motion pass. Profiles are separate. */
async function run(label:string,motion:string,profile=false){
 const child=Bun.spawn(['bun','perf/scroll2/lease.ts','bun','perf/scroll2/fixture.ts','bun','perf/scroll2/sidebar.ts',label],{env:{...process.env,KYBERN_SPARSE_LIST:'1',KYBERN_MOTION_SYNC:motion,KYBERN_SIDEBAR_ROW_OBSERVERS:'1',KYBERN_SIDEBAR_BUFFER:'768',SIDEBAR_PROFILE:profile?'1':'0',SIDEBAR_MAGNITUDE:'30',SIDEBAR_SCENE:'settled',SIDEBAR_WARM_PACKETS:'1200',SIDEBAR_WARM_MS:'0',SIDEBAR_HOME:'1'},stdin:'inherit',stdout:'inherit',stderr:'inherit'})
 for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>child.kill(signal))
 if(await child.exited)throw Error(label+' failed')
}
for(const motion of ['0','1'])await run('sparse-motion'+motion+'-fast',motion)
for(const motion of ['0','1'])await run('sparse-motion'+motion+'-diagnostic-fast',motion,true)
export {}

for(const observers of ['1','0']){
 const child=Bun.spawn(['bun','perf/scroll2/lease.ts','bun','perf/scroll2/fixture.ts','bun','perf/scroll2/sidebar.ts','sparse-observers'+observers+'-fast'],{env:{...process.env,KYBERN_SPARSE_LIST:'1',KYBERN_MOTION_SYNC:'1',KYBERN_SIDEBAR_ROW_OBSERVERS:observers,KYBERN_SIDEBAR_BUFFER:'768',SIDEBAR_PROFILE:'0',SIDEBAR_MAGNITUDE:'30',SIDEBAR_SCENE:'settled',SIDEBAR_WARM_PACKETS:'1200',SIDEBAR_WARM_MS:'0',SIDEBAR_HOME:'1'},stdin:'inherit',stdout:'inherit',stderr:'inherit'})
 for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>child.kill(signal))
 if(await child.exited)throw Error('observer control failed')
}
