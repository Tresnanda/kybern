import {writeFileSync} from 'node:fs'
import {pixels} from '../../native/png.ts'
const out='/Users/mymac/projects/ade/previews/gpuix/perf/coldstart',results=[]
for(const theme of ['dark','light']){
 const before=`${out}/baseline-visuals-${theme}-0.png`,after=`${out}/candidate-visuals-${theme}-0.png`
 const a=pixels(before),b=pixels(after)
 if(a.w!==b.w||a.h!==b.h)throw Error('Mismatched image geometry')
 let changed=0,maxDelta=0
 for(let y=0;y<a.h;y++)for(let x=0;x<a.w;x++){
  const p=a.at(x,y),q=b.at(x,y),d=Math.max(...p.map((v,i)=>Math.abs(v-q[i]!)))
  if(d)changed++;maxDelta=Math.max(maxDelta,d)
 }
 results.push({theme,before,after,width:a.w,height:a.h,total:a.w*a.h,changed,maxDelta})
}
writeFileSync(`${out}/pixel-diff.json`,JSON.stringify(results,null,2))
console.log(JSON.stringify(results))
if(results.some(r=>r.changed))process.exitCode=1
