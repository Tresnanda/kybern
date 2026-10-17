import path from 'node:path'
import {resourceRows,usable} from './loops8-results.ts'
import {pacingLock} from './loops8-lock.ts'
import {waitForNativeBuilds} from './loops8-build-free.ts'
const label=process.argv[2]??'text-region'
await waitForNativeBuilds()
const completed=process.env.KYBERN_LOOPS_RESUME==='1'?resourceRows():[]
const attempts=new Map<string,number>()
const scenes=(process.env.KYBERN_LOOPS_SCENES??'home,settled-thread,thread,home-running,tasks').split(',')
const jobs=[1,2].flatMap(repeat=>scenes.map(scene=>({repeat,scene}))).filter(job=>!completed.some(row=>row.label===label&&row.repeat===job.repeat&&row.scene===job.scene&&!row.diagnostic&&usable(row)))
for(let index=0;index<jobs.length;){
 await waitForNativeBuilds()
 const release=await pacingLock(),start=performance.now();let count=0
 try{do{
  const {repeat,scene}=jobs[index++]!
  const child=Bun.spawn(['bun','perf/loops8-fixture.ts','--','bun','perf/loops8-resources.ts',label,scene],{env:{...process.env,KYBERN_LOOPS_REPEAT:String(repeat),KYBERN_PACING_PARENT_LEASE:path.resolve(import.meta.dir,'../../..'),KYBERN_PACING_ADDON:process.env.KYBERN_PACING_ADDON??path.resolve('native/build/gpuix-native.darwin-arm64.node')},stdout:'inherit',stderr:'inherit'})
  const code=await child.exited
  const row=resourceRows().at(-1)
  if(code||!row||row.label!==label||row.scene!==scene||row.repeat!==repeat||!usable(row)){
   const key=`${scene}-${repeat}`,tries=(attempts.get(key)??0)+1;attempts.set(key,tries)
   console.error(`DISCARDED ${label} ${scene} repeat ${repeat}, attempt ${tries}: visibility, build activity, coverage or launch failure`)
   if(tries<3)jobs.push({repeat,scene})
   else console.error(`UNVERIFIED ${label} ${scene} repeat ${repeat}: three contaminated attempts`)
  }
  count++
 }while(index<jobs.length&&count<4&&performance.now()-start<120000)}finally{release()}
}
