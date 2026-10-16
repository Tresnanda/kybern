import '../src/native/local-build.ts'
import {writeFileSync,mkdirSync} from 'node:fs'
import path from 'node:path'
import {launchFixture,waitForPainted} from '../src/requests/harness.ts'
import {acquirePreviewUiLock} from '../scripts/preview-ui-lock.ts'
const output=process.env.KYBERN_VERIFY_OUTPUT??path.join(import.meta.dir,'build/clip-perf');mkdirSync(output,{recursive:true})
const release=process.env.KYBERN_CLIP_LOCK_HELD?()=>{}:acquirePreviewUiLock()
try{
 for(const build of ['before','after']) {
  const library=path.join(import.meta.dir,'build',build==='before'?'clip-baseline.node':'gpuix-native.darwin-arm64.node')
  const f=await launchFixture(path.join(import.meta.dir,'clip-lab.tsx'),{GPUIX_BACKGROUND:'1',KYBERN_APPEARANCE:'dark',KYBERN_REDUCED_MOTION:'0',KYBERN_FRAME_TIMES:'1',KYBERN_FULL_RATE:'1',NAPI_RS_NATIVE_LIBRARY_PATH:library})
  try{
   const a=f.app;await a.getByTestId('ready').waitFor();await waitForPainted(a,'Turn 0');const scrollPoint=await a.getByTestId('long-transcript-frame').center()
   for(const workload of ['idle','scroll']) {
    const start=performance.now(),frameStart=f.frameTimes().length
    const sample=Bun.spawn(['bun','perf/sample.ts','15',`GPUIX=${f.pid}`],{stdout:'pipe',stderr:'pipe'})
    let wheels=0
    if(workload==='scroll')while(performance.now()-start<15000){await a.mouse.wheel(scrollPoint,0,wheels%100<50?-32:32);wheels++;await Bun.sleep(8)}
    const result=await new Response(sample.stdout).text();await sample.exited
    const times=f.frameTimes().slice(frameStart)
    const intervals=times.slice(1).map((t,i)=>t-times[i]!).filter(t=>t>0),sorted=[...intervals].sort((a,b)=>a-b),stallFree=sorted.filter(t=>t<100)
    const stats={build,workload,wheels,elapsedMs:performance.now()-start,frameIntervals:intervals,frameCount:times.length,p50:sorted[Math.floor(sorted.length*.5)]??null,p95:sorted[Math.floor(sorted.length*.95)]??null,stallsOver100ms:sorted.filter(t=>t>=100).length,stallFreeP50:stallFree[Math.floor(stallFree.length*.5)]??null,stallFreeP95:stallFree[Math.floor(stallFree.length*.95)]??null,sample:result}
    writeFileSync(path.join(output,`${build}-${workload}.json`),JSON.stringify(stats,null,2));const {frameIntervals,...summary}=stats;console.log(summary)
   }
  }finally{await f.close()}
 }
}finally{release()}
