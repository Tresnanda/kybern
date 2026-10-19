// Full-app Explorer/source/Markdown pixels, separate from all timing windows.
import assert from 'node:assert/strict'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs'
import {seed} from '../bench/seed.ts'
import {launchFixture} from '../../src/requests/harness.ts'
import {pixels} from '../../native/png.ts'
import {requireWindowOnscreen,waitForWindowOnscreen} from '../bench/window-onscreen.ts'
const data='/Users/mymac/projects/ade-gpuix-scratch/perf-flick-bench'
const out='/Users/mymac/projects/ade/previews/gpuix/perf/flick/preview-visual';mkdirSync(out,{recursive:true})
const fixture=await seed(data,4339),comparisons:unknown[]=[]
let usageLimits:unknown,usageSnapshotSha256=''
const until=async(check:()=>Promise<boolean>,name:string,timeout=15000)=>{const end=performance.now()+timeout;while(performance.now()<end){if(await check())return;await Bun.sleep(25)}throw Error(name)}
try{
 for(const theme of ['dark','light']){
  const shots:Record<string,Record<string,string>>={},positions:Record<string,Record<string,unknown>>={}
  for(const flag of ['0','1']){
   const client=path.join(data,`visual-${theme}-${flag}`);mkdirSync(client,{recursive:true})
   writeFileSync(path.join(data,'gpuix-ui.json'),'{}')
   const f=await launchFixture(path.resolve('perf/bench/app.ts'),{...fixture.env,KYBERN_CLIENT_CONFIG_DIR:client,KYBERN_GPUIX_CREDENTIALS_DIR:path.join(client,'credentials'),KYBERN_BENCH_WHEEL_LIBRARY:path.join(data,'bench-wheel.dylib'),KYBERN_INPUT_FRAME_DRAW:flag,KYBERN_APPEARANCE:theme,KYBERN_REDUCED_MOTION:'0',KYBERN_OPAQUE:'1',KYBERN_WINDOW_SIZE:'1280x820',GPUIX_BACKGROUND:'1',KYBERN_FULL_RATE:'1',KYBERN_BENCH_LAYER_ZERO:'1',KYBERN_PACING_RUNNING_ENTRY:'0',KYBERN_PACING_BASELINE:'0',KYBERN_PACING_IGNORE_PHYSICAL_MOUSE:'1'})
   const a=f.app;shots[flag]={};positions[flag]={}
   try{
    await waitForWindowOnscreen(f.pid)
    await a.getByTestId('app-ready').waitFor()
    const controlFile=path.join(client,'bench-control.json');await until(async()=>existsSync(controlFile),'control endpoint')
    const port=JSON.parse(readFileSync(controlFile,'utf8')).port
    const control=async(action:string,args:Record<string,unknown>={})=>{const r=await fetch(`http://127.0.0.1:${port}`,{method:'POST',body:JSON.stringify({action,...args})});if(!r.ok)throw Error(await r.text());return r.json()}
    await until(async()=>(await control('state')).listsLoaded,'sidebar data')
    await control('idle');await control('open',{thread:fixture.manifest.long3000});await a.getByTestId('transcript-surface').waitFor()
    await until(async()=>(await control('state')).uiReady,'provider, settings, target and model catalog readiness',60000)
    await until(async()=>(await control('state')).usageReady,'loaded usage snapshot',60000)
    usageLimits=(await control('visual-limits',usageLimits?{limits:usageLimits}:{})).limits
    usageSnapshotSha256=createHash('sha256').update(JSON.stringify(usageLimits)).digest('hex')
    for(const view of ['tree','markdown','code']){
     console.log('preview',theme,flag,view)
     await control('explorer',view==='tree'?{}:{file:view==='markdown'?fixture.manifest.markdown:fixture.manifest.code})
     if(view==='tree'){
      await a.getByTestId('dock-file-tree-focus').waitFor();await a.getByTestId('dock-file-expanded').waitFor();await a.getByTestId('dock-file-expanded').click()
      await until(async()=>(await a.call('getPaintedText',{})).text.join('\n').includes('row-00000'),'expanded tree')
     }else await until(async()=>new RegExp(view==='code'?'item0|item64':'Result 1|BENCH_RESULT_1').test((await a.call('getPaintedText',{})).text.join('\n')),'formatted preview')
     await a.call('blur',{});await a.mouse.move({x:650,y:8});await Bun.sleep(1000)
     const box=await a.getByTestId('right-dock').bounds(),point={x:view==='tree'?box.x+100:box.x+box.width-90,y:box.y+box.height/2}
     for(const step of [0,1]){
      const target=view==='tree'?'dock-file-tree':'dock-file-content'
      const before=await control('scroll-state',{target})
      if(step){await a.mouse.wheel(point,0,-400);await Bun.sleep(700)}
      // Park on blank titlebar chrome, away from Hand off and the composer.
      // Captures compare settled content at the same focus and hover state.
      await a.call('blur',{});await a.mouse.move({x:650,y:8});await Bun.sleep(700)
      const after=await control('scroll-state',{target});positions[flag]![`${view}-${step}`]=after.offset
      if(step)assert.notDeepEqual(after.offset,before.offset,`${view} must actually scroll`)

      const file=`${out}/${theme}-${flag}-${view}-${step}.png`;requireWindowOnscreen(f.pid);await a.screenshot({path:file});shots[flag]![`${view}-${step}`]=file
     }
    }
   }finally{await f.close()}
  }
  for(const key of Object.keys(shots['0']!)){
   const left=shots['0']![key]!,right=shots['1']![key]!,a=pixels(left),b=pixels(right);assert.equal(a.w,b.w);assert.equal(a.h,b.h)
   let changed=0,maxDelta=0
   for(let y=4;y<a.h-4;y++)for(let x=4;x<a.w-4;x++){
    if(y>a.h-52&&(x<52||x>a.w-52))continue
    const p=a.at(x,y),q=b.at(x,y),delta=Math.max(...p.map((v,i)=>Math.abs(v-q[i]!)));if(delta)changed++;maxDelta=Math.max(maxDelta,delta)
   }
   assert.deepEqual(positions['0']![key],positions['1']![key],'Matched visual scroll position')
   comparisons.push({theme,key,left,right,changed,maxDelta,usageSnapshotSha256,offset:positions['1']![key]});console.log(JSON.stringify(comparisons.at(-1)));assert.equal(changed,0,'Preview pixels differ')
  }
 }
}finally{await fixture.close();writeFileSync(out+'/pixels.json',JSON.stringify(comparisons,null,2))}
