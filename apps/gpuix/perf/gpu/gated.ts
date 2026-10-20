// Final narrowed candidate: precise source control, trace attribution and the
// complete three-repeat shared bench in one bounded, build-free quiet window.
import {onExit} from '../bench/lifetime.ts'
import {writeFileSync,existsSync} from 'node:fs'
if(existsSync('native/build/gpu-final-pending'))throw Error('Complete native updater has not passed')
const check=Bun.spawnSync(['pnpm','exec','tsc','-p','perf/gpu/tsconfig.json'],{stdout:'pipe',stderr:'pipe'})
writeFileSync('/Users/mymac/projects/ade/previews/gpuix/perf/gpu/gpu-tooling-typecheck.log',check.stdout.toString()+check.stderr.toString())
if(check.exitCode)throw Error('GPU harness typecheck failed before warmup')
async function run(args:string[],extra:Record<string,string>={}){
 const child=Bun.spawn(['bun',...args],{env:{...process.env,KYBERN_GPU_ACCEPTANCE_PREFIX:'gpu-gated',KYBERN_BENCH_STREAM_CATCHUP:'1',...extra},stdin:'inherit',stdout:'inherit',stderr:'inherit'})
 const cleanup=onExit(async()=>{child.kill();await child.exited})
 const code=await child.exited;cleanup();if(code)throw Error(`Gated candidate validation failed (${code})`)
}
await run(['perf/gpu/precise.ts'],{KYBERN_GPU_PRECISE_LABEL:'precise-gated'})
await run(['perf/gpu/measure.ts','diagnosis'])
await run(['perf/gpu/measure.ts','acceptance'])
