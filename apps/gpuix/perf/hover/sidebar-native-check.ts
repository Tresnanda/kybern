// One updater batch: scoped display assertion and before/after lock checks.
import {mkdirSync,writeFileSync} from 'node:fs'
import {keepDisplayAwake,requireScreen} from '../bench/screen-state.ts'
const batch=process.argv[2]!,before=requireScreen(),stop=keepDisplayAwake()
const output=`/Users/mymac/projects/ade/previews/gpuix/sidebar-fix/build/native/${batch}`;mkdirSync(output,{recursive:true})
const child=Bun.spawn(['sh','native/check-update.sh',batch],{env:{...process.env,KYBERN_VERIFY_OUTPUT:output},stdin:'inherit',stdout:'inherit',stderr:'inherit'})
for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>child.kill(signal))
let code=1
try{code=await child.exited;process.exitCode=code}finally{
 child.kill();await child.exited;stop();const after=requireScreen()
 const out='/Users/mymac/projects/ade/previews/gpuix/sidebar-fix/build/native';mkdirSync(out,{recursive:true});writeFileSync(`${out}/${batch}-screen.json`,JSON.stringify({code,before,after},null,2))
}
