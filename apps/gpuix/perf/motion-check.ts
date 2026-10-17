import assert from 'node:assert/strict'
import {mkdirSync,writeFileSync} from 'node:fs'
import path from 'node:path'
import {launchFixture} from '../src/requests/harness.ts'
const out='/Users/mymac/projects/ade/previews/gpuix/round5/motion'
mkdirSync(out,{recursive:true})
if(!process.env.KYBERN_DATA_DIR?.includes('gpuix-scratch/round5/motion/')) throw Error('Own motion scratch daemon required')
const mode=process.env.KYBERN_APPEARANCE??'dark', reduced=process.env.KYBERN_REDUCED_MOTION??'0', label=process.env.MOTION_LABEL??'before'
const f=await launchFixture(path.resolve('perf/motion-app.ts'),{GPUIX_BACKGROUND:'1',KYBERN_APPEARANCE:mode,KYBERN_REDUCED_MOTION:reduced})
const a=f.app,records:any[]=[]
const save=()=>writeFileSync(`${out}/${label}-${mode}-${reduced}.json`,JSON.stringify(records,null,2))
try{
 await a.getByTestId('environment-toggle').waitFor({timeoutMs:60000});await Bun.sleep(1500)
 await a.clock.pause()
 for(const direction of ['open','close']){
  await a.getByTestId('environment-toggle').click()
  const tree=await a.call('getTree',{});const all=JSON.stringify(tree);writeFileSync(`${out}/${label}-${direction}-tree.json`,all)
  const inset=(await a.getByTestId(all.match(/environment-inset-[^" ]+/)![0]).bounds())
  const start=await a.clock.pause()
  const frames=[]
  for(const ms of [0,40,80,140,220,300,350]){
   await a.clock.set(start+ms)
   frames.push({ms,inset:await a.getByTestId(all.match(/environment-inset-[^" ]+/)![0]).bounds(),panel:await a.getByTestId('environment-panel').count()?await a.getByTestId('environment-panel').bounds():null,content:await a.getByTestId('composer').bounds()})
   if(process.env.MOTION_SHOTS==='1' && direction==='open' && (ms===0||ms===140||ms===350)) await a.screenshot({path:`${out}/${label}-${mode}-${reduced}-${direction}-${ms}.png`})
  }
  const bez=(x:number)=>{let lo=0,hi=1;const b=(t:number,a:number,c:number)=>3*a*t*(1-t)**2+3*c*t*t*(1-t)+t*t*t;for(let i=0;i<30;i++){const m=(lo+hi)/2;if(b(m,.32,0)<x)lo=m;else hi=m}return b((lo+hi)/2,.72,1)}
  for(const frame of frames){const progress=reduced==='1'?1:frame.ms>=300?1:frame.ms===0?0:bez(frame.ms/300);const expected=direction==='open'?312*progress:312*(1-progress);assert(Math.abs(frame.inset.width-expected)<1.1,`${direction} ${frame.ms}ms: ${frame.inset.width} != ${expected}`)}
  records.push({direction,inset,frames});save()
 }
 // Closing completion cannot remove a newly reopened panel.
 await a.getByTestId('environment-toggle').click();await a.clock.fastForward(40)
 await a.getByTestId('environment-toggle').click();await a.clock.fastForward(40)
 await a.getByTestId('environment-toggle').click();await a.clock.fastForward(350)
 assert.equal(await a.getByTestId('environment-panel').count(),1,'stale exit must not remove reopened panel')
 assert.equal((await a.getByTestId('environment-inset-main').bounds()).width,312)
 await a.getByTestId('environment-toggle').click();await a.clock.fastForward(350)
 await a.getByTestId('environment-toggle').press('enter')
 assert.equal((await a.getByTestId('environment-inset-main').bounds()).width,312,'keyboard open must be immediate')
 await a.getByTestId('environment-toggle').press('enter')
 assert.equal((await a.getByTestId('environment-inset-main').bounds()).width,0,'keyboard close must retain immediate policy after panel unmount')
 records.push({interruption:'pass',keyboard:'pass'});save()
 await a.clock.resume()
 console.log(JSON.stringify(records,null,2))
}catch(e){console.error(f.diagnostics());throw e}finally{await f.close()}
