import assert from 'node:assert/strict'
import path from 'node:path'
import {mkdirSync,writeFileSync} from 'node:fs'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {launchFixture} from './loops8-harness.ts'
import {pixels} from '../native/png.ts'
import {pacingLock} from './loops8-lock.ts'
import {waitForNativeBuilds} from './loops8-build-free.ts'
const exec=promisify(execFile),out='/Users/mymac/projects/ade/previews/gpuix/round8/loops/spinner'
mkdirSync(out,{recursive:true})
await waitForNativeBuilds()
const release=await pacingLock()
try{for(const theme of ['dark','light'])for(const reduced of ['0','1']){
 const f=await launchFixture(path.join(import.meta.dir,'loops8-lab.tsx'),{GPUIX_BACKGROUND:'1',KYBERN_APPEARANCE:theme,KYBERN_REDUCED_MOTION:reduced,KYBERN_NATIVE_PAINT_ANIMATIONS:'1',KYBERN_NATIVE_TEXT_PAINT:'1',KYBERN_REGION_PAINT:'1',KYBERN_FULL_RATE:'1',KYBERN_VSYNC_WAKE:'1',KYBERN_REGION_TEXT_TEST:'1',KYBERN_FRAME_TIMES:'1',NAPI_RS_NATIVE_LIBRARY_PATH:path.resolve('native/build/gpuix-native.darwin-arm64.node')})
 try{
  const a=f.app;await a.getByTestId('spinner').waitFor()
  const windowId=(await exec('swift',[path.resolve('native/surface-window-id.swift'),String(f.pid),'3'])).stdout.trim()
  const boxes=await Promise.all(['spinner','task-glyph'].map(id=>a.getByTestId(id).bounds()))
  const states:string[][]=[[],[]],files:string[]=[]
  for(let i=0;i<10;i++){
   const file=`${out}/${theme}-${reduced}-${i}.png`;await exec('screencapture',['-x','-o','-l',windowId,file]);files.push(file)
   const image=pixels(file),scale=image.w/560,top=image.h-320*scale
   boxes.forEach((b,index)=>{const values:number[]=[];for(let y=0;y<14;y++)for(let x=0;x<14;x++)values.push(...image.at((b.x+x)*scale,top+(b.y+y)*scale));states[index]!.push(values.join(','))})
   await Bun.sleep(80)
  }
  states.forEach((values,index)=>assert.equal(new Set(values).size>1,reduced==='0',`${index===0?'spinner':'task glyph'} ${theme} reduced=${reduced}`))
  // Capture-free display-submission sample. Both actual components are mounted.
  await waitForNativeBuilds()
  const mark=f.frameTimes().at(-1)??0;await Bun.sleep(3000)
  const times=f.frameTimes().filter(v=>v>mark),dt=times.slice(1).map((v,i)=>v-times[i]!).sort((a,b)=>a-b)
  const root=(await a.getByTestId('app-ready').element()).id
  await a.call('keyDown',{elementId:root,key:'p'});await Bun.sleep(150)
  await waitForNativeBuilds()
  const spinnerMark=f.frameTimes().at(-1)??0;await Bun.sleep(3000)
  const spinnerTimes=f.frameTimes().filter(v=>v>spinnerMark),spinnerDt=spinnerTimes.slice(1).map((v,i)=>v-spinnerTimes[i]!).sort((a,b)=>a-b)
  const isolatedSpinner={frames:spinnerTimes.length,p50:spinnerDt[Math.floor(spinnerDt.length*.5)]??null,p95:spinnerDt[Math.floor(spinnerDt.length*.95)]??null}
  if(reduced==='0')assert.ok(spinnerTimes.length>150,'isolated spinner did not sustain display-rate frames')
  else assert.equal(spinnerTimes.length,0,'reduced isolated spinner kept drawing')
  const result={theme,reduced,isolatedSpinner,frames:times.length,p50:dt[Math.floor(dt.length*.5)]??null,p95:dt[Math.floor(dt.length*.95)]??null,distinctPixels:states.map(v=>new Set(v).size),files}
  writeFileSync(`${out}/${theme}-${reduced}.json`,JSON.stringify(result,null,2));console.log(JSON.stringify({...result,files:undefined}))
 }finally{await f.close()}
}}finally{release()}
