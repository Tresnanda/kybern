/** Final regression diagnosis and full validation, within one fair UI lease. */
import path from 'node:path'
import {pacingLock} from './loops8-lock.ts'
import {waitForNativeBuilds} from './loops8-build-free.ts'
await waitForNativeBuilds()
const release=await pacingLock(),start=performance.now()
const env={...process.env,KYBERN_PACING_PARENT_LEASE:path.resolve(import.meta.dir,'../../..')}
try{
 for(const command of [['bun','perf/loops8-paint-regression.ts'],['bun','perf/loops8-rebuild.ts'],['bun','test','./src'],['pnpm','exec','tsc','-p','perf/loops8-tsconfig.json']]){
  const child=Bun.spawn(command,{env:{...env,KYBERN_LOOPS_PREVIOUS:'loops8-atlas-y-v6.node'},stdout:'inherit',stderr:'inherit'})
  const code=await child.exited;if(code)throw Error(`${command.join(' ')} failed ${code}`)
 }
 console.log(`Final lease held ${(performance.now()-start)/1000}s`)
}finally{release()}
