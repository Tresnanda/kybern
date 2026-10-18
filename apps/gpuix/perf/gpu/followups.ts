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
