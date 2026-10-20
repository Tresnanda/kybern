import '../../src/native/local-build.ts'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs'
import path from 'node:path'
import {startDaemon,connect,stopPid,SCRATCH,DATA_DIR,CLIENT_DIR,CREDS_DIR} from '../../visual/fixture.ts'
import {launchFixture} from '../../scripts/idle-harness.ts'
import {requireScreen} from '../bench/screen-state.ts'
import {waitForWindowOnscreen,requireWindowOnscreen} from '../bench/window-onscreen.ts'
import {pixels} from '../../native/png.ts'
import type {Project} from '../../../../packages/kybern-client/src/types.ts'
const out=process.env.SIDEBAR_OUT!, label=process.env.SIDEBAR_LABEL??'baseline'
assert.ok(SCRATCH.includes('/sidebar-fix-'))
mkdirSync(out,{recursive:true});mkdirSync(SCRATCH,{recursive:true})
execFileSync('clang',['-dynamiclib','-fobjc-arc','-framework','Cocoa','perf/hover/input.m','-o',path.join(SCRATCH,'hover-input.dylib')])
const daemon=await startDaemon(true), client=await connect(daemon)
const projects:Project[]=[]
try {
 for(let i=0;i<8;i++){
  const folder=path.join(SCRATCH,`project-${i}`);mkdirSync(folder,{recursive:true})
  const project=await client.call('projects.add',{path:folder,name:`${String.fromCharCode(65+i)} sidebar project`});projects.push(project)
  if(i<2)for(let t=0;t<2;t++)await client.call('threads.create',{project_id:project.id,title:`Sidebar thread ${i}-${t}`,provider:{kind:'claude-code',instance:'default'},model:'claude-haiku-5-5'})
 }
 for(const theme of (process.env.SIDEBAR_THEMES??'dark,light').split(',')) {
  requireScreen()
  const input=path.join(SCRATCH,`input-${theme}.json`);writeFileSync(input,'{}')
  const f=await launchFixture(path.resolve('perf/hover/sidebar-entry.ts'),{GPUIX_BACKGROUND:'1',KYBERN_DATA_DIR:DATA_DIR,KYBERN_CLIENT_CONFIG_DIR:CLIENT_DIR,KYBERN_GPUIX_CREDENTIALS_DIR:CREDS_DIR,KYBERN_URL:'',KYBERN_TOKEN:'',KYBERN_APPEARANCE:theme,KYBERN_WINDOW_SIZE:'1280x820',KYBERN_OPAQUE:'1',SIDEBAR_INPUT:input})
  const a=f.app, snapshots:unknown[]=[], clicks:unknown[]=[], otherRows:unknown[]=[], gestures:unknown[]=[]
  const read=async(command:object={})=>{
   const nonce=crypto.randomUUID();writeFileSync(input,JSON.stringify({nonce,...command}));const end=Date.now()+5000
   while(!existsSync(input+'.done')||JSON.parse(readFileSync(input+'.done','utf8')).nonce!==nonce){assert.ok(Date.now()<end,'Snapshot acknowledgment');await Bun.sleep(10)}
   return JSON.parse(readFileSync(input+'.done','utf8'))
  }
  try{
   await a.getByTestId('app-ready').waitFor({timeoutMs:60000});await waitForWindowOnscreen(f.pid);assert.equal((await read({prepare:true})).accepted,1);await Bun.sleep(1800)
   const shot=async(name:string)=>{
    requireScreen();requireWindowOnscreen(f.pid)
    const file=path.join(out,`${label}-${theme}-${name}.png`);await a.screenshot({path:file});return file
   }
   await a.mouse.move({x:1100,y:700});await Bun.sleep(100)
   const headers:{project:Project;b:{x:number;y:number;width:number;height:number}}[]=[]
   for(const project of projects){const b=await a.getByTestId(`project-${project.id}`).bounds().catch(()=>null);if(b&&b.y>60&&b.y+b.height<790)headers.push({project,b})}
   assert.ok(headers.length>=3,`At least 3 visible projects; got ${headers.length}`)
   // Seed a mixed sidebar, leaving the threaded projects expanded.
   const collapsed=headers.at(-1)!;await read({collapse:collapsed.project.id});await Bun.sleep(350)
   for(const {project,b}of headers.slice(0,3)){
    await a.mouse.move({x:1100,y:700});await Bun.sleep(80);await read({clear:true})
    const point={x:b.x+90,y:b.y+14};await a.mouse.move(point)
    const begin=performance.now(),samples=[]
    for(const ms of [20,100,300,700,1200,2000,...(label==='fixed'?[3000,5000]:[])]){
     await Bun.sleep(Math.max(0,begin+ms-performance.now()));const state=await read()
     const file=[20,2000,5000].includes(ms)?await shot(`project-${project.name[0]}-${ms}ms`):undefined
     const pixel=file?pixels(file).at((headers[0]!.b.x+28)*2,(b.y+3)*2):undefined
     samples.push({ms,actual:performance.now()-begin,...state,pixel})
    }
    const png=pixels(await shot(`project-${project.name[0]}-parked`))
    const color=png.at((headers[0]!.b.x+28)*2,(b.y+3)*2)
    snapshots.push({id:project.id,name:project.name,point,b,color,samples,native:f.diagnostics()})
   }
   if(label==='fixed') {
    const thread=(await client.call('threads.list',{})).threads.find(t=>t.project_id===headers[0]!.project.id)!
    for(const [kind,id]of [['thread',`thread-${thread.id}`],['coordinator',`create-coordinator-${headers[0]!.project.id}`]]){
     const b=await a.getByTestId(id!).bounds(),point={x:b.x+80,y:b.y+b.height/2}
     await a.mouse.move({x:1100,y:700});await Bun.sleep(200)
     const resting=pixels(await shot(`${kind}-resting`)).at((headers[0]!.b.x+28)*2,(b.y+3)*2)
     await a.mouse.move(point);await Bun.sleep(300);const entered=await read()
     const early=pixels(await shot(`${kind}-300ms`)).at((headers[0]!.b.x+28)*2,(b.y+3)*2)
     await Bun.sleep(5000);const parked=await read()
     const late=pixels(await shot(`${kind}-5000ms`)).at((headers[0]!.b.x+28)*2,(b.y+3)*2)
     writeFileSync(path.join(out,`${label}-${theme}-${kind}-bounds.json`),JSON.stringify({b,point,resting,early,late,entered,parked},null,2))
     assert.notDeepEqual(early,resting,`${kind}: hover material is visible`)
     assert.deepEqual(late,early,`${kind}: parked hover material stays visible`)
     if(kind==='thread')assert.equal(parked.rows.find((r:any)=>r.name==='ThreadRow'&&r.id===thread.id)?.hooks[0],true,'Thread JS hover stays set')
     otherRows.push({kind,b,point,resting,early,late,entered,parked})
    }
   }
   const clickTarget=headers[0]!
   await read({draft:headers[1]!.project.id});await Bun.sleep(250)
   for(let i=0;i<Number(process.env.SIDEBAR_CLICKS??36);i++){
    // Avoid reusing a stale rect after a click toggles the project.
    const b=await a.getByTestId(`project-${clickTarget.project.id}`).bounds()
    const point={x:b.x+[8,70,b.width/2][i%3]!,y:b.y+[9,14,20][i%3]!}
    await a.mouse.move({x:1100,y:700});await Bun.sleep(30);await read({clear:true});await a.mouse.move(point)
    const before=await read();await a.mouse.down(point);await Bun.sleep([0,30,180][i%3]);const held=await read();await a.mouse.up(point);await Bun.sleep(230)
    const result=await read();clicks.push({i,point,held,result})
    if(label==='fixed') {
     if(i%3!==0)assert.equal(result.draft.projectId,clickTarget.project.id,'Name click opens the project draft')
     if(i%3===0||before.draft.projectId===clickTarget.project.id)assert.notEqual(!!result.collapsed[clickTarget.project.id],!!before.collapsed[clickTarget.project.id],'Disclosure or active-project click toggles the project')
    }
    if(result.trace.some((e:any)=>e.kind==='drag')) {await a.call('keystrokes',{keys:'escape'});await Bun.sleep(500)}
   }
   if(label==='fixed'&&(await read()).collapsed[clickTarget.project.id]){await read({collapse:clickTarget.project.id});await Bun.sleep(350)}
   if(label==='fixed')for(const kind of ['jitter','within','fast-exit']){
    const b=await a.getByTestId(`project-${clickTarget.project.id}`).bounds()
    const from={x:b.x+100,y:b.y+(kind==='fast-exit'?1:14)}
    const to={x:from.x+(kind==='within'?8:kind==='jitter'?3:0),y:from.y+(kind==='fast-exit'?-3:0)}
    await a.mouse.move({x:1100,y:700});await Bun.sleep(100);await a.mouse.move(from);await Bun.sleep(200);await read({clear:true})
    await a.mouse.down(from);await a.mouse.move(to,{pressedButton:0});await Bun.sleep(150)
    const held=await read(),started=held.trace.some((e:any)=>e.kind==='drag')
    assert.equal(started,kind!=='jitter',`${kind}: drag activation`)
    if(kind!=='jitter')assert.equal(await a.getByTestId('project-drag-ghost').count(),1,'Real project ghost is visible')
    await a.call('keystrokes',{keys:'escape'});await a.mouse.up(to);await Bun.sleep(650)
    gestures.push({kind,from,to,held})
    assert.equal(await a.getByTestId('project-drag-layer').count(),0,'Drag cancels and releases')
   }
   const failures=(snapshots as any[]).filter(row=>row.samples.some((sample:any)=>sample.rows.find((r:any)=>r.name==='ProjectHeader'&&r.id===row.id)?.hooks[0]!==true)||row.samples.at(-1).trace.some((event:any)=>event.kind==='hover'&&event.scope===row.id&&!event.on))
   const drags=(clicks as any[]).filter(click=>click.result.trace.some((e:any)=>e.kind==='drag'))
   const result={label,theme,hoverFailures:failures.length,hoverCases:snapshots.length,stationaryDrags:drags.length,stationaryClicks:clicks.length,snapshots,clicks,otherRows,gestures}
   writeFileSync(path.join(out,`${label}-${theme}.json`),JSON.stringify(result,null,2));console.log(JSON.stringify({label,theme,hoverFailures:failures.length,stationaryDrags:drags.length,stationaryClicks:clicks.length}))
   if(label==='fixed'){assert.equal(failures.length,0,'Parked project hover');assert.equal(drags.length,0,'Stationary clicks never drag')}
  }finally{writeFileSync(path.join(out,`${label}-${theme}.log`),f.diagnostics());await f.close()}
 }
}finally{client.close();stopPid(daemon.daemonPid)}
