// Run under quiet.ts. Each shared scenario takes/releases its own UI lease.
import {existsSync,readFileSync,writeFileSync} from 'node:fs'
if(existsSync('native/build/gpu-final-pending'))throw Error('The complete native updater has not passed')
import {onExit} from '../bench/lifetime.ts'
process.env.KYBERN_BENCH_SCREEN_STATE_SCRIPT??='/Users/mymac/projects/ade-gpuix-scratch/screen-state.swift'
const phase=process.argv[2]??'acceptance'
if(!['diagnosis','acceptance','followups'].includes(phase))throw Error('Expected diagnosis, acceptance or followups')
const jobs=[
 {label:'gpu-control',env:{KYBERN_GPU_CLIP_PRUNE:'0'},scenes:['explorer-scroll','markdown-scroll','sidebar-scroll','thread-scroll','pr-changes','streaming','idle-home'],args:['--runs','3']},
 {label:'gpu-after',env:{KYBERN_GPU_CLIP_PRUNE:'1'},scenes:['explorer-scroll','markdown-scroll','sidebar-scroll','thread-scroll','pr-changes','streaming','idle-home'],args:['--runs','3']},
 {label:'gpu-diagnostic-control',env:{KYBERN_GPU_CLIP_PRUNE:'0',KYBERN_GPU_TRACE:'1'},scenes:['explorer-scroll','markdown-scroll','sidebar-scroll','thread-scroll','pr-changes','streaming'],args:['--runs','1','--seconds','5','--warmup','10']},
 {label:'gpu-diagnostic-after',env:{KYBERN_GPU_CLIP_PRUNE:'1',KYBERN_GPU_TRACE:'1'},scenes:['explorer-scroll','markdown-scroll','sidebar-scroll','thread-scroll','pr-changes','streaming'],args:['--runs','1','--seconds','5','--warmup','10']},
]
jobs.sort((a,b)=>Number(!a.label.includes('diagnostic'))-Number(!b.label.includes('diagnostic')))
for(const job of jobs.filter(job=>phase==='diagnosis'?job.label.includes('diagnostic'):phase==='acceptance'?!job.label.includes('diagnostic'):false)){
 const child=Bun.spawn(['bun','perf/bench/run.ts',...job.scenes,...job.args,'--label',job.label,'--keep-data'],{env:{...process.env,NAPI_RS_NATIVE_LIBRARY_PATH:new URL('../../native/build/gpuix-native.darwin-arm64.node',import.meta.url).pathname,...job.env},stdin:'inherit',stdout:'inherit',stderr:'inherit'})
 const unregister=onExit(async()=>{child.kill();await child.exited})
 const code=await child.exited;unregister();if(code)throw Error(`${job.label} failed (${code})`)
 const resultFile=`perf/bench/results/${job.label}.json`;const result=JSON.parse(readFileSync(resultFile,'utf8'));result.gpuLaneControls={clipPrune:Reflect.get(job.env,'KYBERN_GPU_CLIP_PRUNE'),trace:Reflect.get(job.env,'KYBERN_GPU_TRACE')??'0'};writeFileSync(resultFile,JSON.stringify(result,null,2))
 if(result.results.some((row:{status:string;scenario:string;frames:{count:number};resources:{gpuMs:number}})=>row.status!=='ok'||(row.scenario!=='idle-home'&&(row.frames.count<30||row.resources.gpuMs<=0))))throw Error('Discard invalid active window')
}

if(phase==='followups'){
const raw=Bun.spawn(['bun','perf/gpu/markdown-cost.ts'],{env:process.env,stdin:'inherit',stdout:'inherit',stderr:'inherit'});const cleanupRaw=onExit(async()=>{raw.kill();await raw.exited});const rawCode=await raw.exited;cleanupRaw();if(rawCode)throw Error('Raw Markdown comparison failed')

const precise=Bun.spawn(['bun','perf/gpu/precise.ts'],{env:process.env,stdin:'inherit',stdout:'inherit',stderr:'inherit'});const cleanupPrecise=onExit(async()=>{precise.kill();await precise.exited});const preciseCode=await precise.exited;cleanupPrecise();if(preciseCode)throw Error('Precise input controls failed')
}
