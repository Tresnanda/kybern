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
for(const theme of ['dark','light'])for(const reduced of ['0','1']) {
 const captures:string[][]=[],memory:unknown[]=[]
 for(const enabled of ['0','1']) {
  const f=await launchFixture(path.join(import.meta.dir,'frame-lab.tsx'),{GPUIX_BACKGROUND:'1',KYBERN_APPEARANCE:theme,KYBERN_REDUCED_MOTION:reduced,KYBERN_REGION_PAINT:enabled,KYBERN_NATIVE_PAINT_ANIMATIONS:'1',KYBERN_FULL_RATE:'1',KYBERN_VSYNC_WAKE:'1',KYBERN_PAINT_PHASE_MS:'300',KYBERN_DEBUG_REGION:'1',KYBERN_FRAME_TIMES:'1'})
  const a=f.app,files:string[]=[]
  try {
   await a.getByTestId('loops').waitFor({timeoutMs:30000})
   const windowId=(await exec('swift',[path.join(import.meta.dir,'surface-window-id.swift'),String(f.pid),'3'])).stdout.trim()
   const root=(await a.getByTestId('app-ready').element()).id
   const key=async(key:string)=>{await a.call('keyDown',{elementId:root,key})}
   const settle=async()=>{const deadline=Date.now()+3000;let previous=f.counts().frames;for(;;){await Bun.sleep(40);const now=f.counts().frames;if(reduced==='1'||now>previous)return;assert.ok(Date.now()<deadline,'display stopped');previous=now}}
   const capture=async(name:string)=>{await settle();const file=`${out}/${theme}-${reduced}-${enabled}-${name}.png`;await exec('screencapture',['-x','-o','-l',windowId,file]);files.push(file)}
   await capture('initial');await key('c');await capture('recolored');await key('g');await capture('geometry')
   const active=footprintMiB(f.pid)
   await key('f');await a.getByTestId('filter').waitFor();await capture('filter');await key('f')
   await key('m');await Bun.sleep(1500);const parked=f.counts().frames;await Bun.sleep(500);assert.equal(f.counts().frames,parked,'occluded window kept drawing')
   const occluded=footprintMiB(f.pid)
   await key('r');await capture('resumed')
   await key('h');await Bun.sleep(300);const unmounted=footprintMiB(f.pid)
   if(enabled==='1'&&reduced==='0')assert.match(f.diagnostics(),/\[paint-region\] release/,'retained target never released')
   memory.push({enabled,active,occluded,unmounted});captures.push(files)
  }catch(e){console.error(f.diagnostics());throw e}finally{await f.close()}
 }
 const results=[]
 for(let state=0;state<captures[0]!.length;state++) {
  const base=pixels(captures[0]![state]!),candidate=pixels(captures[1]![state]!)
  assert.equal(candidate.w,base.w);assert.equal(candidate.h,base.h)
  const diff=Buffer.alloc((base.w*3+1)*base.h);let different=0,maxDelta=0
  const top=base.h-240*(base.w/560)
  for(let y=0;y<base.h;y++)for(let x=0;x<base.w;x++) {
   const a=base.at(x,y),b=candidate.at(x,y),delta=a.map((value,i)=>Math.abs(value-b[i]!))
   if(y>=top){maxDelta=Math.max(maxDelta,...delta);if(delta.some(v=>v>1))different++}
   for(let i=0;i<3;i++)diff[y*(base.w*3+1)+1+x*3+i]=y>=top?Math.min(255,delta[i]!*16):0
  }
  diffPng(`${out}/${theme}-${reduced}-${state}-diff.png`,base.w,base.h,diff)
  results.push({state,different,maxDelta})
  assert.equal(different,0,`${theme} reduced=${reduced} state${state}: region pixels differ from full draw`)
 }
 writeFileSync(`${out}/${theme}-${reduced}-result.json`,JSON.stringify({theme,reduced,results,memory,captures},null,2))
 console.log(`PASS ${theme} reduced=${reduced}: complete client pixels, geometry/filter fallback, occlusion, unmount`,JSON.stringify(memory))
}
