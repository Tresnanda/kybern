export {}
// One ordered quiet window, with a new fair UI lease for each bounded batch.
const runs=[
 {lane:'large',args:['bun','perf/markdown/run.ts','after-large'],env:{EXPLORER_SCENES:'two-mib.md,giant-paragraph.md,giant-inline.md',EXPLORER_IDLE:'1',MARKDOWN_DOCUMENT_STATS:'1'}},
 {lane:'pair',args:['bun','perf/markdown/pair.ts'],env:{}},
 {lane:'control-native',args:['bun','perf/markdown/run.ts','before-current-native'],env:{EXPLORER_SCENES:'preview.md',MARKDOWN_CURRENT_NATIVE:'1'}},
 {lane:'containers',args:['bun','perf/markdown/run.ts','after-containers'],env:{EXPLORER_SCENES:'giant-table.md,giant-code.md,giant-list.md',EXPLORER_IDLE:'1',MARKDOWN_DOCUMENT_STATS:'1'}},
 {lane:'reachability',args:['bun','perf/markdown/run.ts','after-reachability'],env:{EXPLORER_SCENES:'two-mib.md,giant-paragraph.md,giant-inline.md,giant-table.md,giant-code.md,giant-list.md',EXPLORER_LIFECYCLE:'1'}},
 {lane:'before-profile',args:['bun','perf/markdown/run.ts','before-profile'],env:{EXPLORER_SCENES:'preview.md',EXPLORER_PROFILE:'1'}},
 {lane:'after-profile',args:['bun','perf/markdown/run.ts','after-profile'],env:{EXPLORER_SCENES:'preview.md',EXPLORER_PROFILE:'1'}},
 {lane:'visuals',args:['bun','perf/markdown/capture.ts'],env:{}},
 {lane:'app-pixels',args:['bun','perf/markdown/compare.ts'],env:{}},
]
let active: ReturnType<typeof Bun.spawn>|undefined
let stopped=false
const stop=()=>{stopped=true;active?.kill('SIGTERM')}
process.once('SIGINT',stop);process.once('SIGTERM',stop)
try {
 for(const run of runs.filter(run => !process.env.MARKDOWN_BATCHES || process.env.MARKDOWN_BATCHES.split(',').includes(run.lane))){
  if(stopped){process.exitCode=130;break}
  console.log(`[markdown-measure] ${run.lane} ${new Date().toISOString()}`)
  active=Bun.spawn(['bun','native/ui-lease.ts','perf-markdown-'+run.lane,...run.args],{env:{...process.env,...run.env},stdin:'inherit',stdout:'inherit',stderr:'inherit'})
  const code=await active.exited
  active=undefined
  if(code){process.exitCode=code;break}
 }
} finally {process.off('SIGINT',stop);process.off('SIGTERM',stop)}
