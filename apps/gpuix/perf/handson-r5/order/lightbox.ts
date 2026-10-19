import assert from 'node:assert/strict'
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import path from 'node:path'
import {prepareBaseline} from './baseline.ts'
import {seed} from '../../bench/seed.ts'
import {launchFixture} from '../../../src/requests/harness.ts'
import {requireScreen} from '../../bench/screen-state.ts'
import {requireWindowOnscreen,waitForWindowOnscreen} from '../../bench/window-onscreen.ts'
const out='/Users/mymac/projects/ade/previews/gpuix/handson-r5/order',data='/Users/mymac/projects/ade-gpuix-scratch/hr5-order-bench'
const label=process.argv[2]??'after',baseline=label.startsWith('before')
if(baseline)prepareBaseline()
mkdirSync(out,{recursive:true})
const until=async(check:()=>Promise<boolean>,description:string)=>{const end=Date.now()+30000;for(;;){if(await check())return;if(Date.now()>end)throw Error(description);await Bun.sleep(30)}}
const fixture=await seed(data,4343),results:unknown[]=[]
try{for(const theme of ['dark','light'])for(const reduced of ['0','1']){
 requireScreen()
 const client=path.join(data,`lightbox-${theme}-${reduced}`);mkdirSync(client,{recursive:true})
 const f=await launchFixture(import.meta.dir+'/entry.ts',{...fixture.env,HR5_ORDER_BASELINE:baseline?'1':'0',KYBERN_CLIENT_CONFIG_DIR:client,KYBERN_GPUIX_CREDENTIALS_DIR:client+'/credentials',GPUIX_BACKGROUND:'1',KYBERN_APPEARANCE:theme,KYBERN_REDUCED_MOTION:reduced,KYBERN_OPAQUE:'1',KYBERN_GPUIX_THREAD:fixture.manifest.long1000,KYBERN_BENCH_HISTORY_TURNS:'1000',KYBERN_BENCH_WHEEL_LIBRARY:data+'/bench-wheel.dylib'})
 try{
  const a=f.app;await a.getByTestId('app-ready').waitFor();await waitForWindowOnscreen(f.pid)
  await until(async()=>{try{return !!JSON.parse(readFileSync(client+'/bench-control.json','utf8')).port}catch{return false}},'control readiness')
  const {port}=JSON.parse(readFileSync(client+'/bench-control.json','utf8'))
  const control=async(action:string,args:object={})=>{const r=await fetch(`http://127.0.0.1:${port}`,{method:'POST',body:JSON.stringify({action,...args})});if(!r.ok)throw Error(await r.text());return r.json() as Promise<any>}
  await control('open',{thread:fixture.manifest.long1000})
  await until(async()=>(await control('state')).loaded,'loaded thread')
  await control('load-history');await control('prepare-images');await Bun.sleep(400)
  const users=(await control('reading')).images as string[]
  assert.equal(users.length,11)
  // Exercise the composer being focused before the reader opens an older image.
  const editor=a.getByTestId('composer');if(await editor.count())await editor.click()
  for(const position of (process.env.HR5_ORDER_POSITIONS??'middle,near-bottom,tail,streaming').split(',')){
   if(position==='streaming'){await control('stream',{durationMs:60000});await Bun.sleep(200)}
   const user=users[(position==='near-bottom'||position==='tail')?10:5]!
   // Prepare the distant logical page, then use the actual rail and wheel input
   // to establish a reading position. No scroll changes are made on close.
   await control('position',{target:user});await Bun.sleep(300)
   await a.getByTestId(`message-jump-${(position==='near-bottom'||position==='tail')?999:500}`).click()
   await Bun.sleep(1700)
   const image=a.getByTestId(`turn-user:${user}`).getByTestId('response-image')
   await image.waitFor()
   const box=await image.bounds(),surface=await a.getByTestId('transcript-surface').bounds()
   await a.mouse.wheel({x:surface.x+surface.width/2,y:surface.y+surface.height/2},0,position==='tail'?-5000:37)
   await Bun.sleep(200)
   for(const close of ['escape','button','outside']){
    if(baseline&&close!=='escape'){
     await control('position',{target:user});await Bun.sleep(300);await a.getByTestId(`message-jump-${(position==='near-bottom'||position==='tail')?999:500}`).click();await Bun.sleep(1700)
     await a.mouse.wheel({x:surface.x+surface.width/2,y:surface.y+surface.height/2},0,position==='tail'?-5000:37);await Bun.sleep(200)
    }
    const before=await control('reading'),beforeBox=await image.bounds()
    assert.ok(beforeBox.y>=surface.y&&beforeBox.y+beforeBox.height<=surface.y+surface.height,'Image is visible before opening')
    if(close==='escape'){requireWindowOnscreen(f.pid);await a.screenshot({path:`${out}/${label}-${theme}-${reduced}-${position}-before.png`})}
    await image.click();await a.getByTestId('image-lightbox').waitFor();await Bun.sleep(250)
    const during=await control('reading')
    if(close==='escape'){requireWindowOnscreen(f.pid);await a.screenshot({path:`${out}/${label}-${theme}-${reduced}-${position}-open.png`})}
    if(close==='escape')await a.call('keystrokes',{keys:'escape'})
    else if(close==='button')await a.getByTestId('dialog-close').click()
    else await a.mouse.click({x:80,y:400})
    await until(async()=>await a.getByTestId('image-lightbox').count()===0,'Lightbox did not close')
    await Bun.sleep(250)
    const after=await control('reading'),afterBox=await image.bounds().catch(()=>null)
    const stable=before.topKey===after.topKey&&before.list===after.list&&JSON.stringify(before.anchor)===JSON.stringify(after.anchor)&&!!afterBox&&Math.abs(beforeBox.y-afterBox.y)<0.5
    results.push({theme,reduced,position,close,stable,before,during,after,beforeBox,afterBox,initialBox:box})
    writeFileSync(`${out}/lightbox-${label}.json`,JSON.stringify(results,null,2))
    if(close==='escape'){requireWindowOnscreen(f.pid);await a.screenshot({path:`${out}/${label}-${theme}-${reduced}-${position}-after.png`})}
    if(!baseline)assert.ok(stable,`${theme} reduced=${reduced} ${position} ${close}: exact anchor and row pixels`)
    if(!baseline)assert.equal(after.focus,(await image.element()).id,'Focus returns to the image trigger')
   }
   if(!baseline&&position==='middle'){
    const before=await control('reading'),beforeBox=await image.bounds()
    await a.call('keystrokes',{keys:'space'});await a.getByTestId('image-lightbox').waitFor()
    await a.call('keystrokes',{keys:'escape'});await until(async()=>await a.getByTestId('image-lightbox').count()===0,'Keyboard-opened lightbox closes')
    await Bun.sleep(250)
    const after=await control('reading'),afterBox=await image.bounds()
    const stable=before.topKey===after.topKey&&JSON.stringify(before.anchor)===JSON.stringify(after.anchor)&&beforeBox.y===afterBox.y
    results.push({theme,reduced,position,close:'keyboard-reopen',stable,before,after});assert.ok(stable,'Keyboard reopening and Escape preserve focus and position')
   }
   if(position==='tail'){
    const before=await control('reading');await control('tail-grow');await Bun.sleep(400);const after=await control('reading')
    const stable=Math.abs(after.tail.y+after.tail.height-surface.y-surface.height)<1
    results.push({theme,reduced,position:'tail-growth',stable,before,after});if(!baseline)assert.ok(stable,'Tail still follows growth after image close')
   }
  }
  requireScreen()
 }finally{await f.close()}
}}finally{await fixture.close()}
writeFileSync(`${out}/lightbox-${label}.json`,JSON.stringify(results,null,2))
console.log(JSON.stringify({label,checks:results.length,failed:results.filter((r:any)=>!r.stable).length}))
