// Identical, screenshot-free input loops for task board/list and project carry.
// Bounds callbacks are native paint notifications, not OS display presentation.
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {connect} from '../../visual/fixture.ts'
import {launchFixture} from './round7b-harness.ts'
import {acquirePreviewUiLock} from '../../scripts/preview-ui-lock.ts'
const data='/Users/mymac/projects/ade-gpuix-scratch/round7-tasks7b'
const out='/Users/mymac/projects/ade/previews/gpuix/round7/tasks7b'
const client=await connect({daemonPid:0,port:4276,token:readFileSync(`${data}/daemon.token`,'utf8').trim(),seeded:true})
if(process.env.R7_LOCK_HELD!=='1'&&readFileSync('/tmp/kybern-gpuix-ui-queue','utf8').trim().split('\n')[0]!=='tasks7b')throw Error('Queue tasks7b before acquiring the UI lock')
const unlock=process.env.R7_LOCK_HELD==='1'?()=>{}:acquirePreviewUiLock()
const label=process.env.R7_LABEL??'carry-comparison'
writeFileSync(`${data}/gpuix-ui.json`,'{}')
const fixture=await launchFixture(path.resolve('src/tasks/round7b-app.ts'),{GPUIX_BACKGROUND:'1',KYBERN_DATA_DIR:data,KYBERN_APPEARANCE:process.env.KYBERN_APPEARANCE??'dark',KYBERN_OPAQUE:'1',KYBERN_CLIENT_CONFIG_DIR:`${data}/client`,KYBERN_GPUIX_CREDENTIALS_DIR:`${data}/creds`,KYBERN_DEBUG_DRAG:process.env.R7_DEBUG??'0',...(process.env.R7_ISLANDS==='1'?{KYBERN_DEBUG_ISLANDS:'1'}:{}),KYBERN_DRAG_PACING:`${out}/${label}-pacing`,NAPI_RS_NATIVE_LIBRARY_PATH:path.resolve('native/build/gpuix-native.darwin-arm64.node')})
let windowId=''
const shot=(file:string)=>{execFileSync('screencapture',['-x','-o','-l',windowId,file])}
const app=fixture.app;const click=async(id:string)=>{console.log('click',id);await app.getByTestId(id).waitFor({timeoutMs:10000});await app.getByTestId(id).click()};console.log('running',label,fixture.pid)
const wait=async(f:()=>Promise<boolean>,name:string)=>{const end=Date.now()+6000;while(!await f()){if(Date.now()>end)throw Error(`timeout ${name}`);await Bun.sleep(16)}}
try{
 await app.getByTestId('app-ready').waitFor({timeoutMs:60000});await app.clock.resume()
 const tasks=(await client.call('tasks.items.list',{})).tasks
 const task=tasks.find(t=>t.title==='Inbox drag task 1')!
 const projects=(await client.call('projects.list',{})).projects
 const counts=[]
 for(const kind of (process.env.R7_KINDS?.split(',') ?? ['board','list','projects'])){
  if(kind==='projects')await click('rail-home')
  else{await click('rail-tasks');await click(`task-view-${kind}`)}
  if(kind==='board'){await app.getByTestId(`task-drag-${task.id}`).waitFor();const geometry=[];for(const candidate of tasks.filter(t=>t.status==='todo').sort((a,b)=>a.rank-b.rank).slice(0,5)){const row=await app.getByTestId(`task-row-${candidate.id}`).bounds(),title=await app.getByTestId(`task-drag-${candidate.id}`).bounds();if(title.height+45>row.height+1)throw Error('Title exceeds padded card height');geometry.push({title:candidate.title,row,text:title})}writeFileSync(`${out}/${label}-title-containment.json`,JSON.stringify(geometry,null,2))}
  const source=kind==='projects'?`project-${projects.find(p=>p.name==='alpha-app')!.id}`:`task-drag-${task.id}`
  await app.getByTestId(source).waitFor()
  const from=await app.getByTestId(source).center(),times=[]
  await app.mouse.move(from);await app.mouse.down(from)
  const resource=process.env.R7_RESOURCES==='1'?Bun.spawn(['bun','perf/sample.ts','15',`GPUIX=${fixture.pid}`],{stdout:'pipe',stderr:'pipe'}):null
  const until=resource?performance.now()+15500:0
  if(process.env.R7_PROFILE==='1')Bun.spawn(['sample',String(fixture.pid),'8','1','-file',`${out}/${label}-${kind}-sample.txt`],{stdout:'ignore',stderr:'ignore'})
  for(let i=1;i<=120||performance.now()<until;i++){
   const step=resource?1+(i-1)%120:i;const pointer={x:from.x+(kind==='board'?step*2:0),y:from.y+step*1.5}
   const before=performance.now();await app.mouse.move(pointer,{pressedButton:0});times.push({before,after:performance.now()})
   await Bun.sleep(8)
  }
  if(resource){const report=await new Response(resource.stdout).text();await resource.exited;writeFileSync(`${out}/${label}-${kind}-resources.txt`,report);console.log(kind,report)}
  const held=await app.getByTestId(kind==='projects'?'project-drag-layer':'task-drag-ghost').count()
  if(!held)throw Error(`Lost ${kind} drag`)
  await app.getByTestId('app-ready').press('escape');await app.mouse.up({x:from.x+(kind==='board'?240:0),y:from.y+180})
  await wait(async()=>!await app.getByTestId(kind==='projects'?'project-drag-layer':'task-drag-layer').count(),'cancel')
  counts.push({kind,times});
 }
 writeFileSync(`${out}/${label}-input.json`,JSON.stringify(counts))
 writeFileSync(`${out}/${label}-native.log`,fixture.diagnostics())
}finally{await fixture.close();client.close?.();unlock()}
