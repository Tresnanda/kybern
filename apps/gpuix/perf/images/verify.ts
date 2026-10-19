import assert from 'node:assert/strict'
import { requireScreen } from '../bench/screen-state.ts'
import { onExit } from '../bench/lifetime.ts'
import { assertTestDisplayWindow } from './onscreen.ts'
import {readFileSync,mkdirSync,existsSync} from 'node:fs'
import {launchFixture} from '../../src/requests/harness.ts'
const out='/Users/mymac/projects/ade/previews/gpuix/perf/images/lightbox-'+(process.env.KYBERN_IMAGE_VERIFY_LABEL??'after');mkdirSync(out,{recursive:true})
const data='/Users/mymac/projects/ade-gpuix-scratch/perf-images-verify';mkdirSync(data,{recursive:true})
const until=async(check:()=>Promise<boolean>,name:string)=>{const end=Date.now()+15000;for(;;){try{if(await check())return}catch{}if(Date.now()>end)throw Error(`Timed out: ${name}`);await Bun.sleep(25)}}
for(const theme of ['dark','light']){
 requireScreen()
 const f=await launchFixture(import.meta.dir+'/../transcript/entry.ts',{TRANSCRIPT_TURNS:'1000',KYBERN_DATA_DIR:data,KYBERN_CLIENT_CONFIG_DIR:data,KYBERN_URL:'',KYBERN_TOKEN:'',KYBERN_OPAQUE:'1',KYBERN_APPEARANCE:theme,GPUIX_BACKGROUND:'1'})
 const stop=onExit(f.close)
 try{
  const a=f.app;await a.getByTestId('perf-ready').waitFor();await a.getByTestId('message-rail').waitFor();await Bun.sleep(500)
  const port=JSON.parse(readFileSync(data+'/transcript-control.json','utf8')).port
  const command=async(action:string,args:object={})=>{const r=await fetch(`http://127.0.0.1:${port}`,{method:'POST',body:JSON.stringify({action,...args})});if(!r.ok)throw Error(await r.text());return r.json() as Promise<{selected:string|null}>}
  const painted=async()=>(await a.call('getPaintedText',{})).text.join('\n')
  console.log(`${theme}: first rail target`)
  console.log('First jump',JSON.stringify(await command('jump',{index:1})));await Bun.sleep(300);console.log('First anchor',JSON.stringify(await command('where')));console.log('First painted',(await painted()).slice(0,450))
  await a.getByTestId('message-jump-0').waitFor()
  await a.getByTestId('message-jump-0').click()
  await until(async()=>(await painted()).includes('Prompt 0:'),'first rail target mounts')
  await assertTestDisplayWindow(f.pid); await a.screenshot({path:`${out}/verify-${theme}-first.png`})
  const row=await a.getByTestId('turn-user:user-0').bounds(),surface=await a.getByTestId('transcript-surface').bounds()
  assert.ok(row.y>=surface.y-1 && row.y<surface.y+surface.height,'First prompt stays in viewport')
  await Bun.sleep(1600) // Finish the rail's finite centering observation before unrelated gestures.
  if(process.env.TRANSCRIPT_COMPACT!=='1'){
  console.log(`${theme}: response image overlay`)
  await Bun.sleep(200)
  await a.getByTestId('transcript-slot:turn-0:images').getByTestId('response-image').click()
  await a.getByTestId('image-lightbox').waitFor()
  await command('jump',{index:6001})
  await Bun.sleep(150)
  assert.equal(await a.getByTestId('image-lightbox').count(),1,'Row-owned image dialog survives scrolling its trigger away')
  assert.ok((await a.getByTestId('image-lightbox').bounds()).width>0,'Focused offscreen row still paints its overlay')
  await assertTestDisplayWindow(f.pid); await a.screenshot({path:`${out}/verify-${theme}-pinned-image.png`})
  await a.getByTestId('image-lightbox').press('escape')
  await until(async()=>await a.getByTestId('image-lightbox').count()===0,'Image dialog closes after offscreen trigger')
  // Native focus restoration may reveal the offscreen trigger. Establish the
  // following navigation test's own starting point after that restoration.
  await a.call('blur',{})
  console.log('After overlay jump',JSON.stringify(await command('jump',{index:6001})))
  }else await command('jump',{index:2001})
  await Bun.sleep(150)
  // A programmatic jump can leave the visible-range callback unchanged. The
  // changed native list-anchor observation must refill bodies and rail alone.
  console.log(`${theme}: middle rail target`,JSON.stringify(await command('where')))
  await a.getByTestId('message-jump-500').waitFor()
  await a.getByTestId('message-jump-500').click()
  await until(async()=>(await painted()).includes('Prompt 500:'),'middle rail target mounts')
  await assertTestDisplayWindow(f.pid); await a.screenshot({path:`${out}/verify-${theme}-middle.png`})
  if(process.env.TRANSCRIPT_COMPACT==='1'){
    await Bun.sleep(1600)
    const first=await a.getByTestId('transcript-slot:turn-500:answer:0:0').getByType('markdown').bounds(),next=await a.getByTestId('transcript-slot:turn-501:answer:0:0').getByType('markdown').bounds()
    const from={x:first.x+1,y:first.y+first.height/2},to={x:next.x+220,y:next.y+next.height/2}
    await a.mouse.down(from)
    await a.mouse.move(to,{pressedButton:0})
    await a.mouse.up(to)
    const cross=await command('selected');console.log('Cross-turn selection',JSON.stringify({first,next,selected:cross.selected}));assert.ok(cross.selected?.includes('turn-500.')&&cross.selected.includes('turn-501.'),'Native pointer selection crosses turn boundaries')
    await a.call('clearSelection',{})
  }
  // Move a little below the prompt into the selected turn's highlighted code.
  const b=await a.getByTestId('transcript-surface').bounds(),point={x:b.x+b.width/2,y:b.y+b.height/2}
  await a.mouse.wheel(point,0,-500);await Bun.sleep(150)
  const selected=await command('select');assert.ok(selected.selected,'Code has a native Unicode-safe selection')
  await a.mouse.wheel(point,0,-4000);await Bun.sleep(150)
  assert.equal((await command('selected')).selected,selected.selected,'Copy selection survives disposal of unrelated turn bodies')
  await a.call('clearSelection',{})
  await a.getByTestId('scroll-to-bottom').click()
  await a.getByTestId('message-jump-999').waitFor()
  await until(async()=>(await painted()).includes(process.env.TRANSCRIPT_COMPACT==='1'?'Compact answer turn-999.':'BENCH_RESULT_999'),'tail jump mounts exact final content')
  await assertTestDisplayWindow(f.pid); await a.screenshot({path:`${out}/verify-${theme}-tail.png`})
  requireScreen()
  console.log(`PASS ${theme}: first/middle/tail rail, pinned image overlay, native selection, formatted final answer`)
 }catch(e){try{await assertTestDisplayWindow(f.pid);await f.app.screenshot({path:`${out}/verify-${theme}-failed.png`})}catch{}throw e}finally{await f.close();stop()}
}
