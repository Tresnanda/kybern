/** October 16 audit: independent warm samples and observed first painted text.
 * Reuses ONLY the visual tool's checkout-isolated scratch daemon, after captures.
 */
import { connectStdio } from '@gpuix/react/automation'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { readState, connect, DATA_DIR, SCRATCH } from '../visual/fixture.ts'
const out='/Users/mymac/projects/ade/previews/gpuix/audit-2026-10-16'
const diagnostics=Bun.spawn(['bun','scripts/audit-failed-capture.ts'],{stdout:Bun.file(path.join(out,'failed-captures.log')),stderr:'inherit'});await diagnostics.exited
const supplemental=Bun.spawn(['bun','scripts/audit-notes-capture.ts'],{stdout:Bun.file(path.join(out,'supplemental.log')),stderr:'inherit'});await supplemental.exited
const state=readState();if(!state || state.port===4219)throw Error('Start isolated visual fixture first')
const client=await connect(state)
const threads=(await client.call('threads.list',{})).threads
const thread=threads.find(t=>t.title==='Date helper cleanup')
if(!thread)throw Error('Populated visual conversation missing')
const transcript=await client.call('threads.get',{thread_id:thread.id})
const tasks=(await client.call('tasks.items.list',{})).tasks
writeFileSync(path.join(out,'performance-workload.json'),JSON.stringify({threadTitle:thread.title,threadCount:threads.length,transcriptEntries:transcript.transcript.length,transcriptJsonBytes:Buffer.byteLength(JSON.stringify(transcript.transcript)),tasks:tasks.length,logicalWindow:'1280x820',threadFixture:'two settled turns, formatted answer with table/code, three tool calls'},null,2))
client.close()
const bundle='/Users/mymac/projects/ade-gpuix-native/apps/gpuix/dist/Kybern GPUIX.app/Contents/MacOS/Kybern GPUIX'
const records:any[]=[]
async function launch(kind:'source'|'bundle',scene='home'){
 const config=path.join(SCRATCH,'audit-performance-client');rmSync(config,{recursive:true,force:true});mkdirSync(config,{recursive:true})
 writeFileSync(path.join(DATA_DIR,'gpuix-ui.json'),'{}')
 const env={...process.env,GPUIX_BACKGROUND:'1',KYBERN_DATA_DIR:DATA_DIR,KYBERN_CLIENT_CONFIG_DIR:config,KYBERN_GPUIX_CREDENTIALS_DIR:path.join(config,'credentials'),KYBERN_GPUIX_ENVIRONMENT:'local',KYBERN_URL:'',KYBERN_TOKEN:'',KYBERN_APPEARANCE:'dark',KYBERN_REDUCED_MOTION:'0',KYBERN_GPUIX_THREAD:scene==='thread'?thread!.id:''}
 const begin=performance.now()
 const child=spawn(kind==='source'?'bun':bundle,kind==='source'?[path.resolve('src/main.tsx')]:[],{env,stdio:['pipe','pipe','pipe']})
 let err='';child.stderr.on('data',x=>err=(err+String(x)).slice(-4000))
 let timer:any
 try{
  const app=await Promise.race([connectStdio({write:x=>child.stdin.write(x),feed:f=>child.stdout.on('data',x=>f(String(x))),close:async()=>{child.kill()}}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('startup timeout '+err)),45000);child.once('error',reject);child.once('exit',code=>reject(Error('startup exit '+code+' '+err)))})]);clearTimeout(timer)
  let painted=''
  while(performance.now()-begin<45000){painted=(await app.call('getPaintedText',{})).text.join(' ');if(painted.trim())break;await Bun.sleep(5)}
  const paintMs=performance.now()-begin
  await app.getByTestId('app-ready').waitFor({timeoutMs:45000})
  return {app,pid:child.pid!,paintMs,painted,close:async()=>{await app.close();child.kill()},diagnostics:()=>err}
 }catch(e){clearTimeout(timer);child.kill();throw e}
}
function save(){writeFileSync(path.join(out,'performance.json'),JSON.stringify(records,null,2))}
for(const kind of existsSync(bundle)?['source','bundle'] as const:['source'] as const){
 for(let run=1;run<=5;run++){
  const f=await launch(kind)
  try{records.push({kind,scene:'startup',run,firstPaintObservedMs:Math.round(f.paintMs),painted:f.painted.slice(0,180)});save();console.log('STARTUP',kind,run,Math.round(f.paintMs))}finally{await f.close()}
 }
}
for(const scene of ['home','thread','settings','tasks-board'])for(let run=1;run<=2;run++){
 const f=await launch('source',scene)
 try{
  if(scene==='thread')await f.app.getByTestId('composer').waitFor({timeoutMs:30000})
  if(scene==='settings'){await f.app.getByTestId('rail-settings').click();await f.app.getByTestId('page-settings').waitFor()}
  if(scene==='tasks-board'){await f.app.getByTestId('rail-tasks').click();await f.app.getByTestId('task-view-board').click()}
  console.log('WARMUP',scene,run);await Bun.sleep(10000)
  const paintedAtSample=(await f.app.call('getPaintedText',{})).text.join(' ').slice(0,6000)
  const contention=execFileSync('ps',['-axo','pid,pcpu,comm'],{encoding:'utf8'}).split('\n').filter(x=>/bun|node|rustc|cargo|swift|clang|WebKit|vite|kybern|Safari|Chrome|tauri/.test(x)).join('\n')
  const sample=Bun.spawn(['bun','perf/sample.ts','15',`${scene}-${run}=${f.pid}`],{stdout:'pipe',stderr:'pipe'})
  const output=await new Response(sample.stdout).text();const errors=await new Response(sample.stderr).text();const code=await sample.exited
  records.push({kind:'source',scene,run,output,errors,code,contention,paintedAtSample});save();console.log(output,errors)
  await f.app.screenshot({path:path.join(out,`perf-${scene}-${run}.png`)})
 }finally{await f.close()}
}
