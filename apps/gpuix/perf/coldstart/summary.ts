import {readdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs'
import {parseResources} from '../bench/telemetry.ts'
const out='/Users/mymac/projects/ade/previews/gpuix/perf/coldstart'
type Run={handshake:number;shell:number;sidebar:number;firstContent:number;content:number;olderPageReady?:number;openMs?:number;historyMs?:number;startupFrames:number[];startupCosts:{render:number;layout:number}[];resourceText?:string;idleFrames?:number;resourceFrames?:number[];timeline:{phase:string;ms:number}[];rpcs:{method:string;ms:number;fromSpawnMs:number}[]}
function dist(values:number[]){const s=[...values].sort((a,b)=>a-b);const q=(p:number)=>s[Math.min(s.length-1,Math.floor(s.length*p))]??null;return {n:s.length,p50:q(.5),p90:q(.9),p95:q(.95),p99:q(.99),over16_7:s.filter(v=>v>16.7).length,over33:s.filter(v=>v>33).length}}
const summary:Record<string,unknown>={fullRate:1,workload:'300 threads / 20 projects; saved 2500 turns; uncached other 2000 turns',processClock:'App spawn; daemon launch/migration and OS cache purge excluded',frameSemantics:'Post-draw native scene submissions. Startup waits are not animation drops.'}
for(const phase of ['baseline','candidate'])for(const temperature of ['cold','warm']){
 const runs=readdirSync(out).filter(n=>new RegExp(`^${phase}-timing-dark-\\d+\\.json$`).test(n)).sort().map(n=>(JSON.parse(readFileSync(`${out}/${n}`,'utf8')) as Run[])[temperature==='cold'?0:1]!).filter(Boolean)
 if(runs.length!==5)throw Error(`${phase}/${temperature}: expected five accepted repeats, found ${runs.length}`)
 const milestones=Object.fromEntries(['handshake','shell','sidebar','firstContent','content','olderPageReady','openMs','historyMs'].map(k=>[k,dist(runs.flatMap(r=>{const v=r[k as keyof Run];return typeof v==='number'?[v]:[]}))]))
 const phases=Object.fromEntries(['first-module','modules-ready','endpoint-ready','workspace-module-ready','render-start','render-returned','fonts-start','fonts-ready','lists-ready','thread-page-ready','thread-ready'].map(k=>[k,dist(runs.flatMap(r=>{const v=r.timeline.find(t=>t.phase===k)?.ms;return v==null?[]:[v]}))]))
 summary[`${phase}-${temperature}`]={runs:runs.length,milestones,phases,submissionIntervals:dist(runs.flatMap(r=>r.startupFrames??[])),renderMs:dist(runs.flatMap(r=>r.startupCosts?.map(c=>c.render)??[])),layoutMs:dist(runs.flatMap(r=>r.startupCosts?.map(c=>c.layout)??[]))}
}
for(const phase of ['baseline','candidate'])for(const mode of ['resources','active']){
 const file=`${out}/${phase}-${mode}-dark-0.json`
 if(existsSync(file)){const run=(JSON.parse(readFileSync(file,'utf8')) as Run[])[0]!;summary[`${phase}-${mode==='resources'?'idle':'active'}`]={...parseResources(run.resourceText!),daemon:run.resourceText!.includes('\nDaemon\n')?parseResources(run.resourceText!.split('\nDaemon\n')[1]!):null,frames:run.idleFrames,intervals:dist(run.resourceFrames??[])}}
}
const before=`${out}/baseline-profile-dark-0.snapshots.json`,after=`${out}/candidate-profile-dark-0.snapshots.json`
if(existsSync(before)&&existsSync(after)){
 const a=JSON.parse(readFileSync(before,'utf8')),b=JSON.parse(readFileSync(after,'utf8'))
 summary.snapshots={equal:JSON.stringify(a)===JSON.stringify(b),count:a.length}
 if(JSON.stringify(a)!==JSON.stringify(b))throw Error('Sequence-bounded RPC responses differ')
}
writeFileSync(`${out}/summary.json`,JSON.stringify(summary,null,2))
console.log(JSON.stringify(summary,null,2))
