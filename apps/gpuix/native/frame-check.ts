import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import path from 'node:path'
import {mkdirSync,writeFileSync} from 'node:fs'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {pixels} from './png.ts'
import {launchFixture} from './frame-harness.ts'
const exec=promisify(execFile),out=process.env.KYBERN_VERIFY_OUTPUT??path.join(import.meta.dir,'build','frame-check');mkdirSync(out,{recursive:true})
for(const theme of process.env.KYBERN_CHECK_THEMES?.split(',')??['dark','light'])for(const reduced of process.env.KYBERN_CHECK_REDUCED?.split(',')??['0','1']){
 const f=await launchFixture(path.join(import.meta.dir,'frame-lab.tsx'),{GPUIX_BACKGROUND:'1',KYBERN_APPEARANCE:theme,KYBERN_REDUCED_MOTION:reduced,KYBERN_FRAME_TIMES:'1',KYBERN_DEBUG_ISLANDS:'1',KYBERN_FULL_RATE:'1',KYBERN_VSYNC_WAKE:'1'})
 const a=f.app
 try{
  await a.getByTestId('app-ready').waitFor({timeoutMs:30000});await a.getByTestId('loops').waitFor()
  const root=(await a.getByTestId('app-ready').element()).id,key=async(key:string)=>{await a.call('keyDown',{elementId:root,key})}
  const windowId=(await exec('swift',[path.join(import.meta.dir,'surface-window-id.swift'),String(f.pid),'3'])).stdout.trim()
  await Bun.sleep(500)
  const start=performance.now(),shots:{file:string;time:number}[]=[]
  for(let i=0;i<10;i++){
   const file=path.join(out,`loops-${theme}-reduced${reduced}-${i}.png`)
   await exec('screencapture',['-x','-o','-l',windowId,file]);shots.push({file,time:performance.now()-start});await Bun.sleep(80)
  }
  // Verify changed pixels, not merely delivered callbacks or bounds.
  const box=await a.getByTestId('loops').bounds()
  for(let group=0;group<4;group++) {
   const states:string[]=shots.map(shot=>{
    const image=pixels(shot.file),scale=image.w/560,top=image.h-240*scale
    return Array.from({length:16},(_,dot)=>image.at((box.x+group*108+(dot%4)*10+2)*scale,top+(box.y+Math.floor(dot/4)*10+2)*scale).join(',')).join(';')
   })
   assert.equal(new Set(states).size>1,reduced==='0',`loader ${group} must ${reduced==='0'?'animate':'stay still'} in OS-captured pixels`)
  }
  // Let the last automation bounds query finish before measuring idle renders.
  await Bun.sleep(150)
  // Cadence sample has no screenshots or geometry polling in its interval.
  const before=f.counts(),mark=f.frameTimes().at(-1)??0
  await Bun.sleep(3000)
  const frames=f.frameTimes().filter(t=>t>mark)
  const intervals=frames.slice(1).map((t,i)=>t-frames[i]!).sort((a,b)=>a-b)
  const after=f.counts()
  assert.equal(after.renders-before.renders,0,'native loops must not render islands every frame')
  if(reduced==='0')assert.ok(intervals.length>30,'native animation did not present continuous frames')
  const summary={theme,reduced,frames:frames.length,p50:intervals[Math.floor(intervals.length*.5)]??null,p95:intervals[Math.floor(intervals.length*.95)]??null,islandRenders:after.renders-before.renders,shots}
  writeFileSync(path.join(out,`frames-${theme}-reduced${reduced}.json`),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary))
  await key('b');await Bun.sleep(250);await key('i');assert.match(await a.getByTestId('result').textContent(),/raw 1$/,'unacknowledged callbacks accumulated');await key('a');await Bun.sleep(150);await key('i');assert.match(await a.getByTestId('result').textContent(),/raw 2$/);await key('v')
  await key('s');await Bun.sleep(250);await key('u');await key('i');const stopped=await a.getByTestId('result').textContent();await Bun.sleep(250);await key('i');assert.equal(await a.getByTestId('result').textContent(),stopped,'unsubscribe still delivered callbacks')
  if(reduced==='0'){await key('m');await Bun.sleep(1500);const hidden=f.counts().frames;await Bun.sleep(500);assert.equal(f.counts().frames,hidden,'minimized loops kept presenting');await key('r');await Bun.sleep(300)}
  await key('h');await Bun.sleep(300);const idleFrames=f.counts().frames;await Bun.sleep(500);assert.equal(f.counts().frames,idleFrames,'unmounted loops kept presenting')
  console.log(`PASS ${theme} reduce=${reduced}: native scene loop, no island renders, callback unsubscribe, unmount idle`)
 }catch(e){console.error(f.diagnostics());throw e}finally{await f.close()}
}
