import '../src/native/local-build.ts'
import {launchFixture} from '../src/requests/harness.ts'
import {pixels} from './png.ts'
import path from 'node:path'
import assert from 'node:assert/strict'
const out='/Users/mymac/projects/ade/previews/gpuix/p1g'
for(const mode of ['dark','light']){
 const f=await launchFixture(path.join(import.meta.dir,'link-lab.tsx'),{KYBERN_APPEARANCE:mode,GPUIX_BACKGROUND:'1'}),a=f.app
 try{
 await a.getByTestId('ready').waitFor();await a.mouse.move({x:700,y:400});await a.screenshot({path:path.join(out,`links-${mode}-gpuix.png`)})
 const before=pixels(path.join(out,`links-${mode}-gpuix.png`))
 for(const id of ['none','always','hover']){
 const b=await a.getByTestId(id).bounds();await a.mouse.move({x:b.x+20,y:b.y+10});await a.clock.fastForward(32);const file=path.join(out,`links-${mode}-${id}-hover.png`);await a.screenshot({path:file});const after=pixels(file);let changed=0
 for(let y=Math.floor(b.y*2);y<(b.y+b.height)*2;y++)for(let x=Math.floor(b.x*2);x<(b.x+90)*2;x++){const c=before.at(x,y),d=after.at(x,y);if(c.some((v,i)=>Math.abs(v-d[i]!)>20))changed++}
 assert.ok(id==='hover'?changed>40:changed===0,`${id} hover changed ${changed} pixels`)
 await a.mouse.down({x:b.x+20,y:b.y+10});await a.mouse.up({x:b.x+20,y:b.y+10});await a.clock.fastForward(32);assert.equal(await a.getByTestId('clicked').textContent(),'https://example.com/one')
 await a.mouse.down({x:b.x+145,y:b.y+10});await a.mouse.up({x:b.x+145,y:b.y+10});await a.clock.fastForward(32);assert.equal(await a.getByTestId('clicked').textContent(),'https://example.com/two')
 }
 const mixed=await a.getByTestId('mixed').bounds();await a.mouse.down({x:mixed.x+113,y:mixed.y+10});await a.mouse.up({x:mixed.x+113,y:mixed.y+10});await a.clock.fastForward(32);assert.equal(await a.getByTestId('clicked').textContent(),'https://example.com/mixed')
 console.log(`ok ${mode}: none/always/hover pixels, per-range first/second clicks and mixed inline-code link`)
 }catch(e){console.error(f.diagnostics());throw e}finally{await f.close()}
}
