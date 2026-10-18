import {requireScreen,keepDisplayAwake} from './screen-state.ts'
import {onExit} from './lifetime.ts'
import path from 'node:path'
import {existsSync,readFileSync,writeFileSync,unlinkSync,openSync,closeSync,readdirSync} from 'node:fs'
import {execFileSync,spawnSync} from 'node:child_process'
import {acquirePreviewUiLock} from '../../scripts/preview-ui-lock.ts'
const queue='/tmp/kybern-gpuix-ui-queue',lock='/tmp/kybern-gpuix-round5-ui-lock'
const watcher=path.join(import.meta.dir,'lease-watch.py')
// Queue mutations intentionally use serialized Python, per the shared brief.
function edit(add:boolean,lane:string){execFileSync('python3',['-c',`import pathlib,sys,fcntl,os
p=pathlib.Path(sys.argv[1]);p.touch(exist_ok=True)
with p.open('r+') as f:
 fcntl.flock(f,fcntl.LOCK_EX)
 a=[x for x in f.read().splitlines() if x];lane=sys.argv[2]
 if sys.argv[3]=='join' and lane not in a:a.append(lane)
 if sys.argv[3]=='leave':a=[x for x in a if x!=lane]
 f.seek(0);f.write(''.join(x+'\\n' for x in a));f.truncate()
`,queue,lane,add?'join':'leave'])}
export function cleanupStaleLease(root:string){
 const reap=(pid:number,token?:string)=>execFileSync('python3',[watcher,'reap',String(pid),root,`perf-bench-${pid}`,lock,queue,...(token?[token]:[])])
 try{
  if(existsSync(`${lock}/owner`)&&readFileSync(`${lock}/owner`,'utf8')===root&&existsSync(`${lock}/bench-pid`))reap(Number(readFileSync(`${lock}/bench-pid`,'utf8')))
 }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}
 for(const name of readdirSync('/tmp').filter(name=>name.startsWith('kybern-gpuix-lease-token.'))){
  const file=`/tmp/${name}`
  try{const prior=JSON.parse(readFileSync(file,'utf8'));if(prior.root===root)reap(prior.pid,file)}catch(e){if(e instanceof SyntaxError)continue;if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}
 }
}
export async function lease(){
 const headless=process.env.CADENCE_HEADLESS_LEASE_TEST==='1'
 if(!headless)requireScreen()
 const root=path.resolve(import.meta.dir,'../../../..')
 if(process.env.KYBERN_PACING_PARENT_LEASE===root){if(readFileSync(`${lock}/owner`,'utf8')!==root)throw Error('Inherited UI lease owner changed');return()=>{}}
 cleanupStaleLease(root)
 const lane=`perf-bench-${process.pid}`
 const token=`/tmp/kybern-gpuix-lease-token.${process.pid}.${crypto.randomUUID()}`,log=`/tmp/kybern-gpuix-lease-watch.${process.pid}.log`,fd=openSync(log,'w')
 writeFileSync(token,JSON.stringify({root,pid:process.pid,lane}))
 const guardian=spawnSync('python3',[watcher,'watch',String(process.pid),root,lane,lock,queue,token],{stdio:['ignore','ignore',fd]});closeSync(fd)
 if(guardian.status!==0){unlinkSync(token);edit(false,lane);throw Error(`Lease guardian failed: ${readFileSync(log,'utf8')}`)}
 let stopAwake=()=>{}
 let release:(()=>void)|undefined
 let unregister=()=>{}
 const leave=()=>{stopAwake();if(existsSync(token))unlinkSync(token);if(existsSync(log))unlinkSync(log);edit(false,lane);if(release&&existsSync(`${lock}/bench-pid`))unlinkSync(`${lock}/bench-pid`);release?.();release=undefined;unregister()}
 unregister=onExit(leave)
 edit(true,lane)
 const deadline=Date.now()+60*60_000
 try{while(!release){if(Date.now()>deadline)throw Error('UI lease timeout');if(!readFileSync(queue,'utf8').split('\n').includes(lane))edit(true,lane);const first=readFileSync(queue,'utf8').split('\n').find(Boolean);if(first!==lane||existsSync(lock)){await Bun.sleep(1000);continue}try{release=acquirePreviewUiLock();writeFileSync(`${lock}/bench-pid`,String(process.pid))}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;await Bun.sleep(1000)}}}catch(e){leave();throw e}
 if(!headless){try{requireScreen();stopAwake=keepDisplayAwake()}catch(e){leave();throw e}}
 return leave
}
