/** Run one bounded clip7 capture batch in the shared fair UI queue. */
import {existsSync,readFileSync,writeFileSync,appendFileSync} from 'node:fs'
import {acquirePreviewUiLock} from '../scripts/preview-ui-lock.ts'
const queue='/tmp/kybern-gpuix-ui-queue'
const lines=()=>existsSync(queue)?readFileSync(queue,'utf8').trim().split('\n').filter(Boolean):[]
if(!lines().includes('clip7'))appendFileSync(queue,'clip7\n')
while(lines()[0]!=='clip7'||existsSync('/tmp/kybern-gpuix-round5-ui-lock'))await Bun.sleep(1000)
const release=acquirePreviewUiLock()
try{
 const child=Bun.spawn(process.argv.slice(2),{env:{...process.env,KYBERN_CLIP_LOCK_HELD:'1'},stdout:'inherit',stderr:'inherit',stdin:'inherit'})
 process.exitCode=await child.exited
}finally{
 release();const current=lines(),index=current.indexOf('clip7');if(index>=0)current.splice(index,1);writeFileSync(queue,current.join('\n')+(current.length?'\n':''))
}
