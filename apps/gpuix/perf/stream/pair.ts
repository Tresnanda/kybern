import {mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import path from 'node:path'
import {onExit} from '../bench/lifetime.ts'
import {lease} from '../bench/lease.ts'
const root=path.resolve(import.meta.dir,'../..')
const out='/Users/mymac/projects/ade/previews/gpuix/perf/stream'
mkdirSync(out,{recursive:true})
const stages:Record<string,string[]>={before:['0','0','0'],isolated:['1','0','0'],framed:['1','1','0'],documents:['1','1','1']}
const args=process.argv.slice(2),final=args.includes('--final'),wheel=args.includes('--wheel'),short=args.includes('--short')
const repeats=final&&wheel?3:1
const selected=args.filter(a=>!a.startsWith('--'))
const files=['src/state.ts','src/subagents/Page.tsx','src/transcript/store.ts','src/transcript/rows.tsx','src/transcript/streamBlocks.ts','src/transcript/streamDocument.ts','src/transcript/StreamMarkdown.tsx','perf/bench/app.ts','perf/bench/scenarios.ts']
writeFileSync(path.join(out,`manifest-${final?'final':'stages'}-${wheel?'wheel':'stream'}.json`),JSON.stringify({at:new Date().toISOString(),files:Object.fromEntries(files.map(f=>[f,createHash('sha256').update(readFileSync(path.join(root,f))).digest('hex')])),stages,repeats,warmupSeconds:10,resourceSeconds:short?5:15,addon:process.env.NAPI_RS_NATIVE_LIBRARY_PATH??'checkout default',fullRate:1},null,2))
const release=final?await lease():undefined
const unlease=release?onExit(release):()=>{}
const watchdog=release?setTimeout(()=>process.kill(process.pid,'SIGTERM'),250000):undefined
try { for(const name of selected.length?selected:final?['before','documents']:Object.keys(stages)){
 const stage=stages[name];if(!stage)throw Error('Unknown stage '+name)
 const label=`${final?'final':'stage2'}-${name}-${wheel?'wheel':'stream'}${short?'-short':''}`
 const child=Bun.spawn(['bun',path.join(root,'perf/bench/run.ts'),'streaming','--runs',String(repeats),'--label',label,'--keep-data',...(short?['--seconds','5']:[])],{cwd:root,env:{...process.env,...(release?{KYBERN_PACING_PARENT_LEASE:path.resolve(root,'../..')}:{}),KYBERN_DATA_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-stream',KYBERN_BENCH_PORT:'4330',KYBERN_BENCH_EVIDENCE:out,KYBERN_FULL_RATE:'1',KYBERN_BENCH_STREAM_HISTORY:'1',KYBERN_BENCH_STREAM_CATCHUP:'1',KYBERN_BENCH_STREAM_SCROLL:wheel?'1':'0',KYBERN_STREAM_ISOLATE:stage[0],KYBERN_STREAM_EVENT_FRAME:stage[1],KYBERN_STREAM_DOCUMENT:stage[2]},stdout:'inherit',stderr:'inherit'})
 const remove=onExit(async()=>{child.kill('SIGTERM');await child.exited})
 const code=await child.exited;remove();if(code)throw Error(`${label} failed (${code})`)
} } finally {clearTimeout(watchdog);release?.();unlease()}
