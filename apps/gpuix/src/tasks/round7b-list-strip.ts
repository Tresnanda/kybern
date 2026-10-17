// Matched fresh list state; OS captures only. Do not use this run for performance.
import {readFileSync,writeFileSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import path from 'node:path'
import {connect} from '../../visual/fixture.ts'
import {launchFixture,resetDragPreferences} from './round7b-harness.ts'
const data=process.env.R8_DATA??'/Users/mymac/projects/ade-gpuix-scratch/round7-tasks7b',out=process.env.R8_OUT??'/Users/mymac/projects/ade/previews/gpuix/round7/tasks7b'
const client=await connect({daemonPid:0,port:Number(readFileSync(`${data}/daemon.port`,'utf8').trim()),token:readFileSync(`${data}/daemon.token`,'utf8').trim(),seeded:true})
const task=(await client.call('tasks.items.list',{})).tasks.find(t=>t.title==='Inbox drag task 1')!
const label=process.env.R7_LABEL!
const reference=JSON.parse(readFileSync(`${out}/${label}-tauri-list-drag/frames.json`,'utf8'))
let before:string|null=null
for(const item of reference.tasks.filter((t:any)=>t.status==='todo').sort((a:any,b:any)=>b.rank-a.rank)){await client.call('tasks.items.update',{id:item.id,status:'todo',before_id:before});before=item.id}
resetDragPreferences(data)
const fixture=await launchFixture(path.resolve('src/tasks/round7b-app.ts'),{GPUIX_BACKGROUND:'1',KYBERN_DATA_DIR:data,KYBERN_OPAQUE:'1',KYBERN_CLIENT_CONFIG_DIR:`${data}/client`,KYBERN_GPUIX_CREDENTIALS_DIR:`${data}/creds`})
const app=fixture.app
try{
 await app.getByTestId('app-ready').waitFor({timeoutMs:60000});await app.clock.resume()
 await app.getByTestId('rail-tasks').click();await app.getByTestId('task-view-list').waitFor();await app.getByTestId('task-view-list').click()
 await app.getByTestId(`task-drag-${task.id}`).waitFor()
 let from=await app.getByTestId(`task-drag-${task.id}`).center()
 if(Math.abs(from.y-reference.from.y)>1){await app.mouse.wheel(from,0,reference.from.y-from.y);const deadline=Date.now()+3000;while(Math.abs(from.y-reference.from.y)>1&&Date.now()<deadline){await Bun.sleep(16);from=await app.getByTestId(`task-drag-${task.id}`).center()}}
 if(Math.abs(from.y-reference.from.y)>1)throw Error(`List capture scroll did not match: ${from.y} vs ${reference.from.y}`)
 const window=execFileSync('swift',[path.resolve('src/tasks/round7-window-id.swift'),String(fixture.pid)],{encoding:'utf8'}).trim()
 const shot=(name:string)=>execFileSync('screencapture',['-x','-o','-l',window,`${out}/${label}-native-${name}.png`])
 shot('list');await app.mouse.move(from);await app.mouse.down(from)
 const start=performance.now(),samples=[]
 for(let i=1;i<=60;i++){
  await app.mouse.move({x:from.x,y:from.y+i*3},{pressedButton:0});await Bun.sleep(16)
  if([1,10,30,60].includes(i)){shot(`move-${i}`);samples.push({i,at:performance.now()-start,held:await app.getByTestId('task-drag-ghost').count()})}
 }
 await app.getByTestId('app-ready').press('escape');await app.mouse.up({x:from.x,y:from.y+180})
 const end=performance.now()
 for(const at of [0,80,160,300]){await Bun.sleep(Math.max(0,end+at-performance.now()));shot(`cancel-${at}`)}
 writeFileSync(`${out}/${label}-native-frames.json`,JSON.stringify({from,samples,kind:'OS captures; input positions, not display-frame certification'}))
}finally{await fixture.close();client.close?.()}
