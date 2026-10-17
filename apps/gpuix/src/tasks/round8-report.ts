import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {readFileSync,readdirSync,writeFileSync,existsSync} from 'node:fs'
const out='/Users/mymac/projects/ade/previews/gpuix/round8/drag'
const before=JSON.parse(readFileSync('/Users/mymac/projects/ade/previews/gpuix/round7/tasks7b/comparison.json','utf8'))
const pct=(v:number[],p:number)=>{v.sort((a,b)=>a-b);return +(v[Math.min(v.length-1,Math.floor(v.length*p))]??0).toFixed(2)}
const rows=[]
for(const run of ['carry','carry-repeat'])for(const theme of ['dark','light'])for(const reduce of ['0','1']){
 const label=`${run}-${theme}-${reduce}`,dir=`${out}/${label}-pacing`
 if(!existsSync(dir))continue
 const inputs=JSON.parse(readFileSync(`${out}/${label}-input.json`,'utf8'))
 const trace=readFileSync(`${out}/${label}-frames.log`,'utf8')
 const row:any={run,mode:`${theme}-${reduce==='1'?'reduced':'normal'}`,before:before.comparison.find((r:any)=>r.mode===`${theme}-${reduce==='1'?'reduced':'normal'}`).after,after:{}}
 for(const kind of ['board','list','projects']){
  const prefix=kind==='projects'?'projects-':`tasks-${kind}-`
  const file=readdirSync(dir).filter(f=>f.startsWith(prefix)).sort().at(-1)!
  const {frames,p50,p95,max,pointerToBounds}=JSON.parse(readFileSync(`${dir}/${file}`,'utf8'))
  const times=inputs.find((r:any)=>r.kind===kind).times,duration=(times.at(-1).after-times[0].before)/1000
  const segment=trace.split(`[carry-start] ${kind}\n`)[1]?.split(`[carry-end] ${kind}\n`)[0]??''
  const submits=[...segment.matchAll(/\[kybern-submit\] ([\d.]+)/g)].map(m=>+m[1]!),intervals=submits.slice(1).map((t,i)=>t-submits[i]!)
  row.after[kind]={frames,p50,p95,max,pointerToBounds,inputEvents:times.length,inputEventsPerSecond:+(times.length/duration).toFixed(2),nativeSubmissions:submits.length,nativeSubmissionsPerSecond:+(submits.length/duration).toFixed(2),nativeSubmissionIntervals:{p50:pct(intervals,.5),p95:pct(intervals,.95)}}
 }
 rows.push(row)
}
const resources=[]
for(const repeat of [1,2])for(const kind of ['board','list','projects']){
 const file=`resources-${repeat}-${kind}-resources.txt`;if(!existsSync(`${out}/${file}`))continue
 const text=readFileSync(`${out}/${file}`,'utf8'),match=text.match(/total\s+([\d.]+) MiB\s+cpu\s+([\d.]+)%\s+gpu\s+([\d.]+) ms over ([\d.]+)s/)
 if(!match)throw Error(`Unknown resource format ${file}`)
 const inputs=JSON.parse(readFileSync(`${out}/resources-${repeat}-input.json`,'utf8')).find((r:any)=>r.kind===kind).times
 const duration=(inputs.at(-1).after-inputs[0].before)/1000
 const trace=readFileSync(`${out}/resources-${repeat}-frames.log`,'utf8').split(`[carry-start] ${kind}\n`)[1]?.split(`[carry-end] ${kind}\n`)[0]??''
 const submits=[...trace.matchAll(/\[kybern-submit\] ([\d.]+)/g)].length
 resources.push({repeat,kind,inputEvents:inputs.length,inputEventsPerSecond:+(inputs.length/duration).toFixed(2),nativeSubmissions:submits,nativeSubmissionsPerSecond:+(submits/duration).toFixed(2),motionRecordingSeconds:+duration.toFixed(2),footprintMiB:+match[1]!,cpuPercent:+match[2]!,gpuMs:+match[3]!,seconds:+match[4]!,file})
}
const islandLog=readFileSync(`${out}/islands-full-native.log`,'utf8')
const islands=Object.fromEntries(['board','list','projects'].map(kind=>{const segment=islandLog.split(`[carry-steady] ${kind}\n`)[1]?.split(`[carry-end] ${kind}\n`)[0]??'';return [kind,{islandRenders:(segment.match(/\[islands\] render /g)??[]).length,rootCommits:(segment.match(/\[react-commits\]/g)??[]).length}]}))
const build={nativePatchCommit:execFileSync('git',['log','-1','--format=%H','--','native/patches'],{encoding:'utf8'}).trim(),nativeAddonSHA256:createHash('sha256').update(readFileSync('native/build/gpuix-native.darwin-arm64.node')).digest('hex')}
const report={build,islands,workload:'Apple M1 / macOS 27.0.1 / Bun1.4.0 / GPUIX0.10.0; 17 tasks, 3 projects,1280x820; KYBERN_FULL_RATE=1; no input-frame coalescing; 120 moves 8ms apart; no per-move geometry queries or screenshots. Resource repeats warm the same path10s then sample15s.',limits:['Bounds callbacks and native submissions are not physical presentation fences.','Round7 comparison is historical same-harness evidence; current runs are repeated and translation-only.','Scene.finish generation bump is a safe whole-target redraw when region paint is active.','No subtree rotation: desktop board ghost1degree tilt remains.'],rows,resources,beforeResources:before.resources.after}
writeFileSync(`${out}/comparison.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
