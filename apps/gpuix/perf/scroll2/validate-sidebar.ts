/** Correctness and visual cases have independent sub-five-minute UI leases. */
for (const theme of ['dark','light']) for (const sparse of ['0','1']) for (const mode of ['visual','checks']) {
 const variant=sparse==='1'?'sparse':'dense'
 const child=Bun.spawn(['bun',import.meta.dir+'/lease.ts','bun',import.meta.dir+'/sidebar.ts',variant+'-'+mode],{env:{...process.env,KYBERN_SPARSE_LIST:sparse,KYBERN_APPEARANCE:theme,SIDEBAR_VISUAL:mode==='visual'?'1':'0',SIDEBAR_CHECKS:mode==='checks'?'1':'0'},stdin:'inherit',stdout:'inherit',stderr:'inherit'})
 for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>child.kill(signal))
 if(await child.exited)throw Error(`${variant} ${theme} ${mode} failed`)
}
export {}
