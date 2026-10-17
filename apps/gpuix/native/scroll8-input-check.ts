import {launchFixture} from '../src/requests/harness.ts'
import {pacingLock} from '../perf/scroll8-lock.ts'
import assert from 'node:assert/strict'
import path from 'node:path'
const release=await pacingLock()
try{
 for(const mode of ['pr','all']){
  const f=await launchFixture(path.join(import.meta.dir,'scroll8-lab.tsx'),{KYBERN_SCROLL_COALESCE:mode,KYBERN_SCROLL_ISLANDS:'1',KYBERN_FRAME_COSTS:'1',GPUIX_BACKGROUND:'1',KYBERN_FULL_RATE:'1'})
  try{
   const a=f.app;await a.getByTestId('ready').waitFor()
   const initial=(await a.getByTestId('prose').bounds()).y
   const waitY=async(expected:number)=>{
    const deadline=Date.now()+5000
    while(Date.now()<deadline){const y=(await a.getByTestId('prose').bounds()).y;if(Math.abs(y-expected)<1)return;await Bun.sleep(5)}
    assert.fail(`Scroll did not reach ${expected}; ${f.diagnostics()}`)
   }
   // Burst faster than the display: preserve total distance without 120 draws.
   await Promise.all(Array.from({length:120},()=>a.mouse.wheel({x:350,y:330},0,-2)))
   await waitY(initial-240)
   await a.getByTestId('ready').press('e');await waitY(initial-360)
   await a.getByTestId('ready').press('c');await waitY(initial-440)
   await a.getByTestId('ready').press('s');await a.getByTestId('ready').press('g')
   assert.equal(await a.getByTestId('result').textContent(),'Veri')
   // Leave no pending wheel to leak through a navigation click into a new list.
   const wheel=a.mouse.wheel({x:350,y:330},0,-80)
   await a.getByTestId('list').click();await wheel
   await a.getByTestId('row-0').waitFor()
   const first=await a.getByTestId('row-0').bounds(),viewport=await a.getByTestId('viewport').bounds()
   assert(first.y>=viewport.y&&first.y<viewport.y+40,'Navigation must not scroll the newly mounted list')
   console.log(`ok ${mode}: 120-packet native burst preserves 240px distance, native Started/Moved/Ended + Cancelled phases, selection and navigation ordering`)
  }catch(error){console.error(f.diagnostics());throw error}finally{await f.close()}
 }
}finally{release()}
