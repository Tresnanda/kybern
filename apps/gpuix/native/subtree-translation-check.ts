import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { launchFixture } from '../src/tasks/round7b-harness.ts'
import { pngPixels } from './clip-pixels.ts'
const out=process.env.KYBERN_VERIFY_OUTPUT??path.join(import.meta.dir,'build/subtree-translation');mkdirSync(out,{recursive:true})
for(const theme of ['dark','light'])for(const reduce of ['0','1']){
  if(process.env.R8_MODE&&process.env.R8_MODE!==`${theme}-${reduce}`)continue
  const label=`${theme}-${reduce==='1'?'reduced':'normal'}${process.env.KYBERN_REGION_PAINT==='1'?'-region':''}`
  const f=await launchFixture(path.join(import.meta.dir,'subtree-translation-lab.tsx'),{GPUIX_BACKGROUND:'1',KYBERN_APPEARANCE:theme,KYBERN_REDUCED_MOTION:reduce,KYBERN_FULL_RATE:'1',KYBERN_DEBUG_ISLANDS:'1'})
  try{
    const a=f.app;await a.getByTestId('app-ready').waitFor();await a.getByTestId('button').waitFor()
    const root=(await a.getByTestId('app-ready').element()).id
    const movingId=(await a.getByTestId('moving').element()).id,slotId=(await a.getByTestId('slot').element()).id
    const inputId=(await a.getByTestId('input').element()).id
    const buttonId=(await a.getByTestId('button').element()).id,springId=(await a.getByTestId('spring').element()).id
    const bounds=async(id:number)=>(await a.call('getBounds',{elementId:id})).bounds!
    await a.call('focus',{elementId:root})
    const key=async(key:string)=>{await a.call('keyDown',{key})}
    const wait=async(check:()=>Promise<boolean>,name:string)=>{const deadline=Date.now()+6000;while(!await check()){assert.ok(Date.now()<deadline,name);await Bun.sleep(10)}}
    await wait(async()=>f.diagnostics().includes('[islands] render'),'islands created')
    await key('q') // Establish keyboard input modality before counting paint-only work.
    let last=-1,quiet=performance.now()
    await wait(async()=>{const n=f.islandRenders();if(n!==last){last=n;quiet=performance.now()}return performance.now()-quiet>150},'initial island paint settles')
    const initial=await bounds(movingId),slot=await bounds(slotId)
    const before=f.islandRenders()
    await key('m')
    await wait(async()=>(await bounds(movingId)).x===initial.x+70,'translated visual bounds')
    const moved=await bounds(movingId);assert.equal(moved.y,initial.y+20)
    assert.deepEqual(await bounds(slotId),slot,'layout slot moved')
    assert.equal(f.islandRenders(),before,'translation rendered a cached island')
    for(let move=0;move<60;move++){await key('n');await key('m')}
    assert.deepEqual(await bounds(movingId),moved,'repeated translation drifted')
    assert.equal(f.islandRenders(),before,'repeated translation rendered a cached island')
    const button=await bounds(buttonId),spring=await bounds(springId)
    const windowId=execFileSync('swift',[path.join(import.meta.dir,'../src/tasks/round7-window-id.swift'),String(f.pid)],{encoding:'utf8'}).trim()
    // Native bounds/text acknowledge scene construction before WindowServer presents it.
    // Wait outside timing runs so screencapture reads the settled device pixels.
    const shot=async(name:string)=>{await Bun.sleep(150);const file=path.join(out,`${label}-${name}.png`);execFileSync('screencapture',['-x','-o','-l',windowId,file]);return file}
    const scoped=await shot('scoped');await key('t');await a.getByText('Tick 1; clicks 0').waitFor();const full=await shot('full')
    const left=pngPixels(scoped),right=pngPixels(full),scale=left.width/600;let changed=0
    for(let y=Math.round(60*scale);y<235*scale;y++)for(let x=Math.round(10*scale);x<490*scale;x++){const p=left.at(x,y),q=right.at(x,y);if(p.some((v,i)=>Math.abs(v-q[i]!)>2))changed++}
    assert.equal(changed,0,'retained glyphs/shadows/rounded clips differ from ordinary render')
    for(let frame=0;frame<10;frame++){await key('n');await key('t');await wait(async()=>(await bounds(movingId)).x===initial.x-30,'negative after full render');await key('m');await key('t');await wait(async()=>(await bounds(movingId)).x===moved.x,'positive after full render')}
    await a.mouse.click({x:button.x+20,y:button.y+10});await a.getByText('Tick 21; clicks 1').waitFor()
    const input=await bounds(inputId);await a.mouse.click({x:input.x+2,y:input.y+input.height/2});await a.call('keystrokes',{keys:'!'})
    await wait(async()=>(await a.getByTestId('input-value').textContent())==='!abc','editor caret did not follow translation')
    await a.call('focus',{elementId:root})
    await a.mouse.drag({x:moved.x+3,y:moved.y+10},{x:moved.x+90,y:moved.y+10},{steps:8})
    const selected=(await a.call('getSelectedText',{})).text;assert.ok(selected?.length,'translated text selection')
    await a.call('focus',{elementId:root})
    await key('z');await wait(async()=>(await bounds(movingId)).x===initial.x,'zero offset with selected text');assert.equal((await a.call('getSelectedText',{})).text,selected,'translation lost selection identity')
    await a.call('clearSelection',{})
    await key('n');await wait(async()=>(await a.getByTestId('moving').bounds()).x===initial.x-30,'negative offset')
    await key('i');const events=JSON.parse(await a.getByTestId('result').textContent());assert.ok(events.some((e:any)=>e.rect?.x===initial.x+70),'observer did not follow visual bounds')
    await key('b');await wait(async()=>(await a.getByTestId('spring').bounds()).x===spring.x+100,'spring exact endpoint')
    await key('r');await wait(async()=>(await a.getByTestId('moving').bounds()).x===initial.x,'remount reset')
    await key('h');await wait(async()=>!await a.getByTestId('moving').count(),'remove');await key('h');await a.getByTestId('moving').waitFor();assert.equal((await a.getByTestId('moving').bounds()).x,initial.x)
    writeFileSync(path.join(out,`${label}.json`),JSON.stringify({initial,moved,slot,events,islandRendersDuringTranslation:0},null,2))
    console.log(`ok ${label}: paint matches full render; visual bounds, fixed slot, hitboxes, observers, spring, removal/remount; zero unrelated island renders`)
  }catch(error){console.error(f.diagnostics());throw error}finally{await f.close()}
}
