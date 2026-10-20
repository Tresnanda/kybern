/** Settled paired geometry, with bottom normalized after measurement. */
for(const theme of ['dark','light'])for(const sparse of ['0','1']){
 const child=Bun.spawn(['bun',import.meta.dir+'/lease.ts','bun',import.meta.dir+'/sidebar.ts',(sparse==='1'?'sparse':'dense')+'-visual'],{env:{...process.env,KYBERN_SPARSE_LIST:sparse,KYBERN_MOTION_SYNC:sparse,KYBERN_APPEARANCE:theme,SIDEBAR_CHECKS:'0',SIDEBAR_VISUAL:'1',SIDEBAR_SCENE:'settled'},stdin:'inherit',stdout:'inherit',stderr:'inherit'})
 for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>child.kill(signal))
 if(await child.exited)throw Error('sidebar visual failed')
}
export {}
