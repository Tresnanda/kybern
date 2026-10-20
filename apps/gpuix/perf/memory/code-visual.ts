/** Same-addon allocator controls; exact pixels and real native selection/scroll. */
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { launchFixture } from '../../src/requests/harness.ts'
import { metadata } from './metadata.ts'
import { lease } from './lease.ts'
import { assertTestDisplayWindow, capturePresentedPixels } from '../images/onscreen.ts'
import { pngPixels } from '../../native/clip-pixels.ts'
import { requireScreen } from '../bench/screen-state.ts'
const out = path.join(process.env.KYBERN_MEMORY_EVIDENCE!, 'visual'); mkdirSync(out,{recursive:true})
const data=process.env.KYBERN_DATA_DIR!;assert(data.includes('scratch'))
metadata(out,path.resolve('native/build/gpuix-native.darwin-arm64.node'),false)
writeFileSync(path.join(out,'controls.json'),JSON.stringify({control:{KYBERN_CODE_MEMORY:'0'},candidate:{KYBERN_CODE_MEMORY:'1'},brandFonts:true,appearance:['dark','light']},null,2))
const release=await lease(), comparisons:unknown[]=[], syntaxColours:unknown[]=[]
const until=async(test:()=>Promise<boolean>)=>{const end=Date.now()+20000;while(true){try{if(await test())return}catch{}assert(Date.now()<end,'Code must paint');await Bun.sleep(25)}}
try {
for(const theme of ['dark','light'])for(const mode of ['control','candidate']) {
 const client=path.join(data,`visual-${theme}-${mode}`);mkdirSync(client,{recursive:true})
 const f=await launchFixture(path.join(import.meta.dir,'lab.tsx'),{KYBERN_DATA_DIR:data,KYBERN_CLIENT_CONFIG_DIR:client,KYBERN_URL:'',KYBERN_TOKEN:'',GPUIX_BACKGROUND:'1',KYBERN_MEMORY_CODE_VISUAL:'1',KYBERN_APPEARANCE:theme,KYBERN_CODE_MEMORY:mode==='control'?'0':'1'})
 try {
  await f.app.getByTestId('app-ready').waitFor();await assertTestDisplayWindow(f.pid)
  const port=JSON.parse(readFileSync(path.join(client,'memory-control.json'),'utf8')).port
  const control=async(action:string,args:object={})=>(await fetch(`http://127.0.0.1:${port}`,{method:'POST',body:JSON.stringify({action,...args})})).json()
  const scene=async(kind:string,id?:string)=>{await control('scene',{kind,index:0});if(id)await until(async()=>{const b=await f.app.getByTestId(id).bounds();return b.width>0&&b.height>0});await Bun.sleep(150)}
  const capture=async(name:string)=>{
   requireScreen();await assertTestDisplayWindow(f.pid)
   const file=path.join(out,`${theme}-${mode}-${name}.png`)
   await capturePresentedPixels(file,1100,760,()=>f.app.screenshot({path:file}))
   if (['highlighted','scrolled','reopened'].includes(name)) {
    const pixels=pngPixels(file);let red=0,blue=0
    for(let y=24;y<pixels.height-24;y+=2)for(let x=24;x<pixels.width-24;x+=2){
     const [r,g,b]=pixels.at(x,y)
     if(r-b>40&&r-g>20)red++
     if(b-r>40&&b-g>10)blue++
    }
    assert(red>100&&blue>100,`${theme} ${name}: visible red/blue syntax ink, not a plain-text fallback`)
    syntaxColours.push({theme,mode,name,red,blue,pixelStride:2})
    writeFileSync(path.join(out,'syntax-colours.json'),JSON.stringify(syntaxColours,null,2))
   }
   if(mode==='candidate'){
    const base=pngPixels(path.join(out,`${theme}-control-${name}.png`)),next=pngPixels(file)
    assert.equal(next.width,base.width);assert.equal(next.height,base.height)
    // Exclude AppKit title and the window's rounded outer edge only.
    const scale=next.width/1100,top=next.height-760*scale;let differingPixels=0
    for(let y=Math.ceil(top+12*scale);y<next.height-12*scale;y++)for(let x=12*scale;x<next.width-12*scale;x++)if(base.at(x,y).some((v,i)=>v!==next.at(x,y)[i]))differingPixels++
    comparisons.push({theme,name,differingPixels});writeFileSync(path.join(out,'diff.json'),JSON.stringify(comparisons,null,2));assert.equal(differingPixels,0,`${theme} ${name}: exact code canvas`)
   }
  }
  await capture('home')
  await scene('code','memory-code');await capture('large-code')
  await scene('home');await scene('code-virtual','dock-code-chunk-0');await capture('highlighted')
  const b=await f.app.getByTestId('dock-file-content').bounds()
  const from={x:b.x+56,y:b.y+10},to={x:b.x+400,y:b.y+50}
  await f.app.mouse.down(from);await f.app.mouse.move(to,{pressedButton:0});await f.app.mouse.up(to);await Bun.sleep(100)
  const selection=await f.app.call('getSelectedText',{});assert(selection.text?.includes('export'),'Real pointer selection includes source')
  writeFileSync(path.join(out,`${theme}-${mode}-selection.json`),JSON.stringify(selection,null,2))
  if(mode==='candidate')assert.deepEqual(selection,JSON.parse(readFileSync(path.join(out,`${theme}-control-selection.json`),'utf8')))
  await capture('selection')
  await f.app.call('clearSelection',{})
  const listId=(await f.app.getByTestId('dock-file-content').element()).id
  await f.app.mouse.wheel({x:b.x+b.width/2,y:b.y+b.height/2},0,-540);await Bun.sleep(250)
  const scroll=await f.app.call('getScrollOffset',{elementId:listId})
  assert(Math.abs(scroll.offset?.[1] ?? 0)>=500,'Real wheel moves the native code viewport')
  writeFileSync(path.join(out,`${theme}-${mode}-scroll.json`),JSON.stringify(scroll,null,2))
  const painted=(await f.app.call('getPaintedText',{})).text.join('\n');assert(painted.includes('entry40'),'Real native scrolling reveals later source')
  await capture('scrolled')
  await scene('home');await Bun.sleep(100)
  const closed=await control('stats') as {syntax:{documents:number;sourceBytes:number}}
  assert.equal(closed.syntax.documents,0);assert.equal(closed.syntax.sourceBytes,0)
  await scene('code-virtual','dock-code-chunk-0');await capture('reopened')
 } finally {writeFileSync(path.join(out,`${theme}-${mode}-native.log`),f.diagnostics());await f.close()}
}
} finally {release()}
console.log(`PASS ${comparisons.length} exact both-theme code canvases, native pointer selection, scroll and syntax close/reopen`)
