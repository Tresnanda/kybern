import path from 'node:path'
for(const label of ['baseline','text-region']){
 const child=Bun.spawn(['bun','perf/loops8-suite.ts',label],{env:{...process.env,KYBERN_LOOPS_RESUME:'1',KYBERN_PACING_ADDON:path.resolve(`native/build/${label==='baseline'?'before.node':'gpuix-native.darwin-arm64.node'}`)},stdout:'inherit',stderr:'inherit'})
 const code=await child.exited;if(code)throw Error(`${label} suite failed ${code}`)
}
