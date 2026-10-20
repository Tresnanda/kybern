/** Actual application interactions; live draw cadence is separate from paused strips. */
import path from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { launchFixture } from '../native/frame-harness.ts'
import { pacingLock } from './pacing-lock.ts'
if(process.env.KYBERN_PACING_FIXTURE!=='1')throw Error('Use pacing-fixture.ts')
const label=process.argv[2]??'baseline',theme=process.argv[3]??'dark',reduce=process.argv[4]??'0'
const out=`/Users/mymac/projects/ade/previews/gpuix/round7/pacing/motion-${label}-${theme}-${reduce}`
mkdirSync(out,{recursive:true})
const release=await pacingLock(),before=label==='baseline'
const f=await launchFixture(path.join(import.meta.dir,'pacing-app.ts'),{
  KYBERN_GPUIX_THREAD:process.env.KYBERN_IDLE_THREAD!,KYBERN_APPEARANCE:theme,KYBERN_REDUCED_MOTION:reduce,
  KYBERN_PACING_BASELINE:before?'1':'0',KYBERN_NATIVE_PAINT_ANIMATIONS:before?'0':'1',
  KYBERN_FULL_RATE:before?'0':'1',KYBERN_VSYNC_WAKE:before?'0':'1',KYBERN_FRAME_TIMES:'1',
  KYBERN_REGION_PAINT:before?'0':'1',KYBERN_NATIVE_TEXT_PAINT:before?'0':'1',
  NAPI_RS_NATIVE_LIBRARY_PATH:process.env.KYBERN_PACING_ADDON??path.join(import.meta.dir,'../native/build/gpuix-native.darwin-arm64.node'),
})
const results:unknown[]=[]
try {
  const a=f.app
  await a.getByTestId('app-ready').waitFor({timeoutMs:60000});await a.getByTestId('composer').waitFor({timeoutMs:30000})
  const sample=async(name:string,duration:number,action:()=>Promise<unknown>)=>{
    const start=performance.now(),counts=f.counts()
    await action()
    // A fixed observation window is the measurement itself, not a readiness wait.
    await Bun.sleep(Math.max(0,start+duration+60-performance.now()))
    const times=f.frameEvents().filter(e=>e.received>=start&&e.received<=start+duration+45).map(e=>e.native)
    const dt=times.slice(1).map((v,i)=>v-times[i]!).sort((a,b)=>a-b),after=f.counts()
    const result={name,duration,frames:times.length,p50:dt[Math.floor(dt.length*.5)]??null,p95:dt[Math.floor(dt.length*.95)]??null,commits:after.commits-counts.commits,intervals:dt}
    results.push(result);console.log(JSON.stringify({...result,intervals:undefined}))
    writeFileSync(`${out}/cadence.json`,JSON.stringify({label,theme,reduce,results},null,2))
  }
  const click=(id:string)=>a.getByTestId(id).click()
  const visibleId=async(prefix:string)=>{
    const tree=(await a.call('getTree',{})).tree,ids:string[]=[]
    const visit=(node:NonNullable<typeof tree>)=>{if(node.testId?.startsWith(prefix))ids.push(node.testId);for(const child of node.children??[])visit(child)}
    if(tree)visit(tree)
    for(const id of ids){try{const b=await a.getByTestId(id).bounds();if(b.width>0&&b.height>0&&b.y>46&&b.y<650)return id}catch{}}
    throw Error(`No visible ${prefix}`)
  }
  try {
    await a.getByTestId('transcript-surface').waitFor({timeoutMs:30000})
    let worked:string|undefined
    const viewport=await a.getByTestId('transcript-surface').bounds()
    for(let i=0;i<8&&!worked;i++){try{worked=await visibleId('worked-')}catch{await a.mouse.wheel({x:viewport.x+viewport.width/2,y:viewport.y+viewport.height/2},0,180)}}
    if(!worked)throw Error('No worked disclosure in the visible transcript')
    await sample('worked disclosure open',350,()=>click(worked!))
    const tool=await visibleId('tool-row-')
    await sample('tool disclosure open',350,()=>click(tool))
    await sample('tool disclosure close',350,()=>click(tool))
    await sample('worked disclosure close',350,()=>click(worked!))
  }catch(error){results.push({name:'worked/tool disclosures',unverified:true,error:String(error)});console.error('UNVERIFIED disclosures',String(error))}
  await sample('sidebar close and title position',300,()=>click('sidebar-toggle'))
  await sample('sidebar open and title position',300,()=>click('sidebar-toggle'))
  await sample('environment open and inset',300,()=>click('environment-toggle'))
  await a.getByTestId('environment-panel').waitFor()
  await sample('environment close and inset',300,()=>click('environment-toggle'))
  await sample('dock open',300,()=>click('dock-toggle'))
  await a.getByTestId('dock-add').waitFor()
  await sample('dock add menu',250,()=>click('dock-add'))
  await sample('dock tab pill',300,()=>click('dock-add-agents'))
  await sample('dock close',300,()=>click('dock-collapse'))
  await sample('composer menu',250,()=>click('composer-plus'))
  await a.getByTestId('app-ready').press('escape')
  await sample('rail pill and notes section',300,()=>click('rail-notes'))
  await sample('home stagger',650,()=>click('rail-home'))
  await sample('settings entrance',300,()=>click('rail-settings'))
  await a.getByTestId('page-settings').waitFor()
  await sample('settings tab pill',300,()=>click('settings-tab-appearance'))
  // Capture a production Environment transition at controlled native times.
  // These images document the curve; the live timing above documents cadence.
  if(label!=='baseline') {
    await click('settings-back');await a.getByTestId(`thread-${process.env.KYBERN_IDLE_THREAD}`).click()
    await a.getByTestId('composer').waitFor()
    const t=await a.clock.pause();await click('environment-toggle')
    await a.captureFrames(path.join(out,'environment-strip'),[0,40,80,140,220,320].map(v=>t+v))
    await a.clock.resume()
  }
} finally {writeFileSync(`${out}/diagnostics.log`,f.diagnostics());await f.close();release()}
