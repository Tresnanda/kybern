// Run one width per queued UI lease (each batch stays below five minutes).
import {writeFileSync} from 'node:fs'
const width=process.argv[2]??'1280',out='/Users/mymac/projects/ade/previews/gpuix/round8/drag'
for(const theme of ['dark','light'])for(const reduced of ['0','1']){
 const label=`${theme}-${reduced==='1'?'reduced':'normal'}-${width}`
 const child=Bun.spawn(['bun','src/tasks/round7b-check.ts'],{env:{...process.env,R8_DATA:'/Users/mymac/projects/ade-gpuix-scratch/round8-drag',R8_OUT:out,R8_LANE:'drag8',R7_LOCK_HELD:'1',R7_LABEL:label,KYBERN_APPEARANCE:theme,KYBERN_REDUCED_MOTION:reduced,KYBERN_FULL_RATE:'1',KYBERN_WINDOW_SIZE:`${width}x820`},stdout:'pipe',stderr:'pipe'})
 const stdout=new Response(child.stdout).text(),stderr=new Response(child.stderr).text(),code=await child.exited
 writeFileSync(`${out}/${label}-check.log`,await stdout+'\n'+await stderr)
 console.log(label,code);if(code)throw Error(`Regression failed: ${label}`)
}
