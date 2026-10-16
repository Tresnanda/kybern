// Characterize real-clock carry against an intentionally paused animation clock.
// R7_CLOCK=manual reproduces the verifier artifact; production code is unchanged.
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {connect} from '../../visual/fixture.ts'
import {launchFixture} from '../requests/harness.ts'
import {acquirePreviewUiLock} from '../../scripts/preview-ui-lock.ts'
const data='/Users/mymac/projects/ade-gpuix-scratch/round7-tasks'
const out='/Users/mymac/projects/ade/previews/gpuix/round7/tasks'
const client=await connect({daemonPid:0,port:4272,token:readFileSync(`${data}/daemon.token`,'utf8').trim(),seeded:true})
if(process.env.R7_LOCK_HELD!=='1'&&readFileSync('/tmp/kybern-gpuix-ui-queue','utf8').trim().split('\n')[0]!=='tasks7')throw Error('Queue tasks7 before acquiring the UI lock')
const unlock=process.env.R7_LOCK_HELD==='1'?()=>{}:acquirePreviewUiLock()
const label=process.env.R7_LABEL??'project-before'
writeFileSync(`${data}/gpuix-ui.json`,'{}')
const fixture=await launchFixture(path.resolve('src/tasks/round7-app.ts'),{GPUIX_BACKGROUND:'1',KYBERN_DATA_DIR:data,KYBERN_APPEARANCE:process.env.KYBERN_APPEARANCE??'dark',KYBERN_OPAQUE:'1',KYBERN_CLIENT_CONFIG_DIR:`${data}/client`,KYBERN_GPUIX_CREDENTIALS_DIR:`${data}/creds`,KYBERN_DEBUG_DRAG:process.env.R7_DEBUG??'0',KYBERN_DRAG_PACING:`${out}/${label}-pacing`,NAPI_RS_NATIVE_LIBRARY_PATH:path.resolve('native/build/gpuix-native.darwin-arm64.node')})
let windowId=''
const shot=(file:string)=>{execFileSync('screencapture',['-x','-o','-l',windowId,file])}
const app=fixture.app;const click=async(id:string)=>{console.log('click',id);await app.getByTestId(id).waitFor({timeoutMs:10000});await app.getByTestId(id).click()};console.log('running',label,fixture.pid)
const wait=async(f:()=>Promise<boolean>,name:string)=>{const end=Date.now()+6000;while(!await f()){if(Date.now()>end)throw Error(`timeout ${name}`);await Bun.sleep(16)}}
try{
 await app.getByTestId('app-ready').waitFor({timeoutMs:60000})
 windowId=execFileSync('swift',[path.resolve('src/tasks/round7-window-id.swift'),String(fixture.pid)],{encoding:'utf8'}).trim()
 if(process.env.R7_TASK_VISIT==='1'){await click('rail-tasks');await click('task-view-board');await click('task-board-add-todo');await app.getByTestId('task-quick-title').waitFor();await app.getByTestId('task-quick-title').press('escape');await click('rail-home')}
 const projects=(await client.call('projects.list',{})).projects
 const a=projects.find(p=>p.name==='alpha-app')!, b=projects.find(p=>p.name==='gamma-cli')!
 await app.getByTestId(`project-${a.id}`).waitFor()
 for(let run=0;run<4;run++){
 console.log('project run',run);if(process.env.R7_CLOCK==='manual')await app.clock.fastForward(32);else await app.clock.resume()
 const start=await app.getByTestId(`project-${a.id}`).center(),target=await app.getByTestId(`project-${b.id}`).center()
 await app.mouse.move(start);await app.mouse.down(start)
 const probes=[]
 for(let i=1;i<=90;i++){
  const pointer={x:start.x+(process.env.R7_ARC==='1'?Math.sin(i/90*Math.PI)*65:0),y:start.y+(target.y+60-start.y)*i/90}
  const before=performance.now();await app.mouse.move(pointer,{pressedButton:0});const moved=performance.now()
  await Bun.sleep(8)
  probes.push({before,moved,pointer,held:await app.getByTestId('project-drag-layer').count()})
  if(run===3&&[1,15,45,90].includes(i))shot(`${out}/${label}-move-${i}.png`)
 }
 await app.getByTestId('project-drag-layer').press('escape')
 for(const ms of [0,80,160,300]){if(ms)await Bun.sleep(80);if(run===3)shot(`${out}/${label}-cancel-${ms}.png`)}
 await wait(async()=>!await app.getByTestId('project-drag-layer').count(),'project cancel')
 writeFileSync(`${out}/${label}-tracking-${run}.json`,JSON.stringify(probes))
 }
 writeFileSync(`${out}/${label}-native.log`,fixture.diagnostics())
}finally{await fixture.close();client.close?.();unlock()}
