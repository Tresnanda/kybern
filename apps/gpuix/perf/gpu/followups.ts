// Reverse the acceptance order to investigate streaming's longer interval tail.
import {readFileSync,writeFileSync,existsSync} from 'node:fs'
import {onExit} from '../bench/lifetime.ts'
process.env.KYBERN_BENCH_SCREEN_STATE_SCRIPT??='/Users/mymac/projects/ade-gpuix-scratch/screen-state.swift'
if(existsSync('native/build/gpu-final-pending'))throw Error('Native validation incomplete')
// Validate harness edits before seeding/warmup, never during a resource sample.
const check=Bun.spawnSync(['pnpm','exec','tsc','-p','perf/gpu/tsconfig.json'],{stdout:'pipe',stderr:'pipe'})
writeFileSync('/Users/mymac/projects/ade/previews/gpuix/perf/gpu/gpu-tooling-typecheck.log',check.stdout.toString()+check.stderr.toString())
if(check.exitCode)throw Error('GPU harness typecheck failed')
async function run(args:string[],env:Record<string,string|undefined>={}){
 const child=Bun.spawn(['bun',...args],{env:{...process.env,...env},stdin:'inherit',stdout:'inherit',stderr:'inherit'})
 const cleanup=onExit(async()=>{child.kill();await child.exited})
 const code=await child.exited;cleanup();if(code)throw Error(`Follow-up failed (${code})`)
}
await run(['perf/gpu/precise.ts'])
for(const prune of ['1','0']){
 const label=`gpu-stream-reverse-${prune}`
 await run(['perf/bench/run.ts','streaming','--runs','3','--label',label,'--keep-data'],{NAPI_RS_NATIVE_LIBRARY_PATH:new URL('../../native/build/gpuix-native.darwin-arm64.node',import.meta.url).pathname,KYBERN_GPU_CLIP_PRUNE:prune})
 const file=`perf/bench/results/${label}.json`,result=JSON.parse(readFileSync(file,'utf8'))
 if(result.results.some((row:{status:string;frames:{count:number};resources:{gpuMs:number}})=>row.status!=='ok'||row.frames.count<30||row.resources.gpuMs<=0))throw Error('Discard invalid active streaming window')
 result.gpuLaneControls={clipPrune:prune,trace:'0'};writeFileSync(file,JSON.stringify(result,null,2))
}
const median=(xs:number[])=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)]!
const p95=(prune:string)=>median(JSON.parse(readFileSync(`perf/bench/results/gpu-stream-reverse-${prune}.json`,'utf8')).results.map((row:{frames:{p95:number}})=>row.frames.p95))
const verdict={controlP95:p95('0'),prunedP95:p95('1'),repeatOrder:'pruned then control',thresholdMs:1.5}
writeFileSync('/Users/mymac/projects/ade/previews/gpuix/perf/gpu/streaming-repeat.json',JSON.stringify(verdict,null,2))
if(verdict.prunedP95>verdict.controlP95+verdict.thresholdMs)throw Error('Streaming frame tail regression repeated; review scope before final acceptance')
const end=readFileSync('/tmp/kybern-gpuix-quiet.perf-gpu','utf8').match(/expected_end=(\S+)/)?.[1]
if(!end||Date.parse(end)-Date.now()<17*60_000)throw Error('Requeue final acceptance in a fresh bounded quiet window')
// Recheck the complete acceptance pair with the explicit unlocked/awake gates.
await run(['perf/gpu/measure.ts','acceptance'],{KYBERN_GPU_FINAL_ACCEPTANCE:'1'})
