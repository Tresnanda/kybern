/** Run through pacing-fixture.ts; one short UI-lock lease per sample. */
import path from 'node:path'
import { appendFileSync, mkdirSync,writeFileSync } from 'node:fs'
import { launchFixture } from '../native/frame-harness.ts'
import { cpuSeconds, gpuNs, footprintMiB } from '../scripts/idle-metrics.ts'
import { pacingLock } from './pacing-lock.ts'
if(process.env.KYBERN_PACING_FIXTURE!=='1')throw Error('Run through perf/pacing-fixture.ts')
const out='/Users/mymac/projects/ade/previews/gpuix/round7/pacing'
mkdirSync(out,{recursive:true})
const label=process.argv[2]??'baseline',scene=process.argv[3]??'home'
const release=await pacingLock()
const beforeSource=label==='baseline'
const launchEnv:Record<string,string>={
  GPUIX_BACKGROUND:'1',KYBERN_APPEARANCE:'dark',KYBERN_DEBUG_ISLANDS:'1',KYBERN_FRAME_TIMES:'1',
  KYBERN_PACING_IGNORE_PHYSICAL_MOUSE:'1',
  KYBERN_DEBUG_REGION:'1',
  KYBERN_PACING_BASELINE:beforeSource?'1':'0',KYBERN_NATIVE_PAINT_ANIMATIONS:beforeSource?'0':'1',
  KYBERN_FULL_RATE:beforeSource?'0':'1',KYBERN_VSYNC_WAKE:beforeSource||label==='region-no-wake'?'0':'1',
  KYBERN_REGION_PAINT:label.includes('region')?'1':'0',KYBERN_SCOPED_BUFFERS:label==='scene-replay'?'0':'1',
  KYBERN_NATIVE_TEXT_PAINT:label.startsWith('text-')?'1':'0',
  NAPI_RS_NATIVE_LIBRARY_PATH:process.env.KYBERN_PACING_ADDON??path.join(import.meta.dir,'../native/build/gpuix-native.darwin-arm64.node'),
  KYBERN_GPUIX_THREAD:['thread','home-running','settled-thread'].includes(scene)?process.env.KYBERN_IDLE_THREAD!:'',
  KYBERN_PACING_RUNNING_ENTRY:'0',
}
if(process.env.KYBERN_PACING_DEFAULTS==='1'||label==='shipping')for(const key of ['KYBERN_NATIVE_PAINT_ANIMATIONS','KYBERN_NATIVE_TEXT_PAINT','KYBERN_FULL_RATE','KYBERN_VSYNC_WAKE','KYBERN_REGION_PAINT','KYBERN_SCOPED_BUFFERS'])delete launchEnv[key]
const f=await launchFixture(path.join(import.meta.dir,'pacing-app.ts'),launchEnv)
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
  const start=performance.now(),cpu0=cpuSeconds(f.pid),gpu0=gpuNs().get(f.pid)??0,c0=f.counts()
  await Bun.sleep(15000)
  const cpu1=cpuSeconds(f.pid),gpu1=gpuNs().get(f.pid)??0,elapsed=(performance.now()-start)/1000,c1=f.counts()
  const footprint=footprintMiB(f.pid),frameCount=c1.frames-c0.frames,times=frameCount?f.frameTimes().slice(-frameCount):[]
  const dt=times.slice(1).map((t,i)=>t-times[i]!).sort((a,b)=>a-b)
  const result={label,scene,taskCount:Number(process.env.KYBERN_PACING_TASKS??4),pid:f.pid,seconds:elapsed,cpuPercent:100*(cpu1-cpu0)/elapsed,gpuMs:(gpu1-gpu0)/1e6,footprintMiB:footprint,frames:c1.frames-c0.frames,p50:dt[Math.floor(dt.length*.5)]??null,p95:dt[Math.floor(dt.length*.95)]??null,islandRenders:c1.renders-c0.renders,reactCommits:c1.commits-c0.commits}
  Object.assign(result,{configuration:{nativePaint:launchEnv.KYBERN_NATIVE_PAINT_ANIMATIONS??'default',nativeText:launchEnv.KYBERN_NATIVE_TEXT_PAINT??'default',region:launchEnv.KYBERN_REGION_PAINT??'default'},maxInterval:dt.at(-1)??null,over50ms:dt.filter(v=>v>50).length,intervals:dt,regions:f.regions(),paintedText:(await a.call('getPaintedText',{})).text})
  writeFileSync(`${out}/resources-${label}-${scene}.log`,f.diagnostics())
  appendFileSync(`${out}/resources.jsonl`,JSON.stringify(result)+'\n');console.log(JSON.stringify({...result,intervals:undefined,paintedText:undefined}))
}finally{await f.close();release()}
