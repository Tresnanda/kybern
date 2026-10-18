for(const label of ['baseline-stream','mounts-stream']) {
 const child=Bun.spawn(['bun',import.meta.dir+'/run.ts',label,'1000'],{env:{...process.env,TRANSCRIPT_PAIR:'1',TRANSCRIPT_STREAM:'1',TRANSCRIPT_SCENES:'scroll'},stdout:'inherit',stderr:'inherit'})
 if(await child.exited)throw Error(`${label} failed`)
}
export {}
