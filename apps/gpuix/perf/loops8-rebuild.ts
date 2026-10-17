/** Take the lease before the short cached rebuild, and retain it through checks. */
import path from 'node:path'
import {existsSync,renameSync} from 'node:fs'
import {pacingLock} from './loops8-lock.ts'
import {waitForNativeBuilds} from './loops8-build-free.ts'
await waitForNativeBuilds()
const release=await pacingLock(),start=performance.now()
const addon=path.resolve('native/build/gpuix-native.darwin-arm64.node')
const previous=path.resolve('native/build',process.env.KYBERN_LOOPS_PREVIOUS??'loops8-previous.node')
try {
 if(existsSync(previous))throw Error('Preserve or remove the prior loops8 build before rebuilding')
 renameSync(addon,previous)
 const child=Bun.spawn(['sh',process.env.KYBERN_LOOPS_RESEARCH==='1'?'perf/loops8-build.sh':'native/update.sh'],{env:{...process.env,KYBERN_PACING_PARENT_LEASE:path.resolve(import.meta.dir,'../../..')},stdout:'inherit',stderr:'inherit'})
 const code=await child.exited
 if(code)throw Error(`native/update.sh failed ${code}`)
 if(process.env.KYBERN_LOOPS_CHECK_REGION==='1'){
 const check=Bun.spawn(['bun','perf/loops8-native-check.ts','region'],{env:{...process.env,KYBERN_PACING_PARENT_LEASE:path.resolve(import.meta.dir,'../../..'),KYBERN_REGION_LAYERS:'1',KYBERN_REGION_ATLAS:'1',KYBERN_REGION_EXPECT_LAYERS:'1',KYBERN_REGION_EXPECT_ATLAS:'1',KYBERN_LOOPS_OUTPUT_TAG:'atlas-y-region'},stdout:'inherit',stderr:'inherit'});if(await check.exited)throw Error('Atlas region check failed')
 }
 console.log(`Lease held ${(performance.now()-start)/1000}s through rebuild and checks`)
} finally {
 if(!existsSync(addon)&&existsSync(previous))renameSync(previous,addon)
 release()
}
