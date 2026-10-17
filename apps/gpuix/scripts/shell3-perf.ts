/** One serial idle/Environment-motion sample. Own scratch only; no model turns. */
import {spawn} from 'node:child_process'
import {connectStdio} from '@gpuix/react/automation'
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs'
import path from 'node:path'
import {SCRATCH,DATA_DIR,CLIENT_DIR,CREDS_DIR} from '../visual/fixture.ts'
import {readConversationIds} from '../visual/fixture.conversation.ts'
import {OUT,waitUntil,exists} from './shell3-lib.ts'
const up=JSON.parse(readFileSync(`${SCRATCH}/shell3-up.json`,'utf8'))
const trace=`${OUT}/native-submissions.log`;writeFileSync(trace,'')
const child=spawn('bun',[path.resolve(import.meta.dir,'../src/main.tsx')],{stdio:['pipe','pipe','pipe'],env:{...process.env,GPUIX_BACKGROUND:'1',KYBERN_OPAQUE:'1',KYBERN_APPEARANCE:'dark',KYBERN_DATA_DIR:DATA_DIR,KYBERN_URL:up.proxy,KYBERN_CLIENT_CONFIG_DIR:CLIENT_DIR,KYBERN_GPUIX_CREDENTIALS_DIR:CREDS_DIR,KYBERN_GPUIX_THREAD:readConversationIds()['Long review thread'],KYBERN_FRAME_TIMES:'1'}})
child.stderr.on('data',chunk=>appendFileSync(trace,chunk))
const app=await connectStdio({write:chunk=>{child.stdin.write(chunk)},feed:listener=>child.stdout.on('data',chunk=>listener(String(chunk))),close:async()=>{child.kill()}})
const watchdog=setTimeout(()=>child.kill(),90000)
const readFrames=()=>readFileSync(trace,'utf8').split('\n').flatMap(line=>{const m=/\[kybern-frame\] ([\d.]+)/.exec(line);return m?[Number(m[1])]:[]})
const bursts:number[][]=[]
const sample=async(label:string,active=false)=>{
 const worker=Bun.spawn(['rtk','proxy','bun',path.resolve(import.meta.dir,'../perf/sample.ts'),'15',`GPUIX=${child.pid}`],{stdout:'pipe',stderr:'pipe'})
 const end=Date.now()+15000
 if(active)while(Date.now()<end){await app.getByTestId('environment-toggle').hover();await Bun.sleep(180);const first=readFrames().length;await app.getByTestId('environment-toggle').click();await Bun.sleep(350);bursts.push(readFrames().slice(first));await Bun.sleep(270)}
 const result=await new Response(worker.stdout).text(),error=await new Response(worker.stderr).text()
 if(await worker.exited)throw Error(error)
 writeFileSync(`${OUT}/perf-${label}.txt`,result);console.log(label,result)
}
try{
 await app.getByTestId('app-ready').waitFor({timeoutMs:30000})
 await waitUntil(exists(app,'transcript-surface'),15000,'transcript')
 await Bun.sleep(3000)
 console.log('SAMPLE_START',child.pid)
 await sample('idle')
 const begin=Date.now();await sample('environment-active',true)
 const frames=readFrames()
 const deltas=bursts.flatMap(times=>times.slice(1).map((t,i)=>t-times[i]!)).sort((a,b)=>a-b)
 const timing={kind:'scene submissions during 350ms open/close bursts, not compositor presentations',frames:frames.length,motionBursts:bursts.map(times=>times.length),p50:deltas[Math.floor(deltas.length*.5)]??null,p95:deltas[Math.floor(deltas.length*.95)]??null,max:deltas.at(-1)??null,activeStartedAt:begin,intervals:deltas,excluded:'No interval filtering; gaps between separate pointer gestures are outside the sampled bursts. Full raw trace retained.'}
 writeFileSync(`${OUT}/native-submissions-summary.json`,JSON.stringify(timing,null,2));console.log('TIMING',JSON.stringify(timing))
}finally{clearTimeout(watchdog);await app.close();if(child.exitCode===null)child.kill()}
