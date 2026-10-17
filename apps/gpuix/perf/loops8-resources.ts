/** Run through pacing-fixture.ts; one short UI-lock lease per sample. */
import path from 'node:path'
import {createHash} from 'node:crypto'
import { appendFileSync, mkdirSync,writeFileSync,readFileSync } from 'node:fs'
import { launchFixture } from './loops8-harness.ts'
import { cpuSeconds, gpuNs, footprintMiB } from '../scripts/idle-metrics.ts'
import { pacingLock } from './loops8-lock.ts'
import {nativeBuildProcesses,waitForNativeBuilds} from './loops8-build-free.ts'
if(process.env.KYBERN_PACING_FIXTURE!=='1')throw Error('Run through perf/pacing-fixture.ts')
const out='/Users/mymac/projects/ade/previews/gpuix/round8/loops'
mkdirSync(out,{recursive:true})
const label=process.argv[2]??'baseline',scene=process.argv[3]??'home'
await waitForNativeBuilds()
const release=await pacingLock()
const beforeSource=false
const stepped=label.startsWith('baseline')
const launchEnv:Record<string,string>={
  GPUIX_BACKGROUND:'1',KYBERN_APPEARANCE:'dark',KYBERN_DEBUG_ISLANDS:'1',KYBERN_FRAME_TIMES:'1',
  KYBERN_PACING_IGNORE_PHYSICAL_MOUSE:'1',
  KYBERN_DEBUG_REGION:'1',KYBERN_GPU_TRACE:process.env.KYBERN_GPU_TRACE??'',
  KYBERN_PACING_BASELINE:beforeSource?'1':'0',KYBERN_NATIVE_PAINT_ANIMATIONS:stepped?'0':'1',
  KYBERN_FULL_RATE:beforeSource?'0':'1',KYBERN_VSYNC_WAKE:beforeSource||label==='region-no-wake'?'0':'1',
  KYBERN_REGION_PAINT:label.includes('region')?'1':'0',KYBERN_SCOPED_BUFFERS:label==='scene-replay'?'0':'1',
  KYBERN_NATIVE_TEXT_PAINT:label.startsWith('text-')?'1':'0',
  NAPI_RS_NATIVE_LIBRARY_PATH:process.env.KYBERN_PACING_ADDON??path.join(import.meta.dir,'../native/build/gpuix-native.darwin-arm64.node'),
  KYBERN_GPUIX_THREAD:['thread','home-running','settled-thread'].includes(scene)?process.env.KYBERN_IDLE_THREAD!:'',
  KYBERN_PACING_RUNNING_ENTRY:'0',
}
if(process.env.KYBERN_PACING_DEFAULTS==='1'||label==='shipping')for(const key of ['KYBERN_NATIVE_PAINT_ANIMATIONS','KYBERN_NATIVE_TEXT_PAINT','KYBERN_FULL_RATE','KYBERN_VSYNC_WAKE','KYBERN_REGION_PAINT','KYBERN_SCOPED_BUFFERS'])delete launchEnv[key]
if(launchEnv.KYBERN_GPU_TRACE!=='1')delete launchEnv.KYBERN_GPU_TRACE
const addonSha256=createHash('sha256').update(readFileSync(launchEnv.NAPI_RS_NATIVE_LIBRARY_PATH!)).digest('hex')
const f=await launchFixture(path.join(import.meta.dir,'loops8-app.ts'),launchEnv).catch(error=>{release();throw error})
try {
  const a=f.app
  await a.getByTestId('app-ready').waitFor({timeoutMs:60000})
  if(scene==='thread'||scene==='home-running')await a.getByTestId('working-header').waitFor({timeoutMs:30000})
  if(scene==='home-running')await a.getByTestId('rail-home').click()
  if(scene==='tasks') {await a.getByTestId('rail-tasks').click();await a.getByTestId('task-filter-all').waitFor();await a.getByTestId('task-filter-all').click();if(await a.getByTestId('task-view-board').count())await a.getByTestId('task-view-board').click();else await a.getByText('Board').click()}
  // A hovered toolbar tooltip introduces a real backdrop filter and correctly
  // selects the full-render fallback. Park input outside controls so it cannot
  // turn a passive-loader resource control into a filtered-overlay workload.
  const window=(await a.call('initialize',{protocolVersion:1,client:'pacing-resource'})).window
  await a.mouse.move({x:window.width-4,y:window.height-4})
  // Warm-up and sample durations are intentional measurements, not UI waits.
  await Bun.sleep(Number(process.env.KYBERN_PACING_WARMUP_MS??10000))
  await waitForNativeBuilds()
  const readyDeadline=Date.now()+5000
  while(!f.observerReady()){if(Date.now()>readyDeadline)throw Error('Window observer did not start');await Bun.sleep(20)}
  const frontRequested=performance.now();process.kill(f.pid,'SIGUSR1')
  while(f.frontAt()<frontRequested||!f.visibilityEvents().at(-1)?.visible){if(Date.now()>readyDeadline)throw Error('Own resource window did not become visible');await Bun.sleep(20)}
  const buildsAtStart=nativeBuildProcesses()
  const windowServer=Number(Bun.spawnSync(['pgrep','-x','WindowServer']).stdout.toString().trim())
  const wsCpu0=windowServer?cpuSeconds(windowServer):0,wsGpu0=windowServer?gpuNs().get(windowServer)??0:0
  const start=performance.now(),cpu0=cpuSeconds(f.pid),gpu0=gpuNs().get(f.pid)??0,c0=f.counts()
  await Bun.sleep(15000)
  const cpu1=cpuSeconds(f.pid),gpu1=gpuNs().get(f.pid)??0,elapsed=(performance.now()-start)/1000,c1=f.counts()
  const sampleEnd=performance.now()
  const visibility=f.visibilityEvents().filter(event=>event.received>=start&&event.received<=sampleEnd)
  const visibleThroughout=visibility.length>100&&visibility.every(event=>event.visible)&&new Set(visibility.map(event=>event.line)).size===1
  const footprint=footprintMiB(f.pid),frameCount=c1.frames-c0.frames,times=frameCount?f.frameTimes().slice(-frameCount):[]
  const dt=times.slice(1).map((t,i)=>t-times[i]!).sort((a,b)=>a-b)
  const buildFree=buildsAtStart.length===0&&nativeBuildProcesses().length===0
  const regionErrors=f.regionEvents().filter(event=>event.received>=start&&event.received<=sampleEnd&&/atlas-backpressure|atlas-error/.test(event.line))
  const result={label,scene,regionErrors,addonSha256,visibleThroughout,valid:regionErrors.length===0&&buildFree&&visibleThroughout&&(stepped||!['thread','home-running','tasks'].includes(scene)||frameCount/(elapsed*60)>.95),buildFree,diagnostic:launchEnv.KYBERN_GPU_TRACE==='1',repeat:Number(process.env.KYBERN_LOOPS_REPEAT??1),at:new Date().toISOString(),taskCount:Number(process.env.KYBERN_PACING_TASKS??4),pid:f.pid,seconds:elapsed,cpuPercent:100*(cpu1-cpu0)/elapsed,gpuMs:(gpu1-gpu0)/1e6,footprintMiB:footprint,windowServerCpuPercent:windowServer?100*(cpuSeconds(windowServer)-wsCpu0)/elapsed:null,windowServerGpuMs:windowServer?((gpuNs().get(windowServer)??0)-wsGpu0)/1e6:null,frames:c1.frames-c0.frames,p50:dt[Math.floor(dt.length*.5)]??null,p95:dt[Math.floor(dt.length*.95)]??null,islandRenders:c1.renders-c0.renders,reactCommits:c1.commits-c0.commits}
  Object.assign(result,{configuration:{nativePaint:launchEnv.KYBERN_NATIVE_PAINT_ANIMATIONS??'default',nativeText:launchEnv.KYBERN_NATIVE_TEXT_PAINT??'default',region:launchEnv.KYBERN_REGION_PAINT??'default',atlas:process.env.KYBERN_REGION_ATLAS??'0',layers:process.env.KYBERN_REGION_LAYERS??'default',direct:process.env.KYBERN_REGION_DIRECT??'1',singleLayer:process.env.KYBERN_REGION_SINGLE_LAYER??'1',rectangles:launchEnv.KYBERN_REGION_PAINT==='0'?'unused':process.env.KYBERN_REGION_RECTS??'1',copyLoad:launchEnv.KYBERN_REGION_PAINT==='0'?'unused':process.env.KYBERN_REGION_COPY_LOAD??'0',split:process.env.KYBERN_GPU_TRACE_SPLIT??'0'},frameCoverage:stepped||!['thread','home-running','tasks'].includes(scene)?null:frameCount/(elapsed*60),maxInterval:dt.at(-1)??null,over50ms:dt.filter(v=>v>50).length,intervals:dt,regions:f.regions(),paintedText:(await a.call('getPaintedText',{})).text})
  const gpuFrames=f.gpuFrames().filter(frame=>frame.received>=start&&frame.received<=start+elapsed*1000)
  const measured=gpuFrames.map(frame=>{const line=frame.line,ms=Number(line.match(/ms=([0-9.]+)/)?.[1]??0);return {ms,stage:line.match(/stage=(\w+)/)?.[1]??'frame',full:line.includes('rect=None'),retained:line.includes('retained=true'),generation:line.match(/generation=(\d+)/)?.[1]}})
  const gpuSummary=Object.fromEntries([...new Set(measured.map(frame=>frame.stage))].map(stage=>{
   const frames=measured.filter(frame=>frame.stage===stage),values=frames.map(frame=>frame.ms).sort((a,b)=>a-b)
   return [stage,{count:frames.length,sum:values.reduce((a,b)=>a+b,0),p50:values[Math.floor(values.length*.5)],p95:values[Math.floor(values.length*.95)],max:values.at(-1),full:frames.filter(frame=>frame.full).length,fallback:frames.filter(frame=>!frame.retained).length,generations:new Set(frames.map(frame=>frame.generation)).size}]
  }))
  Object.assign(result,{gpuSummary,visibility})
  writeFileSync(`${out}/tree-${label}-${scene}-${Date.now()}.json`,JSON.stringify((await a.call('getTree',{})).tree,null,2))
  writeFileSync(`${out}/gpu-${label}-${scene}-${Date.now()}.json`,JSON.stringify(gpuFrames,null,2))
  writeFileSync(`${out}/resources-${label}-${scene}-${Date.now()}.log`,f.diagnostics())
  appendFileSync(`${out}/resources.jsonl`,JSON.stringify(result)+'\n');console.log(JSON.stringify({...result,intervals:undefined,paintedText:undefined,visibility:undefined}))
}finally{await f.close();release()}
