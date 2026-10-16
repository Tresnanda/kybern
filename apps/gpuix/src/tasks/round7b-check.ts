import {mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {connect} from '../../visual/fixture.ts'
import {launchFixture} from './round7b-harness.ts'
import {acquirePreviewUiLock} from '../../scripts/preview-ui-lock.ts'
const data='/Users/mymac/projects/ade-gpuix-scratch/round7-tasks7b'
const out='/Users/mymac/projects/ade/previews/gpuix/round7/tasks7b'
const client=await connect({daemonPid:0,port:4276,token:readFileSync(`${data}/daemon.token`,'utf8').trim(),seeded:true})
const titles=['Mobile parity for Orchestrator V2 Lineage and thread messaging','WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW','Review and verify all mobile task rendering, workspace events, keyboard controls, animation transitions and native accessibility behavior across devices','測試很長的任務標題與沒有空格的原生換行行為', 'Quick add preserves the fifth existing task', 'Drag task 06', 'Drag task 07', 'Drag task 08', 'Drag task 09', 'Drag task 10', 'Drag task 11', 'Drag task 12']
let tasks=(await client.call('tasks.items.list',{})).tasks
for(const task of tasks.filter(t=>t.title==='Round7 saved task'))await client.call('tasks.items.delete',{id:task.id})
tasks=(await client.call('tasks.items.list',{})).tasks
if(!tasks.length){
 for(const [i,title] of titles.entries())await client.call('tasks.items.create',{scope:'global',title,status:'todo',priority:((i%4)+1) as 1})
 for(let i=1;i<=5;i++)await client.call('tasks.items.create',{scope:'global',title:`Inbox drag task ${i}`,status:'inbox',priority:0})
 for(const name of ['alpha-app','beta-docs','gamma-cli']){const dir=`${data}/projects/${name}`;mkdirSync(dir,{recursive:true});Bun.spawnSync(['git','init','-q','-b','main'],{cwd:dir});await client.call('projects.add',{path:dir,name})}
 tasks=(await client.call('tasks.items.list',{})).tasks
}
writeFileSync(`${out}/fixture.json`,JSON.stringify(tasks.map(t=>({id:t.id,title:t.title,status:t.status})),null,2))
for (const title of [...titles].reverse()) {
 const task = tasks.find(t => t.title === title)!
 const first = (await client.call('tasks.items.list', {})).tasks.filter(t => t.status === 'todo' && t.id !== task.id).sort((a,b)=>a.rank-b.rank)[0]
 await client.call('tasks.items.update', {id:task.id,status:'todo',before_id:first?.id ?? null})
}
if(process.argv.includes('--seed')){client.close?.();process.exit()}
if(process.env.R7_LOCK_HELD!=='1'&&readFileSync('/tmp/kybern-gpuix-ui-queue','utf8').trim().split('\n')[0]!=='tasks7b')throw Error('Queue tasks7b before acquiring the UI lock')
const unlock=process.env.R7_LOCK_HELD==='1'?()=>{}:acquirePreviewUiLock()
const label=process.env.R7_LABEL??'before'
writeFileSync(`${data}/gpuix-ui.json`,'{}')
const fixture=await launchFixture(path.resolve('src/tasks/round7b-app.ts'),{GPUIX_BACKGROUND:'1',KYBERN_DATA_DIR:data,KYBERN_APPEARANCE:process.env.KYBERN_APPEARANCE??'dark',KYBERN_OPAQUE:'1',KYBERN_CLIENT_CONFIG_DIR:`${data}/client`,KYBERN_GPUIX_CREDENTIALS_DIR:`${data}/creds`,KYBERN_DEBUG_DRAG:process.env.R7_DEBUG??'0',KYBERN_DRAG_PACING:`${out}/${label}-pacing`,NAPI_RS_NATIVE_LIBRARY_PATH:path.resolve('native/build/gpuix-native.darwin-arm64.node')})
let windowId=''
const shot=(file:string)=>{execFileSync('screencapture',['-x','-o','-l',windowId,file])}
const app=fixture.app;const click=async(id:string)=>{console.log('click',id);await app.getByTestId(id).waitFor({timeoutMs:10000});await app.getByTestId(id).click()};console.log('running',label,fixture.pid)
async function sample(name:string) {
 const child=Bun.spawn(['bun','perf/sample.ts','15',`GPUIX=${fixture.pid}`],{stdout:'pipe',stderr:'pipe'})
 return {done:async()=>{const text=await new Response(child.stdout).text();await child.exited;writeFileSync(`${out}/${label}-${name}-resources.txt`,text);console.log(name,text)}}
}
const wait=async(f:()=>Promise<boolean>,name:string)=>{const end=Date.now()+6000;while(!await f()){if(Date.now()>end)throw Error(`timeout ${name}`);await Bun.sleep(16)}}
try{
 await app.getByTestId('app-ready').waitFor({timeoutMs:60000})
 const windowDeadline=Date.now()+10000
 while(!windowId){try{windowId=execFileSync('swift',[path.resolve('src/tasks/round7-window-id.swift'),String(fixture.pid)],{encoding:'utf8'}).trim()}catch{}if(!windowId){if(Date.now()>windowDeadline)throw Error('No native window ID');await Bun.sleep(32)}}
 await click('rail-tasks');await click('task-view-board')
 const first=tasks.find(t=>t.title===titles[0])!; console.log('fixture pid',fixture.pid)
 await app.getByTestId(`task-row-${first.id}`).waitFor()
 if(process.env.KYBERN_WINDOW_SIZE?.startsWith('1920x'))await wait(async()=>(await app.getByTestId('task-column-todo').bounds()).width>300,'actual wide column')
 shot(`${out}/${label}-board.png`)
 const row=await app.getByTestId(`task-row-${first.id}`).bounds(); const title=await app.getByTestId(`task-drag-${first.id}`).bounds()
 if(process.env.R7_SAMPLE==='1')await (await sample('idle')).done();console.log('geometry',{row,title}); writeFileSync(`${out}/${label}-geometry.json`,JSON.stringify({row,title,window:await app.getByTestId('app-ready').bounds(),column:await app.getByTestId('task-column-todo').bounds()}))
 await click('task-board-add-todo');await app.getByTestId('task-quick-title').waitFor()
 shot(`${out}/${label}-quick.png`)
 console.log('quick-painted',(await app.call('getPaintedText',{})).text)
 await app.mouse.wheel({x:row.x+row.width/2,y:600},0,-1800)
 await wait(async()=> (await app.call('getPaintedText',{})).text.join('\n').includes('Drag task 12'),'quick scroll last card')
 shot(`${out}/${label}-quick-scroll.png`)
 await app.mouse.wheel({x:row.x+row.width/2,y:600},0,5000)
 await app.getByTestId('task-quick-title').press('escape');console.log('quick cancelled')
 await app.mouse.wheel({x:row.x+row.width/2,y:600},0,5000)
 await wait(async()=>!!await app.getByTestId(`task-drag-${first.id}`).count(),'return first card')
 if(process.argv.includes('--visual')) { shot(`${out}/${label}-cancel.png`); process.exitCode=0 }

 for (const view of ['board','list']) {
 await click(`task-view-${view}`)
 await click(view==='board'?'task-board-add-todo':'task-add-status:todo')
 await app.getByTestId('task-quick-title').waitFor()
 shot(`${out}/${label}-${view}-quick.png`)
 await app.getByTestId('task-quick-title').fill('Round7 saved task')
 await app.getByTestId('task-quick-title').press('enter')
 let saved: typeof tasks[number] | undefined
 await wait(async()=>{saved=(await client.call('tasks.items.list',{})).tasks.find(t=>t.title==='Round7 saved task');return !!saved},'quick save')
 await app.getByTestId('task-quick-title').press('escape')
 const area=await app.getByTestId(view==='board'?'task-column-todo':'task-list-viewport').bounds()
 await app.mouse.wheel({x:area.x+area.width/2,y:600},0,-5000)
 await wait(async()=>(await app.call('getPaintedText',{})).text.join('\n').includes('Round7 saved task'),'saved card reachable')
 shot(`${out}/${label}-${view}-save.png`)
 if(saved) await client.call('tasks.items.delete',{id:saved.id})
 await app.mouse.wheel({x:area.x+area.width/2,y:600},0,5000)
 }
 await click('task-view-board')
 for(const view of (process.argv.includes('--visual')?[]:['board','list'])){
 await click(`task-view-${view}`);await app.getByTestId(`task-drag-${first.id}`).waitFor()
 const from=await app.getByTestId(`task-drag-${first.id}`).center();const source=await app.getByTestId(`task-slot-${first.id}`).bounds()
 await app.mouse.move(from);await app.mouse.down(from)
 const moves=[]
 const resource=process.env.R7_SAMPLE==='1'&&view==='board'?await sample('carry'):null
 const until=resource?performance.now()+15500:0
 for(let i=1;i<=60 || performance.now()<until;i++){
  const pointer={x:from.x+(view==='board'?Math.sin(i/60*Math.PI*2)*180:0),y:from.y+Math.min(i*4,220)}
  await app.mouse.move(pointer,{pressedButton:0});await Bun.sleep(8)
  const held=await app.getByTestId('task-drag-ghost').count()
  const ghost=held?await app.getByTestId('task-drag-ghost').bounds():null
  const expected={x:pointer.x-(from.x-source.x),y:pointer.y-(from.y-source.y)}
  moves.push({i,time:performance.now(),pointer,held,ghost,expected})
  if(i>2&&!held)throw Error('Ghost stopped following before release')
 }
 if(resource)await resource.done()
 writeFileSync(`${out}/${label}-${view}-tracking.json`,JSON.stringify(moves,null,2))
 console.log(view,'held at end',moves.at(-1));shot(`${out}/${label}-${view}-held.png`)
 await app.mouse.move({x:from.x,y:from.y+220},{pressedButton:0});await app.mouse.up({x:from.x,y:from.y+220})
 const dropStart=performance.now(),dropFrames=[]
 for(const at of [0,80,160,300]){await Bun.sleep(Math.max(0,dropStart+at-performance.now()));shot(`${out}/${label}-${view}-drop-${at}.png`);dropFrames.push({at,actual:performance.now()-dropStart})}
 writeFileSync(`${out}/${label}-${view}-drop-frames.json`,JSON.stringify(dropFrames))
 await wait(async()=>!await app.getByTestId('task-drag-layer').count(),'release')
 const cancelTask=tasks.find(t=>t.status==='inbox')!
 const pickup=await app.getByTestId(`task-drag-${cancelTask.id}`).center()
 await app.mouse.down(pickup)
 for(let i=1;i<=60;i++){
  await app.mouse.move({x:pickup.x+(view==='board'?i*4:0),y:pickup.y+i*3},{pressedButton:0});await Bun.sleep(16)
  if([1,10,30,60].includes(i))shot(`${out}/${label}-${view}-move-${i}.png`)
 }
 await app.getByTestId('app-ready').press('escape')
 const start=performance.now(),frames=[]
 for(const at of [0,80,160,300]){await Bun.sleep(Math.max(0,start+at-performance.now()));shot(`${out}/${label}-${view}-cancel-${at}.png`);frames.push({at,actual:performance.now()-start})}
 await app.mouse.up({x:pickup.x+(view==='board'?240:0),y:pickup.y+180})
 await wait(async()=>!await app.getByTestId('task-drag-layer').count(),'escape')
 writeFileSync(`${out}/${label}-${view}-cancel-frames.json`,JSON.stringify(frames))
 const area=await app.getByTestId(view==='board'?'task-column-todo':'task-list-viewport').bounds()
 const heldTask=tasks.find(t=>t.title===titles[1])!
 await app.mouse.wheel({x:area.x+area.width/2,y:600},0,5000)
 await app.getByTestId(`task-drag-${heldTask.id}`).waitFor()
 const heldFrom=await app.getByTestId(`task-drag-${heldTask.id}`).center()
 const edge={x:area.x+area.width/2,y:area.y+area.height-12}
 const original=(await client.call('tasks.items.get',{id:heldTask.id})).task!
 await app.mouse.down(heldFrom)
 for(let i=1;i<=24;i++)await app.mouse.move({x:heldFrom.x+(edge.x-heldFrom.x)*i/24,y:heldFrom.y+(edge.y-heldFrom.y)*i/24},{pressedButton:0})
 if(!await app.getByTestId('task-drag-ghost').count())throw Error('Edge pickup did not activate')
 await wait(async()=>(await app.call('getPaintedText',{})).text.join('\n').includes('Drag task 12'),'drag edge scroll reaches last task')
 if(!await app.getByTestId('task-drag-ghost').count())throw Error('Ghost lost during edge scrolling')
 shot(`${out}/${label}-${view}-edge-scroll.png`)
 await app.getByTestId('app-ready').press('escape');await app.mouse.up(edge)
 await wait(async()=>!await app.getByTestId('task-drag-layer').count(),'edge cancel')
 const cancelled=(await client.call('tasks.items.get',{id:heldTask.id})).task!
 if(cancelled.status!==original.status||cancelled.rank!==original.rank)throw Error('Escape committed an edge-scroll drop')
 }
 if(!process.argv.includes('--visual')){
 await click('rail-home')
 const projects=(await client.call('projects.list',{})).projects
 const a=projects.find(p=>p.name==='alpha-app')!,b=projects.find(p=>p.name==='beta-docs')!
 await app.getByTestId(`project-${a.id}`).waitFor()
 const start=await app.getByTestId(`project-${a.id}`).center(),target=await app.getByTestId(`project-${b.id}`).center()
 await app.mouse.down(start)
 const probes=[]
 for(let i=1;i<=60;i++){
  const pointer={x:start.x,y:start.y+(target.y+60-start.y)*i/60}
  await app.mouse.move(pointer,{pressedButton:0});await Bun.sleep(8)
  probes.push({time:performance.now(),pointer,held:await app.getByTestId('project-drag-layer').count()})
 }
 await app.mouse.up({x:start.x,y:target.y+60})
 await wait(async()=>!await app.getByTestId('project-drag-layer').count(),'project release')
 writeFileSync(`${out}/${label}-project-tracking.json`,JSON.stringify(probes))
 }
 writeFileSync(`${out}/${label}.log`,fixture.diagnostics())
}catch(error){if(windowId)shot(`${out}/${label}-failure.png`);writeFileSync(`${out}/${label}-failure-tree.json`,JSON.stringify(await app.getByTestId('app-ready').all()));writeFileSync(`${out}/${label}-failure-native.log`,fixture.diagnostics());throw error}finally{await fixture.close();client.close?.();unlock()}
