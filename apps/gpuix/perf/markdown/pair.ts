// One matched batch, below the five-minute UI lease budget.
const runs=[
 {label:'before-preview',env:{EXPLORER_SCENES:'preview.md',EXPLORER_IDLE:'1'}},
 {label:'after-preview',env:{EXPLORER_SCENES:'preview.md',EXPLORER_IDLE:'1',MARKDOWN_DOCUMENT_STATS:'1'}},
 {label:'before-pr',env:{MARKDOWN_PR:'1',EXPLORER_SCENES:'summary'}},
 {label:'after-pr',env:{MARKDOWN_PR:'1',EXPLORER_SCENES:'summary'}},
]
for(const run of runs){
 const child=Bun.spawn(['bun',import.meta.dir+'/run.ts',run.label],{env:{...process.env,...run.env},stdin:'inherit',stdout:'inherit',stderr:'inherit'})
 const stop=()=>child.kill('SIGTERM')
 process.once('SIGINT',stop);process.once('SIGTERM',stop)
 const code=await child.exited
 process.off('SIGINT',stop);process.off('SIGTERM',stop)
 if(code)process.exit(code)
}
