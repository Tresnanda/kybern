/** Running children and collapsed projects exercise semantic topology changes. */
for(const theme of ['dark','light']){
 const child=Bun.spawn(['bun',import.meta.dir+'/lease.ts','bun',import.meta.dir+'/sidebar.ts','sparse-mixed-checks'],{env:{...process.env,KYBERN_SPARSE_LIST:'1',KYBERN_APPEARANCE:theme,SIDEBAR_CHECKS:'1',SIDEBAR_VISUAL:'0',SIDEBAR_SCENE:'mixed'},stdin:'inherit',stdout:'inherit',stderr:'inherit'})
 for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>child.kill(signal))
 if(await child.exited)throw Error('mixed sidebar '+theme+' failed')
}
export {}
