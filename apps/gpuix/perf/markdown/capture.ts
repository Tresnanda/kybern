// Capture separately from all timing runs; interruption propagates to each app.
const runs=[
 {args:['bun',import.meta.dir+'/run.ts','before-visual-resumed'],env:{KYBERN_APPEARANCE:'dark',EXPLORER_SCENES:'preview.md',EXPLORER_VISUAL:'1'}},
 {args:['bun',import.meta.dir+'/run.ts','before-visual-resumed'],env:{KYBERN_APPEARANCE:'light',EXPLORER_SCENES:'preview.md',EXPLORER_VISUAL:'1'}},
 {args:['bun',import.meta.dir+'/run.ts','after-visual-resumed'],env:{KYBERN_APPEARANCE:'dark',EXPLORER_SCENES:'preview.md',EXPLORER_VISUAL:'1'}},
 {args:['bun',import.meta.dir+'/run.ts','after-visual-resumed'],env:{KYBERN_APPEARANCE:'light',EXPLORER_SCENES:'preview.md',EXPLORER_VISUAL:'1'}},
 {args:['bun',import.meta.dir+'/pr-capture.ts','--before'],env:{}},
 {args:['bun',import.meta.dir+'/pr-capture.ts'],env:{}},
]
for(const run of runs){
 const child=Bun.spawn(run.args,{env:{...process.env,...run.env},stdin:'inherit',stdout:'inherit',stderr:'inherit'})
 const stop=()=>child.kill('SIGTERM')
 process.once('SIGINT',stop);process.once('SIGTERM',stop)
 const code=await child.exited
 process.off('SIGINT',stop);process.off('SIGTERM',stop)
 if(code)process.exit(code)
}
