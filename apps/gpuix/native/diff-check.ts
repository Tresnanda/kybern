import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import {launchFixture,waitForPainted} from '../src/requests/harness.ts'
for(const mode of ['dark','light']) {
 const f=await launchFixture(import.meta.dir+'/diff-lab.tsx',{KYBERN_APPEARANCE:mode,GPUIX_BACKGROUND:'1'})
 try {await f.app.getByTestId('ready').waitFor();await waitForPainted(f.app,'Updated instructions');
 await f.app.screenshot({path:`/Users/mymac/projects/ade/previews/gpuix/p1f/diff-${mode}-gpuix.png`});
 assert.ok((await f.app.call('getPaintedText',{})).text.join('\n').includes('Lines 25–26'))
 const bounds=await f.app.getByTestId('sample').bounds()
 await f.app.mouse.click({x:bounds.x+20,y:bounds.y+36});await f.app.clock.fastForward(32)
 assert.equal(await f.app.getByTestId('result').textContent(),'old:1 new:-')
 await f.app.mouse.click({x:bounds.x+42,y:bounds.y+36});await f.app.clock.fastForward(32)
 assert.equal(await f.app.getByTestId('result').textContent(),'old:- new:1')
 await f.app.mouse.wheel({x:bounds.x+200,y:bounds.y+60},-100000,0);await f.app.clock.fastForward(64)
 await f.app.screenshot({path:`/Users/mymac/projects/ade/previews/gpuix/p1f/diff-scroll-${mode}.png`})
 await f.app.getByTestId('diff-header-src/greeting.ts').click();await f.app.clock.fastForward(64)
 assert.equal(await f.app.getByTestId('sample').count(),0)
 await f.app.getByTestId('diff-header-src/greeting.ts').click();await waitForPainted(f.app,'Greeting factory')
 console.log(`ok ${mode}: formatted hunk labels, explicit old/new context-line anchors, file collapse/reopen, header remains accessible after horizontal scroll`)

 }finally{await f.close()}
}

const f=await launchFixture(import.meta.dir+'/diff-lab.tsx',{DIFF_LARGE:'1',GPUIX_BACKGROUND:'1'})
try {
 await f.app.getByTestId('ready').waitFor();await waitForPainted(f.app,'line0')
 const initial=(await f.app.call('getPaintedText',{})).text
 assert.ok(initial.length<500,`unbounded initial paint: ${initial.length}`)
 await f.app.mouse.wheel({x:300,y:300},0,-1000000);await f.app.clock.fastForward(64);await waitForPainted(f.app,'line29999')
 const final=(await f.app.call('getPaintedText',{})).text
 assert.ok(final.length<500,`unbounded final paint: ${final.length}`)
 console.log(`ok 30,000-line diff: ${initial.length} initial / ${final.length} final painted fragments; last line reachable`)
}finally{await f.close()}

const expanded=await launchFixture(import.meta.dir+'/diff-lab.tsx',{DIFF_EXPAND:'1',GPUIX_BACKGROUND:'1'})
try {
 const app=expanded.app;await app.getByTestId('ready').waitFor();await waitForPainted(app,'line0')
 const b=await app.getByTestId('sample').bounds()
 await app.mouse.wheel({x:b.x+200,y:b.y+80},0,-1000000);await app.clock.fastForward(64)
 await waitForPainted(app,'Show 600 more lines')
 await app.mouse.click({x:b.x+b.width/2,y:b.y+b.height-15});await app.clock.fastForward(64)
 await app.mouse.wheel({x:b.x+200,y:b.y+80},0,-1000000);await app.clock.fastForward(64)
 await waitForPainted(app,'line1199')
 assert.ok((await app.call('getPaintedText',{})).text.length<500)
 console.log('ok bounded expansion: Show 600 more lines extends through line1199 without mounting full history')
}finally{await expanded.close()}
