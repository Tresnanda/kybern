// Run the final evidence batches sequentially. Children acquire fair <=5 min
// leases; never run this alongside another scroll8 driver.
const steps=[
 {args:['perf/scroll8-all.ts'],env:{SCROLL8_REUSE_REFERENCE:'1'}},
 {args:['perf/scroll8-followup.ts'],env:{}},
 {args:['perf/scroll8-all.ts'],env:{SCROLL8_REAL:'1',SCROLL8_PR_NUMBER:'109',SCROLL8_FILE_INDEX:'15'}},
 {args:['perf/scroll8-report.ts'],env:{}},
]
for(const step of steps){
 const child=Bun.spawn(['bun',...step.args],{env:{...process.env,...step.env},stdout:'inherit',stderr:'inherit'})
 if(await child.exited)throw Error(step.args.join(' '))
}
