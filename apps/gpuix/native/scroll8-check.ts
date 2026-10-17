import '../src/native/local-build.ts'
import {launchFixture} from '../src/requests/harness.ts'
import {pacingLock} from '../perf/scroll8-lock.ts'
import assert from 'node:assert/strict'
import {mkdirSync} from 'node:fs'
import path from 'node:path'
import {pixels} from './png.ts'
const out='/Users/mymac/projects/ade/previews/gpuix/round8/scroll/cache'
mkdirSync(out,{recursive:true})
const release=await pacingLock()
try{
 for(const theme of ['dark','light'])for(const reduced of ['0','1']){
  const snapshots:Record<string,string[]>={}
  for(const enabled of ['0','1']){
   const f=await launchFixture(path.join(import.meta.dir,'scroll8-lab.tsx'),{KYBERN_SCROLL_COALESCE:'0',KYBERN_SCROLL_ISLANDS:enabled,KYBERN_SCROLL_LAYOUT:enabled,KYBERN_APPEARANCE:theme,KYBERN_REDUCED_MOTION:reduced,GPUIX_BACKGROUND:'1',KYBERN_FULL_RATE:'1'})
   const a=f.app,files:string[]=[]
   const until=async(check:()=>Promise<boolean>,name:string)=>{const end=Date.now()+10000;while(Date.now()<end){try{if(await check())return}catch{}await Bun.sleep(10)}throw Error(`Timed out: ${name}`)}
   try{
    await a.getByTestId('ready').waitFor()
    const capture=async(name:string)=>{const file=`${out}/${theme}-${reduced}-${enabled}-${name}.png`;await a.screenshot({path:file});files.push(file)}
    for(const scene of ['summary','list','diff']){
     await a.getByTestId(scene).click()
     await until(async()=>{const b=await a.getByTestId(scene==='summary'?'prose':scene==='list'?'row-0':'diff-content').bounds();return b.width>0&&b.height>0},`painted ${scene}`)
     if(scene==='summary')await a.getByTestId('ready').press('s')
     for(const [step,delta]of [[0,-180],[1,-220],[2,120]]as const){await a.mouse.wheel({x:350,y:330},0,delta);await capture(`${scene}-${step}`)}
     if(scene==='summary'){
      await a.getByTestId('ready').press('g');assert.equal(await a.getByTestId('result').textContent(),'Veri','Selection survives cached scroll')
      await a.getByTestId('ready').press('h');const matches=JSON.parse(await a.getByTestId('result').textContent())
      const viewport=await a.getByTestId('viewport').bounds()
      const rect=matches.flatMap((m:any)=>m.rects).find((r:{x:number;y:number;width:number;height:number})=>r.y>=viewport.y&&r.y+r.height<=viewport.y+viewport.height&&r.width>2)
      assert.ok(rect,'Paragraph search geometry survives cached scroll')
      await a.call('clearSelection',{})
      const link={x:rect.x+rect.width/2,y:rect.y+rect.height/2}
      await a.mouse.down(link);await a.mouse.up(link)
      await a.getByText('https://example.com/scroll8').waitFor()
      await a.getByTestId('ready').press('w');await capture('summary-narrow')
      await a.getByTestId('ready').press('u');await capture('summary-changed')
      await a.getByTestId('ready').press('w');await a.getByTestId('ready').press('u')
      await a.getByTestId('ready').press('o')
      await until(async()=>await a.getByTestId('opacity-state').textContent()==='dim','ancestor opacity committed')
      await capture('ancestor-opacity');await a.getByTestId('ready').press('o')
      await until(async()=>await a.getByTestId('opacity-state').textContent()==='full','ancestor opacity restored')
      await capture('ancestor-opacity-restored')
     }
    }
    // Test native motion last, in a frozen clock, so restoring a live tween
    // cannot leak wall-clock timing into the following list/diff comparisons.
    await a.getByTestId('summary').click()
    await until(async()=>{const b=await a.getByTestId('prose').bounds();return b.width>0},'motion prose painted')
    const at=await a.clock.pause();await a.getByTestId('ready').press('m')
    await until(async()=>(await a.getByTestId('motion-state').textContent()).startsWith('dim '),'fade target committed')
    await a.clock.fastForward(0)
    for(const ms of [0,80,160,240]){await a.clock.set(at+ms);await capture(`ancestor-motion-${ms}`)}
    snapshots[enabled]=files
   }catch(error){console.error(f.diagnostics());throw error}finally{await f.close()}
  }
  assert.equal(snapshots['0']!.length,snapshots['1']!.length)
  for(let i=0;i<snapshots['0']!.length;i++){
   const a=pixels(snapshots['0']![i]!),b=pixels(snapshots['1']![i]!)
   assert.equal(a.w,b.w);assert.equal(a.h,b.h)
   let changed=0
   for(let y=4;y<a.h-4;y++)for(let x=4;x<a.w-4;x++){
    if(y>a.h-52&&(x<52||x>a.w-52))continue
    const p=a.at(x,y),q=b.at(x,y);if(p.some((v,j)=>v!==q[j]))changed++
   }
   assert.equal(changed,0,`Cached geometry must match full layout: ${snapshots['1']![i]}`)
  }
  console.log(`ok ${theme}/${reduced}: cached/full layout pixels across Summary/list/diff scroll, width and source changes`)
 }
}finally{release()}
