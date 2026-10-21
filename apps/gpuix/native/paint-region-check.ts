import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import path from 'node:path'
import {mkdirSync,writeFileSync} from 'node:fs'
import {deflateSync} from 'node:zlib'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {launchFixture} from './frame-harness.ts'
import {pixels} from './png.ts'
import {footprintMiB} from '../scripts/idle-metrics.ts'
const exec=promisify(execFile),out=process.env.KYBERN_VERIFY_OUTPUT??path.join(import.meta.dir,'build/region-check')
mkdirSync(out,{recursive:true})
function diffPng(file:string,w:number,h:number,data:Buffer){
 const crc=(b:Buffer)=>{let c=0xffffffff;for(const byte of b){c^=byte;for(let i=0;i<8;i++)c=(c>>>1)^(c&1?0xedb88320:0)}return(c^0xffffffff)>>>0}
 const chunk=(type:string,b:Buffer)=>{const head=Buffer.alloc(8),tail=Buffer.alloc(4);head.writeUInt32BE(b.length);head.write(type,4);tail.writeUInt32BE(crc(Buffer.concat([Buffer.from(type),b])));return Buffer.concat([head,b,tail])}
 const header=Buffer.alloc(13);header.writeUInt32BE(w);header.writeUInt32BE(h,4);header[8]=8;header[9]=2
 writeFileSync(file,Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(data)),chunk('IEND',Buffer.alloc(0))]))
}
for(const theme of process.env.KYBERN_CHECK_THEMES?.split(',')??['dark','light'])for(const reduced of process.env.KYBERN_CHECK_REDUCED?.split(',')??['0','1']) {
 const captures:string[][]=[],memory:unknown[]=[]
 for(const enabled of ['0','1']) {
  const f=await launchFixture(path.join(import.meta.dir,'frame-lab.tsx'),{GPUIX_BACKGROUND:'1',KYBERN_APPEARANCE:theme,KYBERN_REDUCED_MOTION:reduced,KYBERN_REGION_PAINT:enabled,KYBERN_NATIVE_PAINT_ANIMATIONS:'1',KYBERN_NATIVE_TEXT_PAINT:'1',KYBERN_REGION_TEXT_TEST:'1',KYBERN_REGION_TIGHT_DOTS:'1',KYBERN_REGION_IMAGE_TEST:'1',KYBERN_FULL_RATE:'1',KYBERN_VSYNC_WAKE:'1',KYBERN_PAINT_PHASE_MS:'300',KYBERN_DEBUG_REGION:'1',KYBERN_FRAME_TIMES:'1'})
  const a=f.app,files:string[]=[]
  try {
   await a.getByTestId('loops').waitFor({timeoutMs:30000})
   const windowId=(await exec('swift',[path.join(import.meta.dir,'surface-window-id.swift'),String(f.pid),'3'])).stdout.trim()
   const root=(await a.getByTestId('app-ready').element()).id
   const key=async(key:string)=>{await a.call('keyDown',{elementId:root,key})}
   const settle=async()=>{const deadline=Date.now()+3000;let previous=f.counts().frames;for(;;){await Bun.sleep(40);const now=f.counts().frames;if(reduced==='1'||now>previous)return;assert.ok(Date.now()<deadline,'display stopped');previous=now}}
   const capture=async(name:string,width=560)=>{
    await settle();const file=`${out}/${theme}-${reduced}-${enabled}-${name}.png`,deadline=Date.now()+5000
    for(;;){
     // A window just restored from the Dock (or not yet composited) cannot be captured yet; Reduce Motion's settle()
     // does not wait for frames, so retry until WindowServer has it on screen again.
     try{await exec('screencapture',['-x','-o','-l',windowId,file])}catch(error){assert.ok(Date.now()<deadline,`window capture kept failing: ${error}`);await Bun.sleep(60);continue}
     const p=pixels(file),original=files.length?pixels(files[0]!):null;if(!original||p.w===original.w*width/560){if(name!=='initial')break;const b=await a.getByTestId('region-image').bounds(),scale=p.w/width,rgb=p.at((b.x+200)*scale,p.h-240*scale+(b.y+20)*scale);if(rgb[0]!>rgb[2]!+20)break;}assert.ok(Date.now()<deadline,'WindowServer/image did not reach requested state');await Bun.sleep(40)}
    files.push(file)
   }
   await capture('initial');await key('c');await capture('recolored');await key('g');await capture('geometry')
   if(enabled==='1'&&reduced==='0'&&process.env.KYBERN_REGION_EXPECT_DISJOINT==='1')assert.match(f.diagnostics(),/\[paint-gpu\].*regions=[2-9]/,'pixel comparison did not exercise disjoint damage')
   if(enabled==='1'&&reduced==='0'&&process.env.KYBERN_REGION_EXPECT_LAYERS==='1')assert.match(f.diagnostics(),/\[paint-region\] layers [1-9]/,'pixel comparison did not exercise cropped presentation')
   if(enabled==='1'&&reduced==='0'&&process.env.KYBERN_REGION_EXPECT_DIRECT==='1')assert.match(f.diagnostics(),/\[paint-gpu\] stage=(?:crop|atlas) /,'pixel comparison did not exercise direct cropped rendering')
   if(enabled==='1'&&reduced==='0'&&process.env.KYBERN_REGION_EXPECT_ATLAS==='1')assert.match(f.diagnostics(),/\[paint-gpu\] stage=atlas /,'pixel comparison did not exercise packed atlas rendering')
   assert.doesNotMatch(f.diagnostics(),/atlas-backpressure|atlas-error/,'atlas dropped or failed a visual update')
   const active=footprintMiB(f.pid)
   await key('f');await a.getByTestId('filter').waitFor();await capture('filter');await key('f')
   await key('m');await Bun.sleep(1500);const parked=f.counts().frames;await Bun.sleep(500);assert.equal(f.counts().frames,parked,'occluded window kept drawing')
   const occluded=footprintMiB(f.pid)
   await key('r');await capture('resumed')
   await key('w');await capture('resized',840);await key('w');await capture('size-restored')
   const releases=f.regions().filter(line=>line.includes('release')).length
   await key('h');await Bun.sleep(300);const unmounted=footprintMiB(f.pid)
   const parkedFrames=f.counts().frames;await Bun.sleep(500);assert.equal(f.counts().frames,parkedFrames,'unmounted loops kept drawing')
   if(enabled==='1'&&reduced==='0')assert.ok(f.regions().filter(line=>line.includes('release')).length>releases,'unmount did not release this retained target')
   if(enabled==='1'&&reduced==='0')assert.match(f.diagnostics(),/\[paint-region\] release/,'retained target never released')
   writeFileSync(`${out}/${theme}-${reduced}-${enabled}-diagnostics.log`,f.diagnostics())
   memory.push({enabled,active,occluded,unmounted});captures.push(files)
  }catch(e){console.error(f.diagnostics());throw e}finally{await f.close()}
 }
 const results=[]
 for(let state=0;state<captures[0]!.length;state++) {
  const base=pixels(captures[0]![state]!),candidate=pixels(captures[1]![state]!)
  assert.equal(candidate.w,base.w);assert.equal(candidate.h,base.h)
  const diff=Buffer.alloc((base.w*3+1)*base.h);let different=0,maxDelta=0,windowServerDifferent=0
  const logicalWidth=state===5?840:560,logicalHeight=state===5?320:240
  const top=base.h-logicalHeight*(base.w/logicalWidth)
  for(let y=0;y<base.h;y++)for(let x=0;x<base.w;x++) {
   const a=base.at(x,y),b=candidate.at(x,y),delta=a.map((value,i)=>Math.abs(value-b[i]!))
   // WindowServer owns the frame and its continuous bottom corner masks.
   // Restoring a window can change their antialiasing with region paint off
   // in both reduced-motion runs. Keep their raw differences in the PNG/count.
   const chrome=x<2||x>=base.w-2||y>=base.h-2||(y>=base.h-52&&(x<52||x>=base.w-52))
   if(y>=top){if(!chrome){maxDelta=Math.max(maxDelta,...delta);if(delta.some(v=>v>1))different++}else if(delta.some(v=>v>1))windowServerDifferent++}
   for(let i=0;i<3;i++)diff[y*(base.w*3+1)+1+x*3+i]=y>=top?Math.min(255,delta[i]!*16):0
  }
  diffPng(`${out}/${theme}-${reduced}-${state}-diff.png`,base.w,base.h,diff)
  results.push({state,different,maxDelta,windowServerDifferent})
  assert.equal(different,0,`${theme} reduced=${reduced} state${state}: region pixels differ from full draw`)
 }
 writeFileSync(`${out}/${theme}-${reduced}-result.json`,JSON.stringify({theme,reduced,results,memory,captures},null,2))
 console.log(`PASS ${theme} reduced=${reduced}: complete client pixels, geometry/filter fallback, occlusion, unmount`,JSON.stringify(memory))
}
