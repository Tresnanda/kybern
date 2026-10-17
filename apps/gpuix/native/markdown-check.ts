import '../src/native/local-build.ts'
import {launchFixture,waitForPainted} from '../src/requests/harness.ts'
import path from 'node:path'
import assert from 'node:assert/strict'
import {pixels} from './png.ts'
import {mkdirSync} from 'node:fs'
const out='/Users/mymac/projects/ade/previews/gpuix/p1e'
mkdirSync(out,{recursive:true})
for(const mode of ['dark','light']) for(const wrap of ['0','1']) {
 const f=await launchFixture(path.join(import.meta.dir,'markdown-lab.tsx'),{KYBERN_APPEARANCE:mode,GPUIX_BACKGROUND:'1',MD_WRAP:wrap})
 try {await f.app.getByTestId('ready').waitFor();await waitForPainted(f.app,'Markdown parity');await f.app.screenshot({path:path.join(out,`markdown-${wrap==='1'?'wrap-':''}${mode}-gpuix.png`)});console.log('captured',mode)} finally {await f.close()}
}

for(const mode of ['dark','light']) {
 const f=await launchFixture(path.join(import.meta.dir,'markdown-lab.tsx'),{KYBERN_APPEARANCE:mode,GPUIX_BACKGROUND:'1',MD_CHECK:'1'}),a=f.app
 try {
 await a.getByTestId('check-ready').waitFor();await waitForPainted(a,'😀é')
 const inline=await a.getByTestId('inline').bounds()
 await a.mouse.down({x:inline.x,y:inline.y+10});await a.mouse.move({x:inline.x+290,y:inline.y+10},{pressedButton:0});await a.mouse.up({x:inline.x+290,y:inline.y+10})
 await a.getByTestId('check-ready').press('g')
 const selection=JSON.parse(await a.getByTestId('result').textContent());assert.equal(selection.text,'one 😀é two','Inline padding must not add text/newlines')
 await a.getByTestId('check-ready').press('h');const washes=JSON.parse(await a.getByTestId('result').textContent())
 assert.equal(washes.map((w:any)=>w.text.slice(w.start,w.end)).join(''),'one inline code two','Search match must span the paragraph fragments')
 assert.equal(washes.find((w:any)=>w.text==='inline code')?.rects.length,1,'A fitting code span must not wrap after pixel snapping');
 assert.ok((await a.getByTestId('hardbreak').bounds()).height>40,'Hard breaks retain their second line');
 await a.getByTestId('check-ready').press('r');await a.clock.fastForward(32);await a.getByTestId('check-ready').press('g');assert.equal(JSON.parse(await a.getByTestId('result').textContent()).text,'one 😀é two','Reflow retains selection identity');await a.getByTestId('check-ready').press('r')
 const before=await a.getByTestId('wrap-code').bounds()
 await a.getByTestId('wrap').click();await a.clock.fastForward(32)
 const after=await a.getByTestId('wrap-code').bounds();assert.ok(after.height>before.height+30,`Wrap must grow code: ${before.height} -> ${after.height}`)
 const file=path.join(out,`capability-${mode}.png`);await a.screenshot({path:file});const grid=pixels(file)
 await a.getByTestId('grid').click();await a.clock.fastForward(32)
 const file2=path.join(out,`capability-${mode}-no-grid.png`);await a.screenshot({path:file2});const plain=pixels(file2)
 let redBefore=0,redAfter=0
 for(let y=0;y<grid.h;y++)for(let x=0;x<grid.w;x++){const c=grid.at(x,y),d=plain.at(x,y);if(c[0]!>240&&c[1]!<20&&c[2]!<20)redBefore++;if(d[0]!>240&&d[1]!<20&&d[2]!<20)redAfter++}
 assert.ok(redBefore>redAfter+500,'Grid adds actual outer/vertical borders')
 console.log(`ok ${mode}: exact Unicode selection across padded boxes, paragraph search, code wrap ${before.height} -> ${after.height}, grid paint`)
 }catch(e){console.error(f.diagnostics());throw e}finally{await f.close()}
}

{
 const f=await launchFixture(path.join(import.meta.dir,'markdown-lab.tsx'),{GPUIX_BACKGROUND:'1',MD_LARGE:'1',MD_LARGE_CHECK:'1'})
 try {await f.app.getByTestId('ready').waitFor();await f.app.mouse.wheel({x:300,y:300},0,-1000000);await f.app.clock.fastForward(64);await waitForPainted(f.app,'sentinel');const text=(await f.app.call('getPaintedText',{})).text;assert.ok(text.includes('sentinel'));console.log('ok large Markdown: final padded inline code remains reachable after scrolling')}finally{await f.close()}
}
