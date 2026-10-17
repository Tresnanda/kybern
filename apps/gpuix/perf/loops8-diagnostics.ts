import path from 'node:path'
import {resourceRows,usable} from './loops8-results.ts'
import {pacingLock} from './loops8-lock.ts'
import {waitForNativeBuilds} from './loops8-build-free.ts'
const controls=[{name:'union-load',rects:'0',load:'1',split:'0'},{name:'union-discard',rects:'0',load:'0',split:'0'},{name:'rects-discard',rects:'1',load:'0',split:'0'},{name:'full',rects:'0',load:'1',split:'0'}]
const jobs=[1,2].flatMap(repeat=>controls.map(control=>({repeat,...control}))).concat([{repeat:1,name:'split',rects:'1',load:'0',split:'1'}])
const evidence='/Users/mymac/projects/ade/previews/gpuix/round8/loops/resources.jsonl'
const pending=jobs.filter(job=>!resourceRows().some(row=>usable(row)&&row.label===(job.name==='full'?'text-full':`text-region-${job.name}`)&&row.repeat===job.repeat))
for(let index=0;index<pending.length;){
 await waitForNativeBuilds()
 const release=await pacingLock(),start=performance.now();let count=0
 try{do{
  const job=pending[index++]!
  const child=Bun.spawn(['bun','perf/loops8-fixture.ts','--','bun','perf/loops8-resources.ts',job.name==='full'?'text-full':`text-region-${job.name}`,'thread'],{env:{...process.env,KYBERN_LOOPS_REPEAT:String(job.repeat),KYBERN_GPU_TRACE:'1',KYBERN_GPU_TRACE_SPLIT:job.split,KYBERN_REGION_RECTS:job.rects,KYBERN_REGION_COPY_LOAD:job.load,KYBERN_PACING_PARENT_LEASE:path.resolve(import.meta.dir,'../../..')},stdout:'inherit',stderr:'inherit'})
  const code=await child.exited;if(code)throw Error(`${job.name} failed ${code}`)
  count++
 }while(index<pending.length&&count<4&&performance.now()-start<120000)}finally{release()}
}
