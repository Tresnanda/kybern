import path from 'node:path'
import {pacingLock} from './loops8-lock.ts'
import {waitForNativeBuilds} from './loops8-build-free.ts'
const label=process.argv[2]??'text-region-atlas-y'
const env={...process.env,KYBERN_NATIVE_PAINT_ANIMATIONS:'1',KYBERN_NATIVE_TEXT_PAINT:'1',KYBERN_REGION_PAINT:'1',KYBERN_REGION_LAYERS:'1',KYBERN_REGION_DIRECT:'1',KYBERN_REGION_SINGLE_LAYER:'1',KYBERN_REGION_CULL:'1',KYBERN_REGION_ATLAS:'1'}
await waitForNativeBuilds()
const release=await pacingLock()
try{for(const check of (process.env.KYBERN_LOOPS_SKIP_REGION==='1'?['text','frame']:['region','text','frame'])){
 const child=Bun.spawn(['bun','perf/loops8-native-check.ts',check],{env:{...env,KYBERN_PACING_PARENT_LEASE:path.resolve(import.meta.dir,'../../..'),KYBERN_REGION_EXPECT_LAYERS:'1',KYBERN_REGION_EXPECT_DIRECT:'1',KYBERN_REGION_EXPECT_ATLAS:'1',KYBERN_LOOPS_OUTPUT_TAG:`atlas-y-${check}`},stdout:'inherit',stderr:'inherit'})
 const code=await child.exited;if(code)throw Error(`${check} failed ${code}`)
}
const child=Bun.spawn(['bun','perf/loops8-suite.ts',label],{env:{...env,KYBERN_PACING_PARENT_LEASE:path.resolve(import.meta.dir,'../../..'),KYBERN_LOOPS_SCENES:'thread,tasks',KYBERN_LOOPS_RESUME:'1'},stdout:'inherit',stderr:'inherit'})
const code=await child.exited;if(code)throw Error(`resources failed ${code}`)

}finally{release()}
