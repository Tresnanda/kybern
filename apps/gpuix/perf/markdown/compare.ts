import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { pixels } from '../../native/png.ts'
const out='/Users/mymac/projects/ade/previews/gpuix/perf/markdown'
const results=[]
for(const theme of ['dark','light'])for(const version of ['before','after']) {
 const {initial,offset}=JSON.parse(readFileSync(`${out}/pr-${version}-${theme}-offset.json`,'utf8'))
 assert.deepEqual(initial,[0,0]);assert.deepEqual(offset,[0,-650])
}
for(const theme of ['dark','light'])for(const suffix of ['','-scrolled'])for(const scene of ['explorer','pr']){
 const before=scene==='explorer'?`${out}/before-visual-resumed-${theme}-preview.md${suffix}.png`:`${out}/pr-before-${theme}${suffix}.png`
 const after=scene==='explorer'?`${out}/after-visual-resumed-${theme}-preview.md${suffix}.png`:`${out}/pr-after-${theme}${suffix}.png`
 const a=pixels(before),b=pixels(after)
 assert.equal(a.w,b.w);assert.equal(a.h,b.h)
 // Only the Markdown content: exclude animated check glyphs and shell chrome.
 const region=scene==='explorer'?[.61,.16,.99,.98]:[.30,.26,.75,.98]
 let changed=0,max=0
 for(let y=Math.floor(a.h*region[1]!);y<a.h*region[3]!;y++)for(let x=Math.floor(a.w*region[0]!);x<a.w*region[2]!;x++){
  const p=a.at(x,y),q=b.at(x,y)
  const diff=Math.max(...p.map((value,index)=>Math.abs(value-q[index]!)))
  if(diff)changed++;max=Math.max(max,diff)
 }
 results.push({scene,theme,suffix,width:a.w,height:a.h,region,changed,max})

}
writeFileSync(`${out}/app-pixel-comparison.json`,JSON.stringify(results,null,2))
for(const result of results)assert.equal(result.changed,0,`${result.scene}/${result.theme}/${result.suffix}: Markdown content drifted`)
console.log('ok Explorer and PR Summary: zero changed content pixels in both themes, top and scrolled')
