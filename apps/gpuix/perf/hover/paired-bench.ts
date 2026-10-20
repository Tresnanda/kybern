/** Repeat the addons consecutively when a distant baseline is inconclusive. */
import {spawn} from 'node:child_process'
import path from 'node:path'
let child:ReturnType<typeof spawn>|undefined
for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>child?.kill(signal))
try{
 for(const [label,addon] of [['before','prior-hover.node'],['after','gpuix-native.darwin-arm64.node']]){
  child=spawn('bun',['perf/bench/run.ts','sidebar-scroll','thread-fling','idle-home','--runs','2','--label',`hr5-hover-paired-${label}`,'--keep-data'],{env:{...process.env,NAPI_RS_NATIVE_LIBRARY_PATH:path.resolve('native/build',addon!)},stdio:'inherit'})
  const code=await new Promise<number>((resolve,reject)=>{child!.once('error',reject);child!.once('exit',code=>resolve(code??1))})
  child=undefined
  if(code)throw Error(`Paired benchmark failed: ${label}`)
 }
}finally{child?.kill()}
