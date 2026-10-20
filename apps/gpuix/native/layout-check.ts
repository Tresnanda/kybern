import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import path from 'node:path'
import { launchFixture } from '../src/requests/harness.ts'
import type {ElementBoundsEvent, WindowResizeEvent} from '../src/native/layout.ts'
for(const mode of ['dark','light']){
 const f=await launchFixture(path.join(import.meta.dir,'layout-lab.tsx'),{KYBERN_APPEARANCE:mode,GPUIX_BACKGROUND:'1'}),a=f.app
 try {
  await a.getByTestId('app-ready').waitFor()
  const root=(await a.getByTestId('app-ready').element()).id
  const key=async(key:string)=>{await a.call('keyDown',{elementId:root,key});await Bun.sleep(80)}
  const inspect=async()=>{await key('i');return JSON.parse(await a.getByTestId('result').textContent()) as {bounds:ElementBoundsEvent[];numeric:ElementBoundsEvent[];row:ElementBoundsEvent[];spring:ElementBoundsEvent[];window:WindowResizeEvent[]}}
  await key('s')
  let e=await inspect(); assert.equal(e.bounds.length,1);assert.equal(e.window.length,1);assert.equal(e.bounds[0].rect?.width,180);assert.equal(e.bounds[0].clippedRect?.width,160)
  await key('t');assert.equal((await inspect()).bounds.length,1,'Unchanged cached replay emitted a bounds change')
  await key('m');e=await inspect();assert.equal(e.bounds.at(-1)?.rect?.x,70);assert.equal(e.bounds.at(-1)?.clippedRect?.width,90)
  await key('w');e=await inspect();assert.equal(e.bounds.at(-1)?.clippedRect?.width,50,'Cached child retained stale ancestor clipping')
  const old=e.bounds.at(-1)!.elementId
  await key('r');e=await inspect();assert.notEqual(e.bounds.at(-1)!.elementId,old);assert.equal(e.numeric.at(-1)?.rect,null)
  await key('h');e=await inspect();assert.equal(e.bounds.at(-1)?.rect,null)
  await key('v');e=await inspect();assert.ok(e.bounds.at(-1)?.rect)
  await key('l');e=await inspect();assert.equal(e.row.at(-1)?.rect,null,'Virtual unpainted row retained a box')
  await key('q');await key('t')
  await key('d');assert.match(await a.getByTestId('result').textContent(),/uniquely/)
  await key('z');e=await inspect();assert.ok(e.window.length>=2,'Native resize did not notify');await key('z')
  for(const events of [e.bounds,e.numeric,e.row,e.window])assert.equal(new Set(events.map(e=>e.frame)).size,events.length,'More than one delivery per frame')
  await key('u');const before=await inspect();await key('m');await key('t');assert.deepEqual(await inspect(),before,'Unsubscribe delivered queued changes')
  const at=await a.clock.pause();const initial=await a.getByTestId('spring').bounds()
  await key('o');await key('f');await a.clock.set(at+100);const positive=await a.getByTestId('spring').bounds();assert.ok(positive.x>initial.x+10);assert.ok(positive.y>initial.y+5);assert.equal((await inspect()).spring.at(-1)?.rect?.x,positive.x,'Observer lost native translation')
  await a.clock.set(at+1000);assert.deepEqual(await a.getByTestId('spring').bounds(),initial)
  await key('b');await a.clock.set(at+1100);assert.ok((await a.getByTestId('spring').bounds()).x<initial.x-10,'Velocity-only retarget was not forwarded')
  await a.clock.set(at+2000);assert.deepEqual(await a.getByTestId('spring').bounds(),initial)
  const out=process.env.KYBERN_VERIFY_OUTPUT??path.join(import.meta.dir,'build')
  await a.screenshot({path:path.join(out,`layout-${mode}.png`)})
  console.log(`ok ${mode}: initial/changed/resize/clipped/cached/replaced/virtual bounds, unsubscribe, velocity-only springs`)
 }catch(error){console.error(f.diagnostics());throw error}finally{await f.close()}
}
