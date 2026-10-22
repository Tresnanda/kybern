/**
 * The ADE-47 translucency gate (`perf/translucency-2026-10.md`): a mode passes when, in both the forward and the reverse
 * pair, every metric stays within its threshold against the matching `before` run (medians of the successful windows).
 *
 *   bun perf/bench/gate.ts <before.json> <after.json> [<before-idle.json> <after-idle.json>]
 *
 * Active scenarios (streaming, thread-scroll, sidebar-scroll) and idle-home use different thresholds. Rows whose input
 * rate or backend do not match invalidate the pair. Exit code 1 when a threshold is exceeded.
 */
import {readFileSync} from 'node:fs'
import {percentile,type Result} from './model.ts'
type Doc={results:Result[]}
const read=(p:string)=>JSON.parse(readFileSync(p,'utf8')) as Doc
const [beforePath,afterPath,beforeIdlePath,afterIdlePath]=process.argv.slice(2)
if(!beforePath||!afterPath)throw Error('usage: bun perf/bench/gate.ts before.json after.json [before-idle.json after-idle.json]')

const median=(rows:Result[],get:(r:Result)=>number|null|undefined)=>percentile(rows.flatMap(r=>{const v=get(r);return v==null||Number.isNaN(v)?[]:[v]}),.5)
type Row={scenario:string;metric:string;before:number|null;after:number|null;delta:number|null;limit:string;pass:boolean|null}
const rows:Row[]=[]
let invalid=false

function pair(before:Doc,after:Doc,scenarios:string[],idle:boolean){
 for(const scenario of scenarios){
  const a=before.results.filter(r=>r.scenario===scenario&&r.status==='ok'),b=after.results.filter(r=>r.scenario===scenario&&r.status==='ok')
  if(!a.length||!b.length){rows.push({scenario,metric:'successful runs',before:a.length,after:b.length,delta:null,limit:'≥1 each',pass:false});invalid=true;continue}
  const rate=(x:Result[])=>median(x,r=>typeof r.evidence.offeredPacketsPerSecond==='number'&&r.evidence.offeredPacketsPerSecond>0?r.evidence.offeredPacketsPerSecond:typeof r.evidence.offeredDeltasPerSecond==='number'?r.evidence.offeredDeltasPerSecond:null)
  const ra=rate(a),rb=rate(b)
  if(ra!=null&&rb!=null&&ra>0&&Math.abs(rb-ra)/ra>.05){rows.push({scenario,metric:'input rate',before:ra,after:rb,delta:rb-ra,limit:'within 5% (else rerun)',pass:false});invalid=true}
  if(a.some(r=>r.evidence.appkitAccepted!==b[0]?.evidence.appkitAccepted)){rows.push({scenario,metric:'input backend',before:null,after:null,delta:null,limit:'matched (else rerun)',pass:false});invalid=true}
  const add=(metric:string,get:(r:Result)=>number|null|undefined,limit:string,test:(delta:number,before:number)=>boolean)=>{
   const x=median(a,get),y=median(b,get)
   rows.push({scenario,metric,before:x,after:y,delta:x==null||y==null?null:y-x,limit,pass:x==null||y==null?null:test(y-x,x)})
  }
  if(!idle){
   add('frame p95 ms',r=>r.frames.p95,'Δ ≤ +1.0',d=>d<=1)
   add('intervals > 33 ms',r=>r.frames.over33,'Δ ≤ +1',d=>d<=1)
   add('GPUIX CPU %',r=>r.resources.cpuPercent,'Δ ≤ +3',d=>d<=3)
   add('GPUIX GPU ms',r=>r.resources.gpuMs,'Δ ≤ +10%',(d,x)=>d<=x*.1)
   add('GPUIX MiB',r=>r.resources.footprintMiB,'Δ ≤ +10',d=>d<=10)
   add('WindowServer CPU %',r=>r.resources.windowServer?.cpuPercent,'Δ ≤ +3',d=>d<=3)
   add('WindowServer GPU ms',r=>r.resources.windowServer?.gpuMs,'Δ ≤ +15%',(d,x)=>d<=x*.15)
  }else{
   add('GPUIX CPU %',r=>r.resources.cpuPercent,'Δ ≤ +1',d=>d<=1)
   add('submissions',r=>r.frames.count,'stays 0',(_d,x)=>x===0&&(median(b,r=>r.frames.count)??1)===0)
   add('GPUIX GPU ms',r=>r.resources.gpuMs,'stays 0',(_d,x)=>x===0&&(median(b,r=>r.resources.gpuMs)??1)===0)
   add('GPUIX MiB',r=>r.resources.footprintMiB,'Δ ≤ +10',d=>d<=10)
   add('WindowServer CPU %',r=>r.resources.windowServer?.cpuPercent,'Δ ≤ +1',d=>d<=1)
   add('WindowServer GPU ms',r=>r.resources.windowServer?.gpuMs,'Δ ≤ +15%',(d,x)=>d<=x*.15)
  }
 }
}
pair(read(beforePath),read(afterPath),['streaming','thread-scroll','sidebar-scroll'],false)
if(beforeIdlePath&&afterIdlePath)pair(read(beforeIdlePath),read(afterIdlePath),['idle-home'],true)

const f=(n:number|null)=>n==null?'—':Number.isInteger(n)?String(n):n.toFixed(2)
console.log('| Scenario | Metric | Before | After | Δ | Limit | Result |\n|---|---|---:|---:|---:|---|---|')
for(const r of rows)console.log(`| ${r.scenario} | ${r.metric} | ${f(r.before)} | ${f(r.after)} | ${f(r.delta)} | ${r.limit} | ${r.pass==null?'n/a':r.pass?'pass':'**FAIL**'} |`)
const failed=rows.filter(r=>r.pass===false)
console.log(`\n${invalid?'INVALID PAIR (rerun). ':''}${failed.length?`FAILS: ${failed.map(r=>`${r.scenario} ${r.metric}`).join('; ')}`:'PASS'}`)
process.exit(failed.length?1:0)
