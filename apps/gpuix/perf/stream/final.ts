import {existsSync,readFileSync,rmSync} from 'node:fs'
import {onExit} from '../bench/lifetime.ts'
const gate='/Users/mymac/projects/ade/previews/gpuix/perf/stream/run-final.json'
while(!existsSync(gate))await Bun.sleep(1000)
const {winner}=JSON.parse(readFileSync(gate,'utf8')) as {winner:string}
rmSync(gate)
if(!['isolated','framed','documents'].includes(winner))throw Error('Invalid final variant')
async function run(args:string[],env:Record<string,string|undefined>={}){
 const child=Bun.spawn(['bun',...args],{env:{...process.env,...env},stdout:'inherit',stderr:'inherit'})
 const stop=onExit(async()=>{child.kill('SIGTERM');await child.exited})
 const code=await child.exited;stop();if(code)throw Error(`Final command failed (${code})`)
}
await run(['perf/stream/pair.ts','before',winner,'--final','--wheel'])
await run(['perf/stream/pair.ts','before',winner,'--final'])
for(const variant of ['before',winner])await run(['perf/bench/run.ts','idle-thread','--runs','1','--label',`final-${variant}-idle`,'--keep-data'],{
 KYBERN_DATA_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-stream',KYBERN_BENCH_PORT:'4330',KYBERN_BENCH_EVIDENCE:'/Users/mymac/projects/ade/previews/gpuix/perf/stream',KYBERN_FULL_RATE:'1',
 KYBERN_STREAM_ISOLATE:variant==='before'?'0':'1',KYBERN_STREAM_EVENT_FRAME:['framed','documents'].includes(variant)?'1':'0',KYBERN_STREAM_DOCUMENT:variant==='documents'?'1':'0',
})
