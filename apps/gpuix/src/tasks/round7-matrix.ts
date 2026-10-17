import {readFileSync,writeFileSync} from 'node:fs'
import {acquirePreviewUiLock} from '../../scripts/preview-ui-lock.ts'
const queue='/tmp/kybern-gpuix-ui-queue'
if(readFileSync(queue,'utf8').trim().split('\n')[0]!=='tasks7')throw Error('tasks7 is not first in the UI queue')
const unlock=acquirePreviewUiLock()
const out='/Users/mymac/projects/ade/previews/gpuix/round7/tasks'
try {
 matrix: for(const theme of ['dark','light'])for(const reduce of [false,true])for(const width of [1280,1920]){
  const label=`${theme}-${reduce?'reduced':'normal'}-${width}`
  const child=Bun.spawn(['bun','src/tasks/round7-check.ts',...(width===1920?['--visual']:[])],{env:{...process.env,R7_LOCK_HELD:'1',R7_LABEL:label,R7_SAMPLE:label==='dark-normal-1280'?'1':'0',KYBERN_APPEARANCE:theme,KYBERN_REDUCED_MOTION:reduce?'1':'0',KYBERN_WINDOW_SIZE:`${width}x820`},stdout:'pipe',stderr:'pipe'})
  const stdout=new Response(child.stdout).text(), stderr=new Response(child.stderr).text()
  const code=await child.exited
  writeFileSync(`${out}/${label}-check.log`,await stdout+'\n'+await stderr)
  console.log(label,code)
  if(code){process.exitCode=1;break matrix}
 }
 if(!process.exitCode){const ref=Bun.spawn(['node','src/tasks/round7-tauri.mjs'],{stdout:'pipe',stderr:'pipe'})
 const stdout=new Response(ref.stdout).text(),stderr=new Response(ref.stderr).text()
 const code=await ref.exited;if(code)process.exitCode=code;writeFileSync(`${out}/tauri-check.log`,await stdout+'\n'+await stderr)}
}finally{
 unlock()
 writeFileSync(queue,readFileSync(queue,'utf8').split('\n').filter(line=>line!=='tasks7').join('\n'))
}
