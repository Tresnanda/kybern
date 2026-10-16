import {appendFileSync,existsSync,readFileSync,writeFileSync} from 'node:fs'
import {acquirePreviewUiLock} from './preview-ui-lock.ts'
import {until} from './dock-waits.ts'
const queue='/tmp/kybern-gpuix-ui-queue'
if(!existsSync(queue)||!readFileSync(queue,'utf8').split('\n').includes('dock7b'))appendFileSync(queue,'dock7b\n')
console.log('dock7b queued')
let release:(()=>void)|undefined
await until(async()=>{if(readFileSync(queue,'utf8').trim().split('\n')[0]!=='dock7b')return false;try{release=acquirePreviewUiLock();return true}catch{return false}},'UI lock',30*60000)
try{const child=Bun.spawn(['bun',...process.argv.slice(2)],{stdout:'inherit',stderr:'inherit'});if(await child.exited)throw Error('Fixture failed')}finally{release?.();writeFileSync(queue,readFileSync(queue,'utf8').split('\n').filter(x=>x&&x!=='dock7b').join('\n')+'\n')}
