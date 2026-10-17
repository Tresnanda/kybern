import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import path from 'node:path'
import {mkdirSync,writeFileSync} from 'node:fs'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {launchFixture} from './frame-harness.ts'
import {pixels} from './png.ts'
const exec=promisify(execFile),out=process.env.KYBERN_VERIFY_OUTPUT??path.join(import.meta.dir,'build/text-check')
mkdirSync(out,{recursive:true})
for(const theme of ['dark','light'])for(const reduced of ['0','1']) {
 const f=await launchFixture(path.join(import.meta.dir,'paint-text-lab.tsx'),{GPUIX_BACKGROUND:'1',KYBERN_APPEARANCE:theme,KYBERN_REDUCED_MOTION:reduced,KYBERN_NATIVE_PAINT_ANIMATIONS:'1',KYBERN_NATIVE_TEXT_PAINT:'1',KYBERN_FULL_RATE:'1',KYBERN_VSYNC_WAKE:'1',KYBERN_REGION_PAINT:'1',KYBERN_FRAME_TIMES:'1'})
 const a=f.app
 try {
  await a.getByTestId('app-ready').waitFor({timeoutMs:30000})
  const root=(await a.getByTestId('app-ready').element()).id,b=await a.getByTestId('shimmer-frame').bounds()
  const windowId=(await exec('swift',[path.join(import.meta.dir,'surface-window-id.swift'),String(f.pid),'3'])).stdout.trim()
  const values:number[]=[],files:string[]=[]
  const capture=async(name:string)=>{const file=`${out}/${theme}-${reduced}-${name}.png`;await exec('screencapture',['-x','-o','-l',windowId,file]);return file}
  for(let i=0;i<8;i++) {
   const file=await capture(String(i)),p=pixels(file),scale=p.w/400,top=p.h-220*scale
   let ink=theme==='dark'?0:255
   for(let y=b.y*scale;y<(b.y+b.height)*scale;y++)for(let x=b.x*scale;x<(b.x+b.width)*scale;x++){const v=p.at(x,top+y)[0]!;ink=theme==='dark'?Math.max(ink,v):Math.min(ink,v)}
   values.push(ink);files.push(file);await Bun.sleep(100)
  }
  assert.equal(new Set(values).size>1,reduced==='0',`text pulse ${theme} reduce=${reduced}: ${values}`)
  await a.mouse.drag({x:b.x+2,y:b.y+12},{x:b.x+180,y:b.y+12},{steps:8})
  const selected=(await a.call('getSelectedText',{})).text
  assert.ok(selected?.length,'native text lost selection')
  await Bun.sleep(300);assert.equal((await a.call('getSelectedText',{})).text,selected)
  await a.call('clearSelection',{})
  await a.getByTestId('input').fill('focus survives');await Bun.sleep(300);await a.getByTestId('input').press('End');await a.getByTestId('input').press('!')
  await a.getByText('focus survives!').waitFor()
  await a.getByTestId('park').click();await a.call('keyDown',{elementId:root,key:'h'})
  await Bun.sleep(500);const before=f.counts().frames;await Bun.sleep(500);assert.equal(f.counts().frames,before,'unmounted text kept presenting')
  writeFileSync(`${out}/${theme}-${reduced}.json`,JSON.stringify({theme,reduced,values,files,selected},null,2))
  console.log(`PASS ${theme} reduce=${reduced}: text pixels, native selection, focus and unmount idle`)
 }catch(e){console.error(f.diagnostics());throw e}finally{await f.close()}
}
