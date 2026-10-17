import path from 'node:path'
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import assert from 'node:assert/strict'
import {KybernClient} from '../../../packages/kybern-client/src/client.ts'
import {launchFixture} from '../native/frame-harness.ts'
import {pacingLock} from './pacing-lock.ts'
if(process.env.KYBERN_PACING_FIXTURE!=='1')throw Error('Use pacing-fixture.ts')
const data=process.env.KYBERN_DATA_DIR!,label=process.argv[2]??'after',theme=process.argv[3]??'dark',reduce=process.argv[4]??'0',before=label==='before'
const c=new KybernClient({url:`ws://127.0.0.1:${readFileSync(path.join(data,'daemon.port'),'utf8').trim()}/ws`,token:readFileSync(path.join(data,'daemon.token'),'utf8').trim()});c.connect()
const deadline=Date.now()+15000;while(c.status!=='open'){assert.ok(Date.now()<deadline);await Bun.sleep(20)}
const projects=[]
for(const name of ['alpha-app','beta-docs','gamma-cli','delta-api','epsilon-web']){
 const dir=path.join(data,'drag-projects',name);mkdirSync(dir,{recursive:true});const project=await c.call('projects.add',{path:dir,name});projects.push(project)
 for(let i=1;i<=3;i++)await c.call('threads.create',{project_id:project.id,title:`${name} thread ${i}`,provider:{kind:'claude-code',instance:'default'},model:'claude-haiku-5-5'})
}
c.close()
const release=await pacingLock(),f=await launchFixture(path.join(import.meta.dir,'pacing-app.ts'),{KYBERN_PACING_BASELINE:before?'1':'0',KYBERN_APPEARANCE:theme,KYBERN_REDUCED_MOTION:reduce,KYBERN_FRAME_TIMES:'1',KYBERN_FULL_RATE:before?'0':'1',KYBERN_VSYNC_WAKE:before?'0':'1',KYBERN_REGION_PAINT:before?'0':'1',NAPI_RS_NATIVE_LIBRARY_PATH:process.env.KYBERN_PACING_ADDON??path.join(import.meta.dir,'../native/build/gpuix-native.darwin-arm64.node')})
try{
 const a=f.app;await a.getByTestId('app-ready').waitFor({timeoutMs:60000});await a.getByTestId('composer').waitFor()
 const rows=[]
 const visibleDeadline=Date.now()+10000
 while(rows.length<2){rows.length=0;for(const project of projects){try{const b=await a.getByTestId(`project-${project.id}`).bounds();if(b.y>46&&b.y+b.height<750)rows.push({id:project.id,...b})}catch{}}if(rows.length>=2)break;assert.ok(Date.now()<visibleDeadline,'project headers did not paint');await Bun.sleep(20)}
 rows.sort((a,b)=>a.y-b.y);assert.ok(rows.length>=2,'two project headers must be visible')
 const top=rows[0]!,next=rows[1]!,from={x:top.x+top.width/2,y:top.y+top.height/2},to={x:from.x,y:next.y+next.height+30}
 await a.mouse.move(from);const start=performance.now(),frame0=f.frameEvents().length,counts=f.counts(),packets:number[]=[]
 await a.mouse.down(from)
 for(let i=0;i<90;i++){const t=performance.now(),u=(i+1)/90,e=u*u*(3-2*u);await a.mouse.move({x:from.x,y:from.y+(to.y-from.y)*e},{pressedButton:0});packets.push(performance.now()-t);await Bun.sleep(8)}
 await a.getByTestId('project-drag-layer').waitFor();await a.mouse.up(to)
 const end=Date.now()+5000;for(;;){const p=await a.getByTestId(`project-${top.id}`).bounds(),n=await a.getByTestId(`project-${next.id}`).bounds();if(p.y>n.y)break;assert.ok(Date.now()<end,'project drop did not reorder headers');await Bun.sleep(20)}
 const times=f.frameEvents().slice(frame0).map(v=>v.native),dt=times.slice(1).map((v,i)=>v-times[i]!).sort((a,b)=>a-b),result={label,theme,reduce,elapsedMs:performance.now()-start,frames:times.length,p50:dt[Math.floor(dt.length*.5)]??null,p95:dt[Math.floor(dt.length*.95)]??null,max:dt.at(-1)??null,commits:f.counts().commits-counts.commits,islands:f.counts().renders-counts.renders,packetP95:[...packets].sort((a,b)=>a-b)[85],intervals:dt,from,to}
 writeFileSync(`/Users/mymac/projects/ade/previews/gpuix/round7/pacing/projects-${label}-${theme}-${reduce}.json`,JSON.stringify(result,null,2));console.log(JSON.stringify({...result,intervals:undefined}))
}catch(e){console.error(f.diagnostics());throw e}finally{await f.close();release()}
