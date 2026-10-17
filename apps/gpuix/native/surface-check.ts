import "../src/native/local-build.ts"
import {launchFixture,waitForPainted} from "../src/requests/harness.ts"
import {mkdirSync} from "node:fs"
import path from "node:path"
import assert from "node:assert/strict"
import {pixels} from "./png.ts"
const out="/Users/mymac/projects/ade/previews/gpuix/p1g"
mkdirSync(out,{recursive:true})
for(const mode of ["dark","light"]){
 const f=await launchFixture(path.join(import.meta.dir,"surface-lab.tsx"),{KYBERN_APPEARANCE:mode,GPUIX_BACKGROUND:"1"}),a=f.app
 try{
 await a.getByTestId("glass").waitFor();await a.clock.fastForward(32);assert.ok((await a.getByTestId("glass").textContent()).includes("Floating surface"))
 const b=await a.getByTestId("glass").bounds(),l=await a.getByTestId("link").bounds();console.log(mode,b,l)
 await a.mouse.move({x:5,y:590});await a.screenshot({path:path.join(out,`surface-${mode}-gpuix.png`)})
 await a.mouse.move({x:l.x+18,y:l.y+10});await a.clock.fastForward(32);await a.screenshot({path:path.join(out,`surface-${mode}-hover.png`)})
 const unhovered=pixels(path.join(out,`surface-${mode}-gpuix.png`)),hovered=pixels(path.join(out,`surface-${mode}-hover.png`));let hoverPixels=0
 for(let y=Math.floor(l.y*2);y<(l.y+l.height)*2;y++)for(let x=Math.floor(l.x*2);x<(l.x+90)*2;x++){const c=unhovered.at(x,y),d=hovered.at(x,y);if(c.some((v,i)=>Math.abs(v-d[i]!)>20))hoverPixels++}
 assert.ok(hoverPixels>40,`Hover must paint an underline, changed=${hoverPixels}`)
 await a.mouse.down({x:l.x+18,y:l.y+10});await a.mouse.up({x:l.x+18,y:l.y+10});await a.clock.fastForward(32)
 assert.equal(await a.getByTestId("clicked").textContent(),"https://example.com/one")
 await a.mouse.wheel({x:100,y:470},0,-55);await a.clock.fastForward(32);await a.screenshot({path:path.join(out,`surface-${mode}-scroll.png`)})
 await a.getByTestId("toggle").click();await a.clock.fastForward(32);await a.screenshot({path:path.join(out,`surface-${mode}-hidden.png`)})
 await a.getByTestId("toggle").click();await a.clock.fastForward(32);await a.clock.fastForward(32);assert.ok((await a.getByTestId("glass").textContent()).includes("Floating surface"))
 console.log(`ok ${mode}: anchored backdrop, hover and link click, scrolling, hide/remount`)
 }catch(e){console.error(f.diagnostics());throw e}finally{await f.close()}
 const off=await launchFixture(path.join(import.meta.dir,"surface-lab.tsx"),{KYBERN_APPEARANCE:mode,GPUIX_BACKGROUND:"1",SURFACE_DISABLE:"1"})
 try{await off.app.getByTestId("glass").waitFor();await off.app.mouse.move({x:5,y:590});await off.app.screenshot({path:path.join(out,`surface-${mode}-off.png`)})}finally{await off.close()}
 const on=pixels(path.join(out,`surface-${mode}-gpuix.png`)),plain=pixels(path.join(out,`surface-${mode}-off.png`));let changed=0
 for(let y=270;y<760;y++)for(let x=365;x<1115;x++){const c=on.at(x,y),d=plain.at(x,y);if(c.some((v,i)=>Math.abs(v-d[i]!)>8))changed++}
 assert.ok(changed>5000,`Filter must change actual backdrop pixels, changed=${changed}`)
 console.log(mode,"filtered pixels",changed)
}

for(const off of ['0','1']){
 const f=await launchFixture(path.join(import.meta.dir,'filter-geometry.tsx'),{GPUIX_BACKGROUND:'1',FILTER_OFF:off})
 try{await f.app.getByTestId('ready').waitFor();await f.app.screenshot({path:path.join(out,`filter-geometry-${off}.png`)})}finally{await f.close()}
}
const on=pixels(path.join(out,'filter-geometry-0.png')),off=pixels(path.join(out,'filter-geometry-1.png'))
const same=(x:number,y:number)=>assert.deepEqual(on.at(x*2,y*2),off.at(x*2,y*2),`Outside/hidden filter at ${x},${y}`)
same(120,240);same(420,100);same(310,100);same(81,61)
assert.notDeepEqual(on.at(360*2,100*2),off.at(360*2,100*2),'Clipped region must still blur')
const gray=on.at(350*2,240*2);assert.ok(Math.abs(gray[0]!-gray[1]!)<3&&Math.abs(gray[1]!-gray[2]!)<3,'Saturation zero must remove chroma')
assert.notDeepEqual(on.at(120*2,390*2),off.at(120*2,390*2),'Cached filter must paint')
const top=on.at(520*2,200*2),raw=off.at(520*2,200*2);assert.ok(top.every((v,i)=>Math.abs(v-raw[i]!)<4),'Caption blur fades in from transparent top');assert.notDeepEqual(on.at(520*2,280*2),off.at(520*2,280*2),'Caption blur reaches full strength below fade')
console.log('ok generic bounds/radius, ancestor clipping, opacity-zero skip, saturation-only, cached filter and caption fade')
