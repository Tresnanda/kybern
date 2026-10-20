// Hovering any word of a multi-word link underlines the whole link, on every
// line it wraps onto, in mixed inline flow (a paragraph with inline code) as in
// a single text run; clicking any word opens it.
//   GPUIX_BACKGROUND=1 bun native/link-hover-check.ts [--baseline]
import '../src/native/local-build.ts'
import {launchFixture} from '../src/requests/harness.ts'
import {requireScreen} from '../perf/bench/screen-state.ts'
import {waitForWindowOnscreen,requireWindowOnscreen} from '../perf/bench/window-onscreen.ts'
import {pixels} from './png.ts'
import {mkdirSync} from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
const out=process.env.KYBERN_VERIFY_OUTPUT??'/Users/mymac/projects/ade/previews/chatfix/link-hover'
const baseline=process.argv.includes('--baseline'),tag=baseline?'before':'after'
mkdirSync(out,{recursive:true})
const results:Record<string,unknown>[]=[]
type Box={x:number;y:number;width:number;height:number}
// Changed pixels (2x capture) inside a box, against the unhovered capture.
const changed=(a:ReturnType<typeof pixels>,b:ReturnType<typeof pixels>,box:Box)=>{let n=0;for(let y=Math.floor(box.y*2);y<(box.y+box.height)*2;y++)for(let x=Math.floor(box.x*2);x<(box.x+box.width)*2;x++){const c=a.at(x,y),d=b.at(x,y);if(c.some((v,i)=>Math.abs(v-d[i]!)>24))n++}return n}
for(const mode of ['dark','light']){
 requireScreen()
 const f=await launchFixture(path.join(import.meta.dir,'link-hover-lab.tsx'),{KYBERN_APPEARANCE:mode,GPUIX_BACKGROUND:'1',KYBERN_DATA_DIR:'/Users/mymac/projects/ade-gpuix-scratch/chatfix/lab-data',KYBERN_CLIENT_CONFIG_DIR:'/Users/mymac/projects/ade-gpuix-scratch/chatfix/lab-client'}),a=f.app
 const checks:Record<string,boolean|number>={}
 try{
  await a.getByTestId('ready').waitFor();await waitForWindowOnscreen(f.pid);await Bun.sleep(400)
  const shot=async(label:string)=>{requireScreen();requireWindowOnscreen(f.pid);const file=path.join(out,`${tag}-${mode}-${label}.png`);await a.screenshot({path:file});return pixels(file)}
  await a.mouse.move({x:620,y:620});await Bun.sleep(120)
  const rest=await shot('rest')
  for(const id of ['flow','plain']){
   const b=await a.getByTestId(id).bounds(),line=b.height/2
   assert.ok(b.height>30,`${id} wraps onto two lines (${b.height}px)`)
   const first={x:b.x,y:b.y,width:b.width,height:line},second={x:b.x,y:b.y+line,width:b.width*0.55,height:line}
   // First word, a word at the end of line one, the first word of line two.
   for(const [label,point] of [['first',{x:b.x+12,y:b.y+line/2}],['middle',{x:b.x+b.width*0.6,y:b.y+line/2}],['last',{x:b.x+24,y:b.y+line*1.5}]] as const){
    await a.mouse.move(point);await Bun.sleep(160)
    const now=await shot(`${id}-${label}`)
    checks[`${id}.${label}.line1`]=changed(rest,now,{...first,x:first.x+(label==='first'?60:0),width:label==='middle'?b.width*0.45:first.width-60})
    checks[`${id}.${label}.line2`]=changed(rest,now,second)
   }
   await a.mouse.move({x:620,y:620});await Bun.sleep(120)
   await a.mouse.click({x:b.x+24,y:b.y+line*1.5});await Bun.sleep(120)
   checks[`${id}.click`]=(await a.getByTestId('clicked').textContent())==='https://github.com/example/everlace/issues/53'
  }
  const c=await a.getByTestId('code').bounds()
  await a.mouse.move({x:c.x+90,y:c.y+c.height/2});await Bun.sleep(160)
  const code=await shot('code-link')
  checks['code.whole']=changed(rest,code,{x:c.x+50,y:c.y,width:230,height:c.height})
  await a.mouse.click({x:c.x+200,y:c.y+c.height/2});await Bun.sleep(120)
  checks['code.click']=(await a.getByTestId('clicked').textContent())==='src/dashboard/UnlockPremium.tsx'
  results.push({mode,checks})
  if(!baseline){
   for(const id of ['flow','plain'])for(const label of ['first','middle','last'])for(const line of ['line1','line2'])assert.ok((checks[`${id}.${label}.${line}`] as number)>40,`${mode} ${id}: hovering the ${label} word underlines ${line} (${checks[`${id}.${label}.${line}`]} px)`)
   assert.ok((checks['code.whole'] as number)>40,`${mode}: code link underlines`)
   for(const id of ['flow','plain','code'])assert.ok(checks[`${id}.click`],`${mode} ${id}: a word click opens the link`)
  }
 }catch(e){console.error(f.diagnostics());throw e}finally{await f.close()}
}
console.log(JSON.stringify(results,null,1))
