import '../src/native/local-build.ts'
import {mkdirSync,writeFileSync} from 'node:fs'
import path from 'node:path'
import {launchFixture,waitForPainted} from '../src/requests/harness.ts'
import {acquirePreviewUiLock} from '../scripts/preview-ui-lock.ts'
const output=process.env.KYBERN_VERIFY_OUTPUT??path.join(import.meta.dir,'build/explorer-motion-perf');mkdirSync(output,{recursive:true})
const release=process.env.KYBERN_CLIP_LOCK_HELD?()=>{}:acquirePreviewUiLock()
try{
 for(const theme of ['dark','light'])for(const reduced of ['0','1']){
  const f=await launchFixture(path.join(import.meta.dir,'explorer-motion-lab.tsx'),{GPUIX_BACKGROUND:'1',KYBERN_APPEARANCE:theme,KYBERN_REDUCED_MOTION:reduced,KYBERN_FRAME_TIMES:'1',KYBERN_FULL_RATE:'1'})
  try{
   const a=f.app;await a.getByTestId('ready').waitFor();await waitForPainted(a,'Toggle rotation')
   const before=Number(await a.getByTestId('done').textContent()),start=f.frameTimes().length,deadline=Date.now()+10000
   await a.getByTestId('toggle').click();await a.getByTestId('physical').click()
   while(Number(await a.getByTestId('done').textContent())<before+3){if(Date.now()>deadline)throw Error('Native motion did not settle');await Bun.sleep(8)}
   const times=f.frameTimes().slice(start),dt=times.slice(1).map((v,i)=>v-times[i]!).filter(v=>v>0).sort((a,b)=>a-b)
   const result={theme,reduced:reduced==='1',frames:times.length,p50:dt[Math.floor(dt.length*.5)]??null,p95:dt[Math.floor(dt.length*.95)]??null,intervals:dt,stallsOver100ms:dt.filter(v=>v>=100).length,runtime:'background native window; KYBERN_FULL_RATE=1; no screenshots; submission timestamps, not display scanout'}
   writeFileSync(path.join(output,`${theme}-${reduced==='1'?'reduced':'normal'}-timing.json`),JSON.stringify(result,null,2));console.log(result)
  }finally{await f.close()}
 }
}finally{release()}
