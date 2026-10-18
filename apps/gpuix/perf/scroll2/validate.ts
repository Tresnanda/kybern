/** Run after the complete native updater; native checks never enter a quiet window. */
async function run(args:string[]){
 const child=Bun.spawn(args,{env:process.env,stdin:'inherit',stdout:'inherit',stderr:'inherit'})
 for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>child.kill(signal))
 if(await child.exited)throw Error(args.join(' ')+' failed')
}
for(const args of [['verify-list.ts'],['verify-transcript.ts'],['visual.ts'],['regressions.ts']])await run(['bun','perf/scroll2/lease.ts','bun','perf/scroll2/'+args[0],...args.slice(1)])
await run(['env','TRANSCRIPT_COMPACT=1','bun','perf/scroll2/lease.ts','bun','perf/scroll2/verify-transcript.ts'])
await run(['bun','perf/scroll2/fixture.ts','bun','perf/scroll2/validate-sidebar.ts'])
await run(['bun','perf/scroll2/fixture.ts','bun','perf/scroll2/validate-mixed.ts'])
await run(['bun','perf/scroll2/fixture.ts','bun','perf/scroll2/validate-visual.ts'])
await run(['python3','perf/scroll2/task-checks.py'])
await run(['bun','perf/scroll2/pixels.ts']);await run(['bun','perf/scroll2/pixels.ts','--checks'])
export {}
