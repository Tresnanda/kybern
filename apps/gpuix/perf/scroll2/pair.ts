// One pair stays below the five-minute UI lease; the outer quiet window is separate.
const count=Number(process.argv[2]??3000)
for(const sparse of [false,true]){
 const label=(sparse?'sparse':'dense')+(process.env.SCROLL2_SYNTHETIC==='1'?'-synthetic':'')
 const child=Bun.spawn(['bun',import.meta.dir+'/transcript.ts',label,String(count)],{env:{...process.env,KYBERN_SPARSE_LIST:sparse?'1':'0',KYBERN_MOTION_SYNC:sparse?'1':'0',TRANSCRIPT_INPUT:'appkit',TRANSCRIPT_MATCHED:'1',TRANSCRIPT_PAIR:'1',TRANSCRIPT_SCENES:'scroll,fling,idle'},stdin:'inherit',stdout:'inherit',stderr:'inherit'})
 for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>child.kill(signal))
 if(await child.exited)throw Error(label+' failed')
}
export {}
