import {requireScreen} from '../bench/screen-state.ts'
// Reuse the earlier lanes' independent native-thread NSEvent producers.
import path from 'node:path'
import {mkdirSync,existsSync,readFileSync,rmSync,writeFileSync} from 'node:fs'
import {spawn} from 'node:child_process'
import {lease} from '../bench/lease.ts'
import {onExit} from '../bench/lifetime.ts'
const app=path.resolve(import.meta.dir,'../..'),evidence='/Users/mymac/projects/ade/previews/gpuix/perf/cadence/original-harnesses'
mkdirSync(evidence,{recursive:true})
const before=process.env.CADENCE_SOURCE==='before',label=`${before?'before':'after'}${process.env.SIDEBAR_VISUAL==='1'?'-visual':''}`
const env={...process.env,CADENCE_VISIBILITY_CONTROL:before?'1':'0',KYBERN_FULL_RATE:'1'}
async function run(args:string[],extra:Record<string,string>={}){const child=Bun.spawn(args,{cwd:app,env:{...env,...extra},stdout:'inherit',stderr:'inherit'});const stop=onExit(async()=>{child.kill();await child.exited});const code=await child.exited;stop();if(code)throw Error(`${args.join(' ')} exited ${code}`)}
await run(['clang','-dynamiclib','-fobjc-arc','-framework','AppKit','perf/explorer/wheel.m','-o','perf/explorer/wheel.dylib'])
{
 const release=await lease()
 try{await run(['bun','perf/scroll2/fixture.ts','--','bun','perf/scroll2/sidebar.ts',`cadence-${label}`],{SCROLL2_DATA_DIR:'/Users/mymac/projects/ade-gpuix-scratch/perf-cadence-sidebar',SCROLL2_PORT:'4334',SCROLL2_EVIDENCE:path.join(evidence,'sidebar')})}finally{try{requireScreen()}finally{release()}}
}
const data='/Users/mymac/projects/ade-gpuix-scratch/perf-cadence-explorer'
mkdirSync(data,{recursive:true})
if(existsSync(path.join(data,'daemon.port')))throw Error('Scratch Explorer fixture already exists')
const daemon=spawn('/Applications/kybern.app/Contents/MacOS/kybernd',['--data-dir',data,'--port','4334'],{stdio:'ignore'})
const stopDaemon=onExit(()=>{daemon.kill()})
try{
 const deadline=Date.now()+30000;while(!existsSync(path.join(data,'daemon.port'))){if(Date.now()>deadline||daemon.exitCode!==null)throw Error('Scratch daemon failed');await Bun.sleep(30)}
 const extra={KYBERN_DATA_DIR:data,KYBERN_CLIENT_CONFIG_DIR:path.join(data,'client'),KYBERN_URL:'',KYBERN_TOKEN:'',EXPLORER_EVIDENCE:path.join(evidence,'explorer'),EXPLORER_SCENES:'tree,preview.md'}
 await run(['bun','perf/explorer/seed.ts'],extra)
 const release=await lease()
 try{await run(['bun','perf/explorer/run.ts',`cadence-${label}`],extra)}finally{try{requireScreen()}finally{release()}}
}finally{stopDaemon();daemon.kill();if(daemon.exitCode===null&&daemon.signalCode===null)await new Promise<void>(resolve=>daemon.once('exit',()=>resolve()));rmSync(data,{recursive:true,force:true})}
