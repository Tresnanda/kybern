// Matched fresh list state; OS captures only. Do not use this run for performance.
import {readFileSync,writeFileSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import path from 'node:path'
import {connect} from '../../visual/fixture.ts'
import {launchFixture} from './round7b-harness.ts'
const data='/Users/mymac/projects/ade-gpuix-scratch/round7-tasks7b',out='/Users/mymac/projects/ade/previews/gpuix/round7/tasks7b'
const client=await connect({daemonPid:0,port:4276,token:readFileSync(`${data}/daemon.token`,'utf8').trim(),seeded:true})
const task=(await client.call('tasks.items.list',{})).tasks.find(t=>t.title==='Inbox drag task 1')!
const label=process.env.R7_LABEL!
writeFileSync(`${data}/gpuix-ui.json`,'{}')
const fixture=await launchFixture(path.resolve('src/tasks/round7b-app.ts'),{GPUIX_BACKGROUND:'1',KYBERN_DATA_DIR:data,KYBERN_OPAQUE:'1',KYBERN_CLIENT_CONFIG_DIR:`${data}/client`,KYBERN_GPUIX_CREDENTIALS_DIR:`${data}/creds`})
const app=fixture.app
try{
 await app.getByTestId('app-ready').waitFor({timeoutMs:60000});await app.clock.resume()
 await app.getByTestId('rail-tasks').click();await app.getByTestId('task-view-list').waitFor();await app.getByTestId('task-view-list').click()
 await app.getByTestId(`task-drag-${task.id}`).waitFor()
 const from=await app.getByTestId(`task-drag-${task.id}`).center()
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
