import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import {mkdirSync} from 'node:fs'
import path from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
const exec=promisify(execFile)
import {launchFixture} from '../scripts/idle-harness.ts'
import {pixels} from './png.ts'
import {requireScreen} from '../perf/bench/screen-state.ts'
import {waitForWindowOnscreen,requireWindowOnscreen} from '../perf/bench/window-onscreen.ts'
const out=process.env.KYBERN_VERIFY_OUTPUT??path.join(import.meta.dir,'build','paint-check')
mkdirSync(out,{recursive:true})
for(const mode of ['dark','light']) {
 const shots:string[][]=[]
 for(const enabled of ['0','1']) {
  const f=await launchFixture(path.join(import.meta.dir,'paint-lab.tsx'),{KYBERN_APPEARANCE:mode,KYBERN_SCOPED_PAINT:enabled,KYBERN_DEBUG_ISLANDS:'1',GPUIX_BACKGROUND:'1'})
  const a=f.app,images:string[]=[]
  try {
   await a.getByTestId('app-ready').waitFor({timeoutMs:60000})
   await a.getByTestId('fill').waitFor()
   await waitForWindowOnscreen(f.pid)
   await a.getByTestId('park').hover()
   const root=(await a.getByTestId('app-ready').element()).id
   const windowId=(await exec('swift',[path.join(import.meta.dir,'surface-window-id.swift'),String(f.pid),'3'])).stdout.trim()
   const capture=async(file:string)=>{requireScreen();await waitForWindowOnscreen(f.pid,20_000);requireWindowOnscreen(f.pid);await exec('screencapture',['-x','-o','-l',windowId,file])}
   const key=async(key:string)=>{await a.call('keyDown',{elementId:root,key})}
   const sample=async(file:string,id:string,dx=20,dy=20)=>{const b=await a.getByTestId(id).bounds(),png=pixels(file),scale=png.w/600;return png.at((b.x+dx)*scale,png.h-340*scale+(b.y+dy)*scale)}
   const shot=async(name:string,ready?:(file:string)=>Promise<boolean>)=>{
    const file=path.join(out,`${mode}-${enabled}-${name}.png`),deadline=Date.now()+8000
    for(;;){await capture(file);if(!ready||await ready(file))break;assert.ok(Date.now()<deadline,`Unpainted state ${name}`)}
    images.push(file);return file
   }
   const painted=async(text:string)=>{const deadline=Date.now()+8000;while(!(await a.call('getPaintedText',{})).text.join('\n').includes(text)){assert.ok(Date.now()<deadline);await Bun.sleep(10)}}
   // Layout/automation readiness can precede the first WindowServer present.
   // Require the actual initial fills before comparing scoped/full pixels.
   await shot('initial',async file=>{
    const expected=[['fill',[221,85,51]],['svg',[85,170,119]],['parent',mode==='light'?[221,221,221]:[51,51,51]]] as const
    for(const [id,rgb]of expected){const actual=await sample(file,id,id==='parent'?300:20,id==='parent'?80:20);if(rgb.some((value,i)=>Math.abs(value-actual[i]!)>2))return false}
    return true
   })
   const before=f.counts()
   for(let i=0;i<4;i++) {
    await key('c')
    const deadline=Date.now()+5000
    for(;;) {
     const file=path.join(out,`${mode}-${enabled}-fill.png`)
     await capture(file)
     const b=await a.getByTestId('fill').bounds(),png=pixels(file),scale=png.w/600,rgb=png.at((b.x+20)*scale,png.h-340*scale+(b.y+20)*scale)
     if(i%2===0?rgb[2]!>rgb[0]!+50:rgb[0]!>rgb[2]!+50)break
     if(Date.now()>deadline)throw Error(`stale paint ${rgb}`)
    }
   }
   const after=f.counts()
   if(enabled==='1') {
    assert.match(f.diagnostics(),/scoped paint/)
    const previous=(f.diagnostics().match(/scoped paint/g)??[]).length
    await key('t')
    const deadline=Date.now()+5000
    while((f.diagnostics().match(/scoped paint/g)??[]).length<=previous){assert.ok(Date.now()<deadline);await Bun.sleep(10)}
    const timerBefore=f.counts()
    while((f.diagnostics().match(/scoped paint/g)??[]).length<previous+8){assert.ok(Date.now()<deadline);await Bun.sleep(10)}
    assert.equal(f.counts().renders-timerBefore.renders,0,'scheduled paint-only updates rendered ancestor islands')
   }
   await key('c');await shot('fill',async file=>{const rgb=await sample(file,'fill');return rgb[2]!>rgb[0]!+50})
   await key('o');await shot('opacity',async file=>{const rgb=await sample(file,'svg');return mode==='dark'?rgb[1]!<130:rgb[1]!>190})
   await key('r');await painted('Clicks 1');await shot('unrelated')
   await key('p');await shot('parent-opacity',async file=>{const rgb=await sample(file,'parent',300,80);return mode==='dark'?rgb[0]!<48:rgb[0]!>226})
   const initial=await a.getByTestId('button').bounds()
   await key('m');await shot('parent-moved',async()=>Math.abs((await a.getByTestId('button').bounds()).x-initial.x-60)<1)
   const moved=await a.getByTestId('button').bounds();assert.equal(moved.x-initial.x,60)
   await a.getByTestId('button').click();await a.getByText('Clicks 2').waitFor()
   await a.getByTestId('input').fill('focus survives')
   await key('c');await key('o')
   await a.getByTestId('input').press('End');await a.getByTestId('input').press('!')
   await a.getByText('focus survives!').waitFor()
   await a.getByTestId('park').click()
   await key('h');await shot('removed')
   await key('h');await shot('remounted')
   console.log(`ok ${mode} scoped=${enabled}: repeated live pixels, nested island renders ${after.renders-before.renders}, parent opacity/move, click, focus/edit, removal/remount`)
  }catch(e){console.error(f.diagnostics());throw e}finally{await f.close()}
  shots.push(images)
 }
 // Compare actual content pixels, excluding WindowServer titlebar and input caret.
 for(let i=0;i<6;i++) {
  const expected=pixels(shots[0]![i]!),actual=pixels(shots[1]![i]!),scale=expected.w/600
  assert.equal(actual.w,expected.w)
  let different=0
  for(let y=40*scale;y<140*scale;y++)for(let x=20*scale;x<500*scale;x++) {
   const a=expected.at(x,expected.h-340*scale+y),b=actual.at(x,actual.h-340*scale+y)
   if(a.some((v,j)=>Math.abs(v-b[j]!)>2))different++
  }
  assert.equal(different,0,`${mode}: live scoped pixels differ from full repaint at frame ${i}`)
 }
 console.log(`ok ${mode}: six actual-window states pixel-identical to full repaint`)
}
