import assert from 'node:assert/strict'
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import path from 'node:path'
import {launchFixture} from '../src/requests/harness.ts'
import {KybernClient} from '../../../packages/kybern-client/src/client.ts'
const out='/Users/mymac/projects/ade/previews/gpuix/round5/motion';mkdirSync(out,{recursive:true})
const data=process.env.KYBERN_DATA_DIR??'';if(!data.includes('gpuix-scratch/round5/motion/'))throw Error('Own scratch fixture required')
const client=new KybernClient({url:`ws://127.0.0.1:${readFileSync(path.join(data,'daemon.port'),'utf8').trim()}/ws`,token:readFileSync(path.join(data,'daemon.token'),'utf8').trim()});client.connect();while(client.status!=='open')await Bun.sleep(20)
const task=(await client.call('tasks.items.list',{})).tasks.find(t=>t.title==='Idle task 0')!
const f=await launchFixture(path.resolve('perf/motion-app.ts'),{GPUIX_BACKGROUND:'1',KYBERN_APPEARANCE:process.env.KYBERN_APPEARANCE??'dark',KYBERN_REDUCED_MOTION:process.env.KYBERN_REDUCED_MOTION??'0'})
const a=f.app,records:any[]=[]
try{
 await a.getByTestId('rail-tasks').waitFor({timeoutMs:60000});await a.getByTestId('rail-tasks').click();await a.getByTestId('task-filter-all').click()
 for(const view of ['board','list']){
  await a.getByTestId(`task-view-${view}`).click();await a.getByTestId(`task-drag-${task.id}`).waitFor();await Bun.sleep(500)
  // Native bounds are content boxes: board ghost has an unpadded outer host;
  // the list ghost shares the source row's padded content box.
  const source=await a.getByTestId(`${view==='board'?'task-slot':'task-row'}-${task.id}`).bounds()
  const start=await a.getByTestId(`task-drag-${task.id}`).center(),end={x:start.x+70,y:start.y+10}
  console.log(JSON.stringify({view,source,start,end}));await a.mouse.move(start);await a.mouse.down(start);await a.mouse.move(end,{pressedButton:0});await a.getByTestId('task-ghost').waitFor()
  const carried=await a.getByTestId('task-ghost').bounds();const at=await a.clock.pause()
  if(process.env.MOTION_SHOTS==='1')await a.screenshot({path:`${out}/lift-${view}-${process.env.KYBERN_APPEARANCE??'dark'}-${process.env.KYBERN_REDUCED_MOTION??'0'}.png`})
  await a.mouse.up(end)
  const frames=[]
  for(const ms of [0,40,80,140,220,250,320]){
   await a.clock.set(at+ms)
   frames.push({ms,ghost:await a.getByTestId('task-ghost').count()?await a.getByTestId('task-ghost').bounds():null,held:await a.getByTestId('task-drag-layer').count(),opened:await a.getByTestId('task-back').count()})
  }
  writeFileSync(`${out}/drag-current-debug.json`,JSON.stringify({view,source,carried,frames},null,2))
  const bez=(x:number)=>{let lo=0,hi=1;const b=(t:number,a:number,c:number)=>3*a*t*(1-t)**2+3*c*t*t*(1-t)+t*t*t;for(let i=0;i<30;i++){const m=(lo+hi)/2;if(b(m,.25,.25)<x)lo=m;else hi=m}return b((lo+hi)/2,.1,1)}
  if(process.env.KYBERN_REDUCED_MOTION!=='1')for(const frame of frames.filter(f=>f.ms<250)){
   assert(frame.ghost,`${view} must remain painted before 250ms (${frame.ms})`)
   const p=frame.ms===0?0:bez(frame.ms/250)
   assert(Math.abs(frame.ghost.x-(carried.x+(source.x-carried.x)*p))<1.1,`${view} ${frame.ms}ms settle must follow dnd-kit ease`)
   assert(Math.abs(frame.ghost.y-(carried.y+(source.y-carried.y)*p))<1.1,`${view} ${frame.ms}ms vertical settle must follow dnd-kit ease`)
  }
  assert.equal(frames.at(-1)!.held,0,`${view} settle must complete on native time`)
  await a.clock.resume();await Bun.sleep(1000)
  records.push({view,source,carried,frames,remaining:await a.getByTestId('task-drag-layer').count()})
  assert.equal(await a.getByTestId('task-back').count(),0,'drop must suppress source click')
  assert.equal(await a.getByTestId('task-drag-layer').count(),0,'ghost must be removed')
 }
 console.log(JSON.stringify(records,null,2));writeFileSync(`${out}/drag-${process.env.MOTION_LABEL??'before'}-${process.env.KYBERN_APPEARANCE??'dark'}-${process.env.KYBERN_REDUCED_MOTION??'0'}.json`,JSON.stringify(records,null,2))
}catch(e){await a.screenshot({path:`${out}/drag-failure.png`}).catch(()=>{});console.error(f.diagnostics());throw e}finally{await f.close();client.close()}
