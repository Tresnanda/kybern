/** Exercise every existing resize handle with real pointer travel. Scratch only. */
import assert from 'node:assert/strict'
import { OUT,startScratch,waitUntil,exists } from './shell3-lib.ts'
import { writeFileSync } from 'node:fs'
const light=process.argv.includes('--light')
const app=await startScratch({light,thread:'Long review thread',env:{KYBERN_REDUCED_MOTION:'1'}})
const results:unknown[]=[]
const click=async(id:string)=>{await app.getByTestId(id).hover();await Bun.sleep(180);await app.getByTestId(id).click()}
const healthy=async()=>{const text=(await app.call('getPaintedText',{})).text.join('\n');assert(!/Something went wrong|Unable to display|Maximum update depth|Rendered more hooks|Rendered fewer hooks/.test(text),text)}
const drag=async(id:string,horizontal?:boolean)=>{
 horizontal ??= (await app.getByTestId(id).bounds()).width <= 16
 const positions:number[]=[]
 for(const steps of [2,24])for(const end of [horizontal?20:60,horizontal?1260:800,horizontal?320:410]){
  const from=await app.getByTestId(id).center();await app.mouse.move(from);await Bun.sleep(180);await app.mouse.down(from)
  for(let i=1;i<=steps;i++){await app.mouse.move(horizontal?{x:from.x+(end-from.x)*i/steps,y:from.y}:{x:from.x,y:from.y+(end-from.y)*i/steps},{pressedButton:0});if(steps>2)await Bun.sleep(12)}
  await app.mouse.up(horizontal?{x:end,y:from.y}:{x:from.x,y:end});await healthy()
  const bounds=await app.getByTestId(id).bounds();positions.push(horizontal?bounds.x:bounds.y)
  results.push({id,steps,end,bounds})
 }
 assert(Math.max(...positions)-Math.min(...positions)>20,`${id} did not visibly resize`)
 console.log('PASS resize',id)
}
try{
 await waitUntil(exists(app,'sidebar-resize'),12000,'thread sidebar')
 await drag('sidebar-resize')
 await click('dock-toggle');await waitUntil(exists(app,'dock-resize'),8000,'dock')
 await drag('dock-resize')
 // Dock Notes and Tasks use the same native dock seam.
 for(const tab of ['tasks','notes']){
  if(!await app.getByTestId(`dock-tab-${tab}`).count()){await click('dock-add');await waitUntil(exists(app,`dock-add-${tab}`),5000,'Add panel menu');await click(`dock-add-${tab}`)}
  else await click(`dock-tab-${tab}`)
  await waitUntil(exists(app,`dock-${tab}`),5000,`${tab} panel`);await drag('dock-resize')
 }
 await click('dock-toggle')
 await app.getByTestId('app-ready').press('cmd-\\')
 const ids=async()=>{const root=(await app.call('getTree',{})).tree;const out:string[]=[];const walk=(n:any)=>{if(n?.testId?.startsWith('split-resize-'))out.push(n.testId);n?.children?.forEach(walk)};walk(root);return out}
 await waitUntil(async()=>(await ids()).length>0,8000,'split divider')
 const horizontalIds=await ids()
 for(const id of horizontalIds)await drag(id)
 await app.getByTestId('app-ready').press('cmd-shift-\\')
 await waitUntil(async()=>(await ids()).some(id=>!horizontalIds.includes(id)),5000,'vertical split divider')
 for(const id of await ids())if(!horizontalIds.includes(id))await drag(id)
 await click('rail-tasks');await waitUntil(exists(app,'tasks-sidebar'),8000,'Tasks sidebar');await drag('sidebar-resize')
 await click('rail-notes');assert.equal(await app.getByTestId('sidebar-resize').count(),0,'Notes has no sidebar resize handle')
 await click('rail-pulls');assert.equal(await app.getByTestId('sidebar-resize').count(),0,'PR columns are fixed width; no handle')
 await healthy();await app.screenshot({path:`${OUT}/resize-${light?'light':'dark'}.png`})
 writeFileSync(`${OUT}/resize-${light?'light':'dark'}.json`,JSON.stringify(results,null,2))
 console.log('PASS all resize handles; Notes/PR have no independent resize seams')
}finally{await app.close()}
