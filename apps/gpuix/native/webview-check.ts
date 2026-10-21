import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { launchFixture } from '../src/requests/harness.ts'
import { acquirePreviewUiLock } from '../scripts/preview-ui-lock.ts'
import { COMPANION_CFLAGS } from '../scripts/companion-flags.ts'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/previews/gpuix/round5/preview'
mkdirSync(out,{recursive:true})
execFileSync('clang',['-dynamiclib',...COMPANION_CFLAGS,'-framework','Cocoa',path.join(import.meta.dir,'webview-input.m'),'-o',path.join(import.meta.dir,'build/webview-input.dylib')])
const releaseUi = process.env.KYBERN_CLIP_LOCK_HELD ? () => {} : acquirePreviewUiLock()
try { for(const appearance of ['dark','light']) {
  const fixture=await launchFixture(path.join(import.meta.dir,'webview-lab.tsx'),{GPUIX_BACKGROUND:'1',KYBERN_APPEARANCE:appearance})
  const a=fixture.app
  try {
    await a.getByTestId('app-ready').waitFor();await Bun.sleep(2000)
    const inspect=async()=>{await a.getByTestId('action-i').click();return JSON.parse(await a.getByTestId('result').textContent()) as any[]}
    let log=await inspect();assert.ok(log.some(e=>e.type==='created'),fixture.diagnostics());assert.ok(log.some(e=>e.data?.kind==='lab'),JSON.stringify(log))
    const identity=log.find(e=>e.data?.kind==='lab').data.identity
    const root=(await a.getByTestId('app-ready').element()).id
    if(process.env.KYBERN_ROUNDED_WEBVIEW==='1'){
      await a.call('keyDown',{elementId:root,key:'q'})
      assert.deepEqual(JSON.parse(await a.getByTestId('result').textContent()),{corner:false,inside:true},'AppKit rounded ancestor mask must exclude the corner from native web input')
    }
    for(const key of ['c','f','t']){await a.call('keyDown',{elementId:root,key});await Bun.sleep(200)}
    log=await inspect();assert.ok(log.some(e=>e.data?.kind==='lab'&&e.data.count===1),'Native button click did not reach WKWebView');assert.ok(log.some(e=>e.data?.input==='kept text'),'Native text insertion did not reach WKWebView')
    await a.call('keyDown',{elementId:root,key:'s'});await Bun.sleep(200);log=await inspect();assert.ok(log.some(e=>e.type==='shortcut'&&e.key==='l'),'Command-L did not escape focused web input')
    await a.call('keyDown',{elementId:root,key:'x'});await Bun.sleep(200);log=await inspect();assert.ok(log.some(e=>e.type==='externalNavigation'&&e.url==='https://example.com/'),'External navigation was not blocked')
    const windowNumber=log.find(e=>e.type==='created').windowNumber
    const shot=(name:string)=>execFileSync('screencapture',['-l',String(windowNumber),'-x',path.join(out,`${name}-${appearance}.png`)])
    shot('host-dock')
    for(let n=0;n<6;n++){await a.getByTestId('action-m').click();await Bun.sleep(100)}
    const reports=log.filter(e=>e.data?.kind==='lab').length
    log=await inspect();assert.equal(log.filter(e=>e.type==='created').length,1);assert.equal(log.filter(e=>e.data?.kind==='lab').length,reports,'Dock/mini caused a reload')
    assert.equal(log.find(e=>e.data?.kind==='lab').data.identity,identity)
    await a.getByTestId('action-p').click();await Bun.sleep(300);shot('host-menu')
    await a.getByTestId('action-p').click();await a.getByTestId('action-h').click();await Bun.sleep(300)
    log=await inspect();assert.ok(log.some(e=>e.data?.kind==='host-state'&&e.data.visible===false),'Hidden page did not receive pause')
    await a.getByTestId('action-h').click();await Bun.sleep(300);log=await inspect();assert.equal(log.filter(e=>e.data?.kind==='lab').length,reports)
    // N3: the document fades and scales in Core Animation (`present`): sampled presentation values rise to rest.
    await a.call('keyDown',{elementId:root,key:'e'})
    const samples:{opacity:number;scale:number;animating:boolean}[]=[]
    const probes=async()=>(await inspect()).filter(e=>e.type==='probe')
    for(const wait of [40,80,500]){
      await Bun.sleep(wait);const before=(await probes()).length;await a.call('keyDown',{elementId:root,key:'g'})
      let found:any[]=[];for(let n=0;n<40&&found.length<=before;n++){await Bun.sleep(25);found=await probes()}
      assert.ok(found.length>before,'No probe event from the native document');samples.push(found.at(-1).data)
    }
    assert.ok(samples[0]!.opacity>0&&samples[0]!.opacity<1&&samples[0]!.scale>=0.96&&samples[0]!.scale<1&&samples[0]!.animating,`The document did not start its fade and scale: ${JSON.stringify(samples)}`)
    assert.ok(samples[1]!.opacity>=samples[0]!.opacity&&samples[1]!.scale>=samples[0]!.scale,`The fade went backwards: ${JSON.stringify(samples)}`)
    assert.ok(samples[2]!.opacity===1&&Math.abs(samples[2]!.scale-1)<1e-6,`The document did not come to rest: ${JSON.stringify(samples)}`)
    console.log(`PASS ${appearance}: present ${samples.map(s=>`${s.opacity.toFixed(2)}@${s.scale.toFixed(3)}`).join(' -> ')}`)
    console.log(`PASS ${appearance}: native pointer/text/Command-L; external navigation blocked; stable document after 6 dock/mini moves and hide/show; visibility messages; menu fixture`)
  }catch(e){console.error(fixture.diagnostics());throw e}finally{
    await fixture.close()
    const deadline = Date.now() + 3000
    for (;;) {
      try { process.kill(fixture.pid, 0) } catch { break }
      if (Date.now() > deadline) throw Error('Native web fixture did not stop before releasing UI lock')
      await Bun.sleep(30)
    }
  }
}
} finally { releaseUi() }
