import {writeFileSync} from 'node:fs'
import {pixels} from '../../native/png.ts'
const out='/Users/mymac/projects/ade/previews/gpuix/perf/stream/visual'
const results=[]
for(const theme of ['dark','light'])for(const reduced of ['0','1']){
 const before=`${out}/before-${theme}-${reduced}-final.png`,after=`${out}/after-${theme}-${reduced}-final.png`
 const a=pixels(before),b=pixels(after)
 if(a.w!==b.w||a.h!==b.h)throw Error('Mismatched screenshot dimensions')
 let changed=0,maxDelta=0
 for(let y=4;y<a.h-4;y++)for(let x=4;x<a.w-4;x++){
  const p=a.at(x,y),q=b.at(x,y),delta=Math.max(...p.map((v,i)=>Math.abs(v-q[i]!)))
  if(delta)changed++;maxDelta=Math.max(maxDelta,delta)
 }
 results.push({theme,reduced,before,after,width:a.w,height:a.h,changed,maxDelta})
}
writeFileSync(`${out}/pixels.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2))
if(results.some(r=>r.changed))process.exitCode=1
