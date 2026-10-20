import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import path from 'node:path'
import {mkdirSync} from 'node:fs'
import {launchFixture} from '../scripts/idle-harness.ts'
const out=process.env.KYBERN_VERIFY_OUTPUT??path.join(import.meta.dir,'build','pointer-check');mkdirSync(out,{recursive:true})
for(const theme of ['dark','light']){
 const f=await launchFixture(path.join(import.meta.dir,'pointer-lab.tsx'),{GPUIX_BACKGROUND:'1',KYBERN_APPEARANCE:theme})
 const a=f.app
 const wait=async(label:string,fn:()=>Promise<boolean>)=>{const end=Date.now()+4000;while(!await fn()){assert.ok(Date.now()<end,label);await Bun.sleep(25)}}
 const content=async(id:string)=>(await a.getByTestId(id).textContent())??''
 const press=async(id:string)=>{const point=await a.getByTestId(id).center();await a.mouse.move(point);await Bun.sleep(150);await a.mouse.click(point)}
 try{
  await a.getByTestId('app-ready').waitFor({timeoutMs:30000})
  await a.mouse.move(await a.getByTestId('filled-child').center());await Bun.sleep(250)
  const hovered=await content('result');console.log(theme,hovered)
  assert.match(hovered,/hover true; enters 1/,'filled child must keep ancestor hovered without flapping')
  await press('filled-child');await wait('parent clicked',async()=>/Clicks 1; hover true; enters 1/.test(await content('result')))
  await a.getByTestId('park').hover();await wait('left parent',async()=>/hover false/.test(await content('result')))
  await press('sibling-cover');assert.match(await content('overlay-result'),/Behind 0; overlay 0/,'painted sibling must occlude underlying click')
  const behind=await a.getByTestId('behind').bounds();await a.mouse.move({x:behind.x+200,y:behind.y+40});await Bun.sleep(150);await a.mouse.click({x:behind.x+200,y:behind.y+40});await wait('uncovered click',async()=>/Behind 1/.test(await content('overlay-result')))
  await press('show-overlay');await a.getByTestId('overlay').waitFor();await press('overlay');await wait('overlay clicked',async()=>/Behind 1; overlay 1/.test(await content('overlay-result')))
  await a.screenshot({path:path.join(out,`pointer-${theme}.png`)})
  console.log(`PASS ${theme}: settled hover then click, cached descendant, sibling occlusion, deferred overlay`)
 }finally{await f.close()}
}
