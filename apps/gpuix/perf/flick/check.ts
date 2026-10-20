// Parent native/ui-lease.ts owns and cleans the process group.
import {writeFileSync,mkdirSync} from 'node:fs'
import {watchRun,processInventory} from '../bench/process-gate.ts'
import {keepDisplayAwake,requireScreen} from '../bench/screen-state.ts'
const label=process.argv[2]!,command=process.argv.slice(3)
if(!label||!command.length)throw Error('Pass label and command')
const out='/Users/mymac/projects/ade/previews/gpuix/perf/flick/checks';mkdirSync(out,{recursive:true})
requireScreen();const inventory=processInventory();if(inventory.foreign.length)throw Error('Foreign GPUIX process before visual batch: '+inventory.foreign.join('; '))
const stopAwake=keepDisplayAwake(),watch=watchRun()
const child=Bun.spawn(command,{env:process.env,stdin:'inherit',stdout:'inherit',stderr:'inherit'})
for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>child.kill(signal))
const watchdog=setTimeout(()=>child.kill('SIGTERM'),285000)
let code=1
try{code=await child.exited;process.exitCode=code}finally{
 clearTimeout(watchdog);child.kill();await child.exited;stopAwake();const gate=watch.finish();writeFileSync(`${out}/${label}-gate.json`,JSON.stringify({code,...gate,timingEvidence:false,buildOverlapIsContext:true},null,2))
 // This runner produces deterministic pixels and interaction assertions, not
 // performance evidence. Exclusive UI ownership still prevents other windows.
 if(gate.orphanOverlap||gate.screenInvalid)throw Error('Invalid visual/check batch: see gate evidence')
}
