const scenario=process.argv[2]??'scroll'
if(!['scroll','fling'].includes(scenario))throw Error('scroll or fling required')
for(const label of [`baseline-long-${scenario}`,`mounts-long-${scenario}`]) {
 const child=Bun.spawn(['bun',import.meta.dir+'/run.ts',label,'3000'],{env:{...process.env,TRANSCRIPT_PAIR:'1',TRANSCRIPT_SCENES:scenario},stdout:'inherit',stderr:'inherit'})
 if(await child.exited)throw Error(`${label} failed`)
}
if(scenario==='scroll'){const verify=Bun.spawn(['bun',import.meta.dir+'/verify.ts'],{env:{...process.env,TRANSCRIPT_PAIR:'1'},stdout:'inherit',stderr:'inherit'});if(await verify.exited)throw Error('Transcript interaction verification failed')}
export {}
