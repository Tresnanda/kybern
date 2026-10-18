import {onExit} from './lifetime.ts'
import path from 'node:path'
import {existsSync,readFileSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import {acquirePreviewUiLock} from '../../scripts/preview-ui-lock.ts'
const queue='/tmp/kybern-gpuix-ui-queue',lock='/tmp/kybern-gpuix-round5-ui-lock'
// Queue mutations intentionally use Python, per the shared perf brief.
function edit(add:boolean,lane:string){execFileSync('python3',['-c',`from pathlib import Path
p=Path(${JSON.stringify(queue)})
a=p.read_text().splitlines() if p.exists() else []
a=[x for x in a if x]
lane=${JSON.stringify(lane)}
if ${add?'True':'False'}:
 if lane not in a:a.append(lane)
else:a=[x for x in a if x!=lane]
p.write_text(chr(10).join(a)+(chr(10) if a else ''))`])}
export async function lease(){
 const root=path.resolve(import.meta.dir,'../../../..')
 if(process.env.KYBERN_PACING_PARENT_LEASE===root){if(readFileSync(`${lock}/owner`,'utf8')!==root)throw Error('Inherited UI lease owner changed');return()=>{}}
 const lane=`perf-bench-${process.pid}`;edit(true,lane)
 let release:(()=>void)|undefined
 let unregister=()=>{}
 const leave=()=>{edit(false,lane);release?.();release=undefined;unregister()}
 unregister=onExit(leave)
 const deadline=Date.now()+60*60_000
 try{while(!release){if(Date.now()>deadline)throw Error('UI lease timeout');if(!readFileSync(queue,'utf8').split('\n').includes(lane))edit(true,lane);const first=readFileSync(queue,'utf8').split('\n').find(Boolean);if(first!==lane||existsSync(lock)){await Bun.sleep(1000);continue}try{release=acquirePreviewUiLock()}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;await Bun.sleep(1000)}}}catch(e){leave();throw e}
 return leave
}
