import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../src/requests/harness.ts'
import { acquirePreviewUiLock } from '../scripts/preview-ui-lock.ts'
import {pngPixels} from './clip-pixels.ts'
const output=process.env.KYBERN_VERIFY_OUTPUT??path.join(import.meta.dir,'build/clip')
mkdirSync(output,{recursive:true})
const release=process.env.KYBERN_CLIP_LOCK_HELD?()=>{}:acquirePreviewUiLock()
try {
 for(const theme of ['dark','light']) for(const reduced of ['0','1']) {
  console.log(`launch ${theme}/${reduced}`)
  const f=await launchFixture(path.join(import.meta.dir,'clip-lab.tsx'),{GPUIX_BACKGROUND:'1',KYBERN_APPEARANCE:theme,KYBERN_REDUCED_MOTION:reduced})
  try {
   const a=f.app; await a.getByTestId('ready').waitFor();console.log('fixture ready')
   const boxes:Record<string,unknown>={}
   for(const id of ['quad','svg','image','text','backdrop','cached','virtual','nested','code-body','native-md']) boxes[id]=await a.getByTestId(id).bounds()
   for(const kind of ['quad','svg','image','backdrop','cached','virtual','nested']) {
    console.log(`hit ${kind}`)
    const b=await a.getByTestId(kind).bounds()
    await a.mouse.click({x:b.x+1,y:b.y+1})
    if(!process.env.KYBERN_CLIP_BASELINE) assert.equal(await a.getByTestId('hit').textContent(),'behind',`${kind}: clipped corner must not intercept input`)
    await a.mouse.click({x:b.x+b.width/2,y:b.y+b.height/2})
    if(!process.env.KYBERN_CLIP_BASELINE) assert.equal(await a.getByTestId('hit').textContent(),kind,`${kind}: visible interior must stay interactive`)
   }
   await a.getByTestId('replay').click();await a.getByTestId('replay').click()
   await a.getByTestId('paint').click()
   const paintedQuad=await a.getByTestId('quad').bounds();await a.mouse.click({x:paintedQuad.x+1,y:paintedQuad.y+1})
   if(!process.env.KYBERN_CLIP_BASELINE)assert.equal(await a.getByTestId('hit').textContent(),'behind','Scoped paint must preserve rounded hit masks')
   const prefix=`${theme}-${reduced==='1'?'reduced':'normal'}`
   const shot=path.join(output,`${prefix}.png`)
   await a.screenshot({path:shot})
   if(!process.env.KYBERN_CLIP_BASELINE) {
    const pixels=pngPixels(shot),scale=pixels.width/760,background=pixels.at(2*scale,2*scale),reference=await a.getByTestId('frame-reference').bounds()
    const maskBackground=pixels.at((reference.x+5)*scale,(reference.y+5)*scale)
    const clear=(x:number,y:number,label:string,color=maskBackground)=>assert.ok(pixels.at(x*scale,y*scale).every((v,i)=>Math.abs(v-color[i]!)<=3),`${label}: descendant paint escaped the curve`)
    for(const id of ['quad','svg','image','text','backdrop','cached','virtual','nested']) {
     const b=await a.getByTestId(id).bounds()
     for(const x of [b.x+1,b.x+b.width-1]) for(const y of [b.y+1,b.y+b.height-1]) clear(x,y,id)
    }
    const b=await a.getByTestId('code-body').bounds()
    clear(b.x+1,b.y+b.height-1,'code bottom left',background);clear(b.x+b.width-1,b.y+b.height-1,'code bottom right',background)
   }
   writeFileSync(path.join(output,`${prefix}-bounds.json`),JSON.stringify(boxes,null,2))
   await a.getByTestId('code-body').wheel(-180,0)
   const horizontal=path.join(output,`${prefix}-horizontal.png`)
   await a.screenshot({path:horizontal})
   if(!process.env.KYBERN_CLIP_BASELINE){
    const original=pngPixels(shot),scrolled=pngPixels(horizontal),s=original.width/760,b=await a.getByTestId('code-body').bounds()
    let changed=0
    for(let y=b.y+6;y<b.y+22;y++)for(let x=b.x+16;x<b.x+b.width-16;x++)if(String(original.at(x*s,y*s))!==String(scrolled.at(x*s,y*s)))changed++
    assert.ok(changed>20,'Horizontal wheel must actually move the code glyphs')
   }
   const beforeWrap=await a.getByTestId('code-body').bounds()
   await a.getByTestId('code-wrap').click()
   await a.screenshot({path:path.join(output,`${prefix}-wrapped.png`)})
   assert.ok((await a.getByTestId('code-body').bounds()).height>beforeWrap.height,'Wrapping must reflow the code body')
   await a.getByTestId('virtual').wheel(0,-120)
   await a.getByTestId('replay').click()
   await a.screenshot({path:path.join(output,`${prefix}-replay-scroll.png`)})
   assert.ok((await a.call('getPaintedText',{})).text.includes('row 5'),'Virtual wheel must reach later rows')
   console.log(`ok ${prefix}: clip hit tests, cached replay, virtual scroll, code horizontal scroll/wrap`)
  } catch(e) { console.error(f.diagnostics()); throw e } finally { await f.close() }
 }
} finally {release()}
