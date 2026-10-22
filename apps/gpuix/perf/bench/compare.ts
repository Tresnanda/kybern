import {readFileSync} from 'node:fs'
import {percentile,fmt,type Result} from './model.ts'
const [a,b]=process.argv.slice(2);if(!a||!b)throw Error('usage: bun perf/bench/compare.ts a.json b.json')
const read=(p:string)=>JSON.parse(readFileSync(p,'utf8')) as {schemaVersion:number;aborted?:boolean;fullRate:string;resourceSeconds:number;warmupSeconds:number;renderFlags?:Record<string,string>;hardware?:string;workload?:{counts:Record<string,number>};results:Result[]}
const before=read(a),after=read(b)
if(before.aborted||after.aborted)throw Error('Incomplete/aborted suite; comparison refused')
if(before.resourceSeconds!==after.resourceSeconds||before.warmupSeconds!==after.warmupSeconds)throw Error('Sample duration or warm-up mismatch; comparison refused')
if(before.schemaVersion!==after.schemaVersion||before.fullRate!==after.fullRate)throw Error('Schema or KYBERN_FULL_RATE mismatch; comparison refused')
if(before.hardware!==after.hardware||JSON.stringify(before.workload?.counts)!==JSON.stringify(after.workload?.counts))throw Error('Hardware or workload mismatch; comparison refused')
const integerWheel=(doc:typeof before)=>doc.renderFlags?.KYBERN_BENCH_INTEGER_WHEEL==null?'1':doc.renderFlags.KYBERN_BENCH_INTEGER_WHEEL==='1'?'1':'0'
const directWheel=(doc:typeof before)=>doc.renderFlags?.KYBERN_BENCH_DIRECT_VIEW==null?'0':doc.renderFlags.KYBERN_BENCH_DIRECT_VIEW==='0'?'0':'1'
const wheelMismatch=integerWheel(before)!==integerWheel(after)||directWheel(before)!==directWheel(after)
const flagsDiffer=JSON.stringify(before.renderFlags)!==JSON.stringify(after.renderFlags)
const ws=[...before.results,...after.results].some(r=>r.resources.windowServer)
console.log(`| Scenario | Δ p95 ms | Δ >33 ms | Δ CPU points | Δ GPU ms | Δ MiB |${ws?' Δ WS CPU points | Δ WS GPU ms | Δ WS GPU % |':''} Noise flag |\n|---|---:|---:|---:|---:|---:|${ws?'---:|---:|---:|':''}---|`)
for(const name of new Set(before.results.map(r=>r.scenario))){
 const left=before.results.filter(r=>r.scenario===name&&r.status==='ok'),right=after.results.filter(r=>r.scenario===name&&r.status==='ok')
 const delta=(get:(r:Result)=>number|null)=>{const x=percentile(left.flatMap(r=>get(r)==null?[]:[get(r)!]),.5),y=percentile(right.flatMap(r=>get(r)==null?[]:[get(r)!]),.5);return x==null||y==null?null:y-x}
 const rate=(rows:Result[])=>percentile(rows.flatMap(r=>typeof r.evidence.offeredPacketsPerSecond==='number'&&r.evidence.offeredPacketsPerSecond>0?[r.evidence.offeredPacketsPerSecond]:typeof r.evidence.offeredDeltasPerSecond==='number'?[r.evidence.offeredDeltasPerSecond]:[]),.5)
 const leftRate=rate(left),rightRate=rate(right),rateMismatch=leftRate!=null&&rightRate!=null&&leftRate>0&&Math.abs(rightRate-leftRate)/leftRate>.05
 const missingProducerSpan=[...left,...right].some(r=>typeof r.evidence.offeredPackets==='number'&&r.evidence.offeredPackets>0&&typeof r.evidence.inputProductionMs!=='number')
 const backendMismatch=left.some(r=>r.evidence.appkitAccepted!==right[0]?.evidence.appkitAccepted)
 const frame=delta(r=>r.frames.p95),cpu=delta(r=>r.resources.cpuPercent),flags=[...(wheelMismatch?['wheel delivery differs; apparatus comparison only']:[]),...(flagsDiffer?['render flags differ; inspect intended A/B']:[]),...(left[0]?.host!==right[0]?.host?['different host frontend; reference only']:[]),...(missingProducerSpan?['producer duration unavailable; rate match unverified']:[]),...(rateMismatch?['input rate differs >5%; unmatched A/B']:[]),...(backendMismatch?['input backend differs; unmatched A/B']:[]),...(frame!=null&&Math.abs(frame)<1?['frame <1 ms']:[]),...(cpu!=null&&Math.abs(cpu)<3?['CPU <3 points']:[])]
 const median=(rows:Result[],get:(r:Result)=>number|null)=>percentile(rows.flatMap(r=>get(r)==null?[]:[get(r)!]),.5),wsBase=median(left,r=>r.resources.windowServer?.gpuMs??null),wsGpu=delta(r=>r.resources.windowServer?.gpuMs??null)
 console.log(`| ${name} | ${fmt(frame)} | ${fmt(delta(r=>r.frames.over33))} | ${fmt(cpu)} | ${fmt(delta(r=>r.resources.gpuMs))} | ${fmt(delta(r=>r.resources.footprintMiB))} |${ws?` ${fmt(delta(r=>r.resources.windowServer?.cpuPercent??null))} | ${fmt(wsGpu)} | ${wsGpu!=null&&wsBase?fmt(wsGpu/wsBase*100):'—'} |`:''} ${left.length&&right.length?flags.join('; ')||'above noise thresholds':'missing successful runs'} |`)
}
