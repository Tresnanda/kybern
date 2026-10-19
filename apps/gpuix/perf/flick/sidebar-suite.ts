// Called by the existing sidebar fixture; one bounded lease per native window.
async function run(command:string[],env:Record<string,string>={}){
 const child=Bun.spawn(command,{env:{...process.env,...env},stdin:'inherit',stdout:'inherit',stderr:'inherit'})
 for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>child.kill(signal))
 if(await child.exited)throw Error(command.join(' ')+' failed')
}
for(const theme of ['dark','light'])for(const flag of ['0','1']){
 const label=flag==='0'?'dense-visual':'sparse-visual'
 await run(['bun','native/ui-lease.ts','perf-flick-sidebar','bun','perf/flick/check.ts',`${label}-${theme}`,'bun','perf/flick/reuse.ts','perf/scroll2/sidebar.ts',label],{KYBERN_INPUT_FRAME_DRAW:flag,KYBERN_APPEARANCE:theme,KYBERN_WINDOW_SIZE:'1280x820',KYBERN_SPARSE_LIST:'1',KYBERN_MOTION_SYNC:'1',SIDEBAR_VISUAL:'1',SIDEBAR_CHECKS:'0',SCROLL2_EVIDENCE:'/Users/mymac/projects/ade/previews/gpuix/perf/flick/checks/sidebar'})
}
for(const theme of ['dark','light'])await run(['bun','native/ui-lease.ts','perf-flick-sidebar','bun','perf/flick/check.ts',`sidebar-checks-${theme}`,'bun','perf/flick/reuse.ts','perf/scroll2/sidebar.ts','frame-checks'],{KYBERN_INPUT_FRAME_DRAW:'1',KYBERN_APPEARANCE:theme,KYBERN_WINDOW_SIZE:'1280x820',KYBERN_SPARSE_LIST:'1',SIDEBAR_CHECKS:'1',SIDEBAR_VISUAL:'0',SCROLL2_EVIDENCE:'/Users/mymac/projects/ade/previews/gpuix/perf/flick/checks/sidebar'})
await run(['bun','perf/flick/reuse.ts','perf/scroll2/pixels.ts'])
export {}
