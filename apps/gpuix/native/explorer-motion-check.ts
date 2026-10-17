import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import {mkdirSync,writeFileSync} from 'node:fs'
import path from 'node:path'
import {launchFixture} from '../src/requests/harness.ts'
import {acquirePreviewUiLock} from '../scripts/preview-ui-lock.ts'
import {pngPixels} from './clip-pixels.ts'
const output=process.env.KYBERN_VERIFY_OUTPUT??path.join(import.meta.dir,'build/explorer-motion');mkdirSync(output,{recursive:true})
const release=process.env.KYBERN_CLIP_LOCK_HELD?()=>{}:acquirePreviewUiLock()
try{
 for(const theme of ['dark','light']) for(const reduced of ['0','1']) {
  const f=await launchFixture(path.join(import.meta.dir,'explorer-motion-lab.tsx'),{GPUIX_BACKGROUND:'1',KYBERN_APPEARANCE:theme,KYBERN_REDUCED_MOTION:reduced,KYBERN_FRAME_TIMES:'1',KYBERN_FULL_RATE:'1'})
  try{
   const a=f.app;await a.getByTestId('ready').waitFor();assert.deepEqual(JSON.parse(await a.getByTestId('capabilities').textContent()),{rotate:true,physicalSprings:true})
   await a.clock.pause();const prefix=`${theme}-${reduced==='1'?'reduced':'normal'}`
   const start=path.join(output,`${prefix}-0.png`);await a.screenshot({path:start})
   await a.getByTestId('toggle').click();await a.getByTestId('physical').click()
   const sizes=[]
   for(const time of [60,120,240,600,1000]) {
    await a.clock.fastForward(time-(sizes.at(-1)?.time??0))
    const file=path.join(output,`${prefix}-${time}.png`);await a.screenshot({path:file})
    sizes.push({time,layout:await a.getByTestId('layout').bounds(),swap:await a.getByTestId('swap').bounds()})
   }
   assert.ok(Math.abs(sizes.at(-1)!.layout.width-420)<.1)
   assert.ok(Math.abs(sizes.at(-1)!.swap.x-sizes[0]!.swap.x)>0 || reduced==='1')
   const pixels0=pngPixels(start),pixels1=pngPixels(path.join(output,`${prefix}-1000.png`)),b=await a.getByTestId('arrow').bounds(),scale=pixels0.width/560
   let changed=0;for(let y=b.y;y<b.y+b.height;y++)for(let x=b.x;x<b.x+b.width;x++)if(String(pixels0.at(x*scale,y*scale))!==String(pixels1.at(x*scale,y*scale)))changed++
   assert.ok(changed>50,'SVG rotate must change real native pixels')
   if(reduced==='1')assert.ok(Math.abs(sizes[0]!.layout.width-420)<.1,'Reduced motion settles immediately')
   writeFileSync(path.join(output,`${prefix}-geometry.json`),JSON.stringify(sizes,null,2))
   console.log(`ok ${prefix}: animated SVG pixels, physical layout/translation, exact endpoints`)
  }catch(e){console.error(f.diagnostics());throw e}finally{await f.close()}
 }
}finally{release()}
