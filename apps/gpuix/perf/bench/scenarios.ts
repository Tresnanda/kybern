import {requireScreen,requireActiveSample,screenState} from './screen-state.ts'
import {assertDisplayReady} from './display-gate.ts'
import {watchRun} from './process-gate.ts'
import {onExit} from './lifetime.ts'
import {mkdirSync,readFileSync,existsSync,rmSync,writeFileSync} from 'node:fs'
import path from 'node:path'
import {spawn} from 'node:child_process'
import {launchFixture} from '../../src/requests/harness.ts'
import {actionFixture} from '../../src/pulls/verify.fixture.ts'
import {emptyResult,type Result,type Scenario} from './model.ts'
import {Telemetry,parseResources} from './telemetry.ts'
import {requireWindowOnscreen,waitForWindowOnscreen} from './window-onscreen.ts'
import {drive,type Point} from './input.ts'
import type {seed} from './seed.ts'
type Fixture=Awaited<ReturnType<typeof seed>>
type Launch=Awaited<ReturnType<typeof launchFixture>>
const root=path.resolve(import.meta.dir,'../..')
const delay=(ms:number)=>Bun.sleep(ms)
async function until<T>(check:()=>Promise<T|false|null|undefined>,message:string,timeout=30000):Promise<T>{const deadline=performance.now()+timeout;for(;;){const value=await check();if(value)return value;if(performance.now()>deadline)throw Error(message);await delay(20)}}
async function painted(app:Launch['app'],pattern:RegExp,timeout=30000){return until(async()=>{const text=(await app.call('getPaintedText',{})).text.join('\n');return pattern.test(text)?text:false},`No painted content matching ${pattern}`,timeout)}
async function bounds(app:Launch['app'],id:string){return until(async()=>{try{const b=await app.getByTestId(id).bounds();return b.width>0&&b.height>0?b:false}catch{return false}},`No painted bounds: ${id}`)}
async function click(app:Launch['app'],id:string){const b=await bounds(app,id);await app.mouse.click({x:b.x+b.width/2,y:b.y+b.height/2})}
export async function scenario(name:Scenario,runs:number,fixture:Fixture,evidence:string,options:{seconds:number;warmup:number;profile?:boolean}):Promise<Result[]>{
 if(name.startsWith('startup-'))assertDisplayReady()
 const awake=name.startsWith('startup-')?spawn('caffeinate',['-d','-u','-w',String(process.pid)],{stdio:'ignore'}):undefined
 const unregister=onExit(()=>{awake?.kill()})
 try{const results=await runScenario(name,runs,fixture,evidence,options);if(name.startsWith('startup-'))assertDisplayReady();return results}finally{awake?.kill();unregister()}
}
async function runScenario(name:Scenario,runs:number,fixture:Fixture,evidence:string,options:{seconds:number;warmup:number;profile?:boolean}):Promise<Result[]>{
 if(name==='startup-packaged'){
  const executable=process.env.KYBERN_BENCH_PACKAGED_EXECUTABLE??path.join(root,'dist/Kybern GPUIX.app/Contents/MacOS/Kybern GPUIX')
  if(!existsSync(executable))return Array.from({length:runs},(_,i)=>({...emptyResult(name,i+1),status:'skipped',reason:'No packaged GPUIX bundle or checkout-local Rust binaries; a Rust packaging build is outside the quick suite.'} as Result))
  const rows:Result[]=[]
  for(let run=1;run<=runs;run++){
   assertDisplayReady()
   const r=emptyResult(name,run),client=path.join(fixture.data,'client',`${name}-${run}`);mkdirSync(client,{recursive:true})
   const prefsFile=path.join(fixture.data,'gpuix-ui.json')
   const prefs=existsSync(prefsFile)?JSON.parse(readFileSync(prefsFile,'utf8')):{}
   prefs['kybern.split-view.v1']={version:1,root:{kind:'leaf',id:'main',threadId:fixture.manifest.long3000},focusedPaneId:'main'}
   writeFileSync(prefsFile,JSON.stringify(prefs))
   await fixture.restart()
   const buildWatch=watchRun(),at=performance.now(),t=new Telemetry()
   let f:Launch|undefined
   try{
    f=await launchFixture(path.join(import.meta.dir,'package-entry.ts'),{...fixture.env,KYBERN_CLIENT_CONFIG_DIR:client,KYBERN_GPUIX_CREDENTIALS_DIR:path.join(client,'credentials'),KYBERN_BENCH_PACKAGED_EXECUTABLE:executable,GPUIX_BACKGROUND:'1',KYBERN_FULL_RATE:process.env.KYBERN_FULL_RATE??'1',KYBERN_FRAME_TIMES:'1',KYBERN_GPUIX_THREAD:''},{stderr:t.stderr})
    await bounds(f.app,'app-ready');r.timings.firstPaintedShellMs=performance.now()-at
    await until(async()=>{
     const text=(await f!.app.call('getPaintedText',{})).text.join('\n'),ms=performance.now()-at
     if(r.timings.sidebarPaintMs==null&&text.includes('Bench project'))r.timings.sidebarPaintMs=ms
     if(r.timings.firstContentMs==null&&/BENCH_RESULT_\d+|Result \d+/.test(text))r.timings.firstContentMs=ms
     if(r.timings.newestContentMs==null&&/BENCH_RESULT_3000|Result 3000\b/.test(text))r.timings.newestContentMs=ms
     return r.timings.sidebarPaintMs!=null&&r.timings.firstContentMs!=null&&r.timings.newestContentMs!=null
    },'Packaged saved-thread startup never painted',45000)
    await until(async()=>t.submissions.length>=3,'No continued native startup submissions',2000)
    if(t.submissions.length<3)throw Error('Discard: zero/near-zero native submissions; display may be asleep')
    assertDisplayReady()
    r.host='GPUIX packaged app (stdio wrapper)';r.frames=t.result({frames:0,costs:0,commits:0}).frames;r.evidence={executable,wrapper:'Bun wrapper passes stdio directly to the compiled bundle; wrapper launch overhead is included.',cold:'fresh daemon projection cache and app process; OS filesystem cache is not purged'}
   }catch(error){r.status='failed';r.reason=String(error)}finally{await f?.close();const gate=buildWatch.finish();Object.assign(r.evidence,gate);if(gate.overlap||gate.orphanOverlap||gate.screenInvalid){r.status='discarded';r.reason=gate.screenInvalid?'locked/asleep screen: discarded':gate.orphanOverlap?'foreign GPUIX process: discarded':'build overlap: discarded'}}
   rows.push(r)
  }
  return rows
 }
 const startup=name.startsWith('startup-'),pr=name.startsWith('pr-'),proxy=pr?actionFixture({long:true}):null
 const results:Result[]=[]
 let launch:Launch|undefined
 const unregister=onExit(async()=>{await launch?.close();proxy?.close()})
 let telemetry=new Telemetry()
 const client=path.join(fixture.data,'client',name)
 let controlPort=0
 let useAppkit=false,clockOffset=0,clockMappingRttMs=0
 let inputPreflight:unknown=null
 const nativeDrive=async(point:Point,ms:number,fling:boolean)=>{const res=await fetch(`http://127.0.0.1:${controlPort}`,{method:'POST',body:JSON.stringify({action:'wheel-drive',...point,durationMs:ms,fling})});if(!res.ok)throw Error(await res.text());const data=await res.json() as Awaited<ReturnType<typeof drive>> & {accepted:number;zeroDistancePackets:number;requestedDistance:number;effectiveDistance:number;handledPackets:number;handlerDistance:number};data.sent=data.sent.map(t=>t+clockOffset);if(data.accepted!==data.sent.length)throw Error('AppKit rejected wheel events');return data}
 const inputDrive=(point:Point,ms:number,fling:boolean):Promise<Awaited<ReturnType<typeof drive>> & {zeroDistancePackets?:number;requestedDistance?:number;effectiveDistance?:number;handledPackets?:number;handlerDistance?:number}>=>useAppkit?nativeDrive(point,ms,fling):drive(launch!.app,point,ms,fling)
 const control=async(action:string,args:Record<string,unknown>={})=>{
  const res=await fetch(`http://127.0.0.1:${controlPort}`,{method:'POST',body:JSON.stringify({action,...args})});const body=await res.json() as {loaded:boolean;listsLoaded:boolean;blocks:number;firstSeq:number;firstPromptNumber:number;nextBeforeSeq:number|null;streamDeltas:number;error?:string};if(!res.ok)throw Error(body.error);return body
 }
 const restoreStartup=()=>{
  const file=path.join(fixture.data,'gpuix-ui.json')
  const prefs=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{}
  prefs['kybern.split-view.v1']={version:1,root:{kind:'leaf',id:'main',threadId:fixture.manifest.long3000},focusedPaneId:'main'}
  writeFileSync(file,JSON.stringify(prefs))
 }
 const startupPaint=async(app:Launch['app'],at:number)=>{
  let sidebar:number|null=null,first:number|null=null,newest:number|null=null
  await until(async()=>{
   const text=(await app.call('getPaintedText',{})).text.join('\n'),ms=performance.now()-at
   if(sidebar==null&&text.includes('Bench project'))sidebar=ms
   if(first==null&&/BENCH_RESULT_\d+|Result \d+/.test(text))first=ms
   if(newest==null&&/BENCH_RESULT_3000|Result 3000\b/.test(text))newest=ms
   return sidebar!=null&&first!=null&&newest!=null
  },'Saved thread or sidebar never painted',45000)
  return {sidebarPaintMs:sidebar,firstContentMs:first,newestContentMs:newest}
 }
 const start=async(cold=false)=>{
  screenState('app-launch-before')
  if(startup)assertDisplayReady()
  if(cold)rmSync(client,{recursive:true,force:true});mkdirSync(client,{recursive:true});rmSync(path.join(client,'bench-control.json'),{force:true})
  if(startup)restoreStartup()
  // This scratch fixture persists its window frame across scenarios. Drop only
  // that coordinate before launch so AppKit centers every automated window on
  // the built-in display; never move or activate a window after it opens.
  const uiFile=path.join(fixture.data,'gpuix-ui.json')
  if(existsSync(uiFile)){
   const ui=JSON.parse(readFileSync(uiFile,'utf8')) as Record<string,unknown>
   if('kybern.window.frame' in ui){delete ui['kybern.window.frame'];writeFileSync(uiFile,JSON.stringify(ui))}
  }
  telemetry=new Telemetry()
  requireScreen()
  const at=performance.now()
  launch=await launchFixture(path.join(import.meta.dir,'app.ts'),{...fixture.env,...proxy?.env,KYBERN_BENCH_WHEEL_LIBRARY:path.join(fixture.data,'bench-wheel.dylib'),KYBERN_CLIENT_CONFIG_DIR:client,KYBERN_GPUIX_CREDENTIALS_DIR:path.join(client,'credentials'),KYBERN_GPUIX_THREAD:'',KYBERN_GPUIX_ENVIRONMENT:'local',KYBERN_PACING_BASELINE:'0',KYBERN_PACING_RUNNING_ENTRY:'0',GPUIX_BACKGROUND:'1',KYBERN_APPEARANCE:'dark',KYBERN_REDUCED_MOTION:'0',KYBERN_FULL_RATE:process.env.KYBERN_FULL_RATE??'1',KYBERN_FRAME_TIMES:'1',KYBERN_FRAME_COSTS:'1',KYBERN_PACING_IGNORE_PHYSICAL_MOUSE:'1',KYBERN_PACING_PARENT_LEASE:path.resolve(root,'../..')},{stderr:telemetry.stderr})
  await bounds(launch.app,'app-ready')
  await waitForWindowOnscreen(launch.pid)
  const shell=performance.now()-at
  const content=startup?await startupPaint(launch.app,at):null
  await until(async()=>existsSync(path.join(client,'bench-control.json')),'Missing benchmark control endpoint')
  controlPort=JSON.parse(readFileSync(path.join(client,'bench-control.json'),'utf8')).port
  if(!startup){
   await until(async()=>{const s=await control('state');return s.listsLoaded},'Lists not loaded')
   await painted(launch.app,/Bench project|Kybern fixture|Linked conversation/)
  }
  if(startup)assertDisplayReady()
  return {firstPaintedShellMs:shell,...(content??{firstContentMs:performance.now()-at}),firstNativeSubmissionMs:telemetry.submissions[0]?telemetry.submissions[0].received-at:null}
 }
 try{
 if(startup){
  if(name==='startup-warm'){await start(true);await launch!.close();launch=undefined}
  for(let run=1;run<=runs;run++){
   const buildWatch=watchRun(),r=emptyResult(name,run)
   try{
    if(name==='startup-cold')await fixture.restart()
    r.timings=await start(name==='startup-cold');r.evidence={cold:name==='startup-cold'?'fresh daemon projection cache, fresh app process and app preferences; OS filesystem cache is not purged':'fresh process with preferences and filesystem cache primed',frameSemantics:'native scene submissions during startup; idle gaps are not dropped animation frames'}
    await until(async()=>telemetry.submissions.length>=3,'No continued native startup submissions',2000)
    if(telemetry.submissions.length<3)throw Error('Discard: zero/near-zero native submissions; display may be asleep')
    const m=telemetry.result({frames:0,costs:0,commits:0});r.frames=m.frames;r.work=m.work
   }catch(error){r.status='failed';r.reason=String(error)}finally{
    const gate=buildWatch.finish();Object.assign(r.evidence,gate);if(gate.overlap||gate.orphanOverlap||gate.screenInvalid){r.status='discarded';r.reason=gate.screenInvalid?'locked/asleep screen: discarded':gate.orphanOverlap?'foreign GPUIX process: discarded':'build overlap: discarded'}
    results.push(r);writeFileSync(path.join(evidence,`${name}-${run}.log`),telemetry.raw);await launch?.close();launch=undefined
   }
  }
  return results
 }
 await start(true)
 if(process.env.KYBERN_BENCH_NO_RUNNING==='1')await control('idle')
 const app=launch!.app
 let point:Point|undefined
 const setup=async()=>{
  if(pr){await click(app,'rail-pulls');await click(app,'pr-row-108');if(name==='pr-changes'){await click(app,'pr-tab-changes');await bounds(app,'pr-native-diff')}else await bounds(app,'pr-summary')
   const b=await bounds(app,name==='pr-changes'?'pr-native-diff':'page-pulls');point={x:name==='pr-changes'?b.x+b.width/2:b.x+352+(b.width-352)/2,y:b.y+b.height/2};return
  }
  if(name==='idle-home'||name==='sidebar-scroll'){await control('home');if(name==='sidebar-scroll')point={x:180,y:430};return}
  await control('open',{thread:name==='streaming'?(process.env.KYBERN_BENCH_STREAM_HISTORY==='1'?fixture.manifest.long1000:fixture.manifest.running):fixture.manifest.long3000})
  if((name==='streaming'&&process.env.KYBERN_BENCH_STREAM_HISTORY==='1')||(name==='thread-fling'&&process.env.KYBERN_BENCH_HISTORY_TURNS))await control('load-history')
  await bounds(app,'transcript-surface');await painted(app,/BENCH_RESULT|Bench prompt/)
  if(['explorer-scroll','markdown-scroll','code-scroll'].includes(name)){
   await control('explorer',{...(name==='markdown-scroll'?{file:fixture.manifest.markdown}:name==='code-scroll'?{file:fixture.manifest.code}:{})})
   if(name==='explorer-scroll'){await bounds(app,'dock-file-tree-focus');await click(app,'dock-file-expanded');await painted(app,/row-00000/);const b=await bounds(app,'right-dock');point={x:b.x+100,y:b.y+b.height/2}}
   else {await bounds(app,name==='code-scroll'?'dock-file-horizontal':'dock-file-content');await painted(app,name==='markdown-scroll'?/Result 1|BENCH_RESULT_1/:/item0|item64/);const b=await bounds(app,'right-dock');point={x:b.x+b.width-90,y:b.y+b.height/2}}
  }else{const b=await bounds(app,'transcript-surface');point={x:b.x+b.width/2,y:b.y+b.height*.45}}
 }
 await delay(1500)
 await setup()
 if(name.startsWith('idle-'))await control('idle')
 const streamWithWheel=name==='streaming'&&process.env.KYBERN_BENCH_STREAM_SCROLL==='1'
 const scrolling=name.endsWith('scroll')||name==='thread-fling'||pr||streamWithWheel
 if(point&&scrolling){
  const request=async(action:string,args:Record<string,unknown>={})=>{const res=await fetch(`http://127.0.0.1:${controlPort}`,{method:'POST',body:JSON.stringify({action,...args})});return await res.json() as {accepted:number;now:number;offset:number[]|null}}
  const target=name==='sidebar-scroll'?'thread-list':name==='explorer-scroll'?'dock-file-tree':name==='markdown-scroll'||name==='code-scroll'?'dock-file-content':name==='pr-summary'?'pr-summary':name==='pr-changes'?'pr-native-diff':'transcript'
  const prior=await request('scroll-state',{target}),before=performance.now()
  const probe=await request('wheel-probe',{...point,delta:-180});clockOffset=(before+performance.now())/2-probe.now
  await delay(100)
  let changed=await request('scroll-state',{target})
  if(JSON.stringify(changed.offset)===JSON.stringify(prior.offset)){await request('wheel-probe',{...point,delta:180});await delay(100);changed=await request('scroll-state',{target})}
  useAppkit=probe.accepted===1&&prior.offset!==null&&JSON.stringify(changed.offset)!==JSON.stringify(prior.offset)&&process.env.KYBERN_BENCH_RPC_ONLY!=='1'
  inputPreflight={target,point,prior,probe,changed};
  const mapStart=performance.now(),clock=await request('state');clockMappingRttMs=performance.now()-mapStart;clockOffset=mapStart+clockMappingRttMs/2-clock.now
 }
 if(name==='streaming'){await control('stream',{durationMs:options.warmup*1000+runs*(options.seconds+5)*1000+3000});await painted(app,/Streaming paragraph/)}
 if(name.startsWith('idle-')){await app.call('blur',{});await app.mouse.move({x:900,y:4})}else if(point)await app.mouse.move(point)
 if(scrolling)await inputDrive(point!,options.warmup*1000,name==='thread-fling');else await delay(options.warmup*1000)
 if(name.startsWith('idle-')){await app.call('blur',{});await delay(500)}
 for(let run=1;run<=runs;run++){
  const r=emptyResult(name,run)
  let buildWatch:ReturnType<typeof watchRun>|undefined
  const children: {kill:()=>unknown;exited:Promise<number>}[]=[]
  const unregisterChildren:(()=>void)[]=[]
  try{
   if(name==='open-long')await control('home')
   if(name==='older-history'){await control('home');await control('open',{thread:fixture.manifest.long3000});await bounds(app,'transcript-surface')}
   // The steady state warms once, then three consecutive independent 15 s
   // endpoint samples. Cold/open timings remain separate from resource windows.
   const streamBefore=name==='streaming'?(await control('state')).streamDeltas:null
   r.evidence.windowBefore=requireWindowOnscreen(launch!.pid).windows
   buildWatch=watchRun()
   const mark=telemetry.mark(),timed=performance.now()
   telemetry.raw+=`[bench-window-start] run=${run} native=${telemetry.submissions.at(-1)?.native??0} js=${timed}\n`
   if(name==='open-long'){
    const opened=control('open',{thread:fixture.manifest.long3000})
    await bounds(app,'transcript-surface');await painted(app,/BENCH_RESULT|Bench prompt/);r.timings.firstVisibleMessageMs=performance.now()-timed
    await opened;let snapshot='',stableAt=performance.now();await until(async()=>{const text=(await app.call('getPaintedText',{})).text.join('\n');if(text!==snapshot){snapshot=text;stableAt=performance.now()}return performance.now()-stableAt>=250},'Thread painted text did not settle',10000);r.timings.settledMs=performance.now()-timed;r.evidence.settledDefinition='loaded state plus 250 ms unchanged painted text; no async native parser completion fence'
   }
   if(name==='older-history'){
    const before=await control('state');r.evidence.firstSeqBefore=before.firstSeq
    // Real native upward wheel fling, until paging brings a lower sequence.
    const b=await bounds(app,'transcript-surface'),p={x:b.x+b.width/2,y:b.y+100}
    let after=before
    for(let n=0;n<25&&after.firstSeq>=before.firstSeq;n++){await app.call('scrollWheel',{...p,deltaX:0,deltaY:12000,phase:n===0?'started':'moved'});await delay(30);after=await control('state')}
    await app.call('scrollWheel',{...p,deltaX:0,deltaY:0,phase:'ended'})
    await until(async()=>{after=await control('state');return after.firstSeq<before.firstSeq},'Earlier history did not arrive',15000)
    await app.call('scrollWheel',{...p,deltaX:0,deltaY:1200,phase:'started'})
    await app.call('scrollWheel',{...p,deltaX:0,deltaY:0,phase:'ended'})
    await until(async()=>{const text=(await app.call('getPaintedText',{})).text.join('\n');const numbers=[...text.matchAll(/(?:Bench prompt |BENCH_RESULT_)(\d+)/g)].map(m=>Number(m[1]));return numbers.some(n=>n<before.firstPromptNumber)},'An older page arrived but no newly older turn was painted',10000)
    r.evidence.olderTurnPainted=true
    r.timings.olderHistoryVisibleMs=performance.now()-timed;r.evidence.firstSeqAfter=after.firstSeq;r.evidence.olderBlocks=after.blocks-before.blocks
   }
   const sampler=Bun.spawn(['bun',path.join(root,'perf/sample.ts'),String(options.seconds),`GPUIX=${launch!.pid}`],{stdout:'pipe',stderr:'pipe'})
   children.push(sampler)
   const unsampler=onExit(async()=>{sampler.kill();await sampler.exited})
   unregisterChildren.push(unsampler)
   const resourceStart=performance.now()
   const sampleTextPromise=new Response(sampler.stdout).text(),sampleErrorPromise=new Response(sampler.stderr).text()
   const resourceMark=telemetry.mark()
   const profiler=options.profile?Bun.spawn(['sample',String(launch!.pid),'5','-file',path.join(evidence,`profile-${name}-${run}.txt`)],{stdout:'ignore',stderr:'ignore'}):undefined
   if(profiler)children.push(profiler)
   const unprofiler=profiler?onExit(async()=>{profiler.kill();await profiler.exited}):()=>{}
   unregisterChildren.push(unprofiler)
   const input=scrolling?await inputDrive(point!,options.seconds*1000,name==='thread-fling'):undefined
   if(!scrolling)await delay(options.seconds*1000)
   r.evidence.windowAfter=requireWindowOnscreen(launch!.pid).windows
   const measured=telemetry.result(resourceMark,input?.sent,scrolling)
   telemetry.raw+=`[bench-window-end] run=${run} native=${telemetry.submissions.at(-1)?.native??0} js=${performance.now()}\n`
   const sampleText=await sampleTextPromise,sampleError=await sampleErrorPromise
   const sampleExit=await sampler.exited;unsampler();if(sampleExit)throw Error(sampleError)
   await profiler?.exited;unprofiler()
   const stop=performance.now(),m=measured
   r.resources=parseResources(sampleText);if(useAppkit)r.latency.kind='in-process scheduled AppKit NSEvent to next scene-submission stderr receipt; clocks mapped from control RTT; not a physical presentation fence';r.frames=m.frames;r.work=m.work;r.latency.proxyMs=m.proxy;r.latency.samples=m.latencySamples
   r.timings.resourceWindowMs=stop-resourceStart
   r.evidence={...r.evidence,nativeDispatchToCpuPaint:m.nativeInput,averageProcessCpuMsPerSubmission:r.frames.count?r.resources.cpuPercent!*r.resources.sampleSeconds!*10/r.frames.count:null,averageProcessGpuMsPerSubmission:r.frames.count?r.resources.gpuMs!/r.frames.count:null,inputPreflight,loadedHistoryTurns:name==='thread-fling'&&process.env.KYBERN_BENCH_HISTORY_TURNS?Number(process.env.KYBERN_BENCH_HISTORY_TURNS):null,profiled:!!options.profile,warmupSeconds:options.warmup,resourceWindowSeconds:options.seconds,resourceText:sampleText,input:input?.input??'none',packetAckP95:input?input.acks.sort((a,b)=>a-b)[Math.floor(input.acks.length*.95)]:null,maxOutstanding:input?.maxOutstanding??0,drainMs:input?.drainMs??0,sceneTransitionFrames:telemetry.submissions.length-mark.frames,onePersistedRunningThread:!name.startsWith('idle-')&&process.env.KYBERN_BENCH_NO_RUNNING!=='1',appkitAccepted:useAppkit,forcedRpc:process.env.KYBERN_BENCH_RPC_ONLY==='1',clockMappingRttMs,offeredPackets:input?.sent.length??0,inputProductionMs:input?.productionMs??null,...(input&&'zeroDistancePackets' in input?{zeroDistancePackets:input.zeroDistancePackets,requestedDistance:input.requestedDistance,effectiveDistance:input.effectiveDistance,handledPackets:input.handledPackets,handlerDistance:input.handlerDistance}:{}),offeredPacketsPerNominalSecond:input?input.sent.length/options.seconds:null,offeredPacketsPerSecond:input&&input.productionMs>0?input.sent.length/(input.productionMs/1000):null}
   if(scrolling||name==='streaming')requireActiveSample(r.frames.count,r.resources.gpuMs,options.seconds)
   if(streamBefore!=null){const streamed=await control('state');const streamAfter=streamed.streamDeltas;r.evidence.offeredDeltas=streamAfter-streamBefore;r.evidence.offeredDeltasPerSecond=(streamAfter-streamBefore)/(r.timings.resourceWindowMs!/1000);r.evidence.streamWithWheel=streamWithWheel;r.evidence.loadedBlocks=streamed.blocks;r.evidence.fullHistory=process.env.KYBERN_BENCH_STREAM_HISTORY==='1'}
   if(process.env.KYBERN_BENCH_COUNTERS==='1'){const response=await fetch(`http://127.0.0.1:${controlPort}`,{method:'POST',body:JSON.stringify({action:'counters'})});r.evidence.counters=await response.json()}
   writeFileSync(path.join(evidence,`${name}-${run}-resources.txt`),sampleText)
  }catch(error){r.status=String(error).includes('not onscreen on the built-in display')?'discarded':'failed';r.reason=String(error)}finally{for(const child of children){child.kill();await child.exited}for(const unregister of unregisterChildren)unregister()}
  if(buildWatch){const gate=buildWatch.finish();Object.assign(r.evidence,gate);if(gate.overlap||gate.orphanOverlap||gate.screenInvalid){r.status='discarded';r.reason=gate.screenInvalid?'locked/asleep screen: discarded':gate.orphanOverlap?'foreign GPUIX process: discarded':'build overlap: discarded'}}
  writeFileSync(path.join(evidence,`${name}-${run}.log`),telemetry.raw)
  results.push(r)
 }
 }catch(error){writeFileSync(path.join(evidence,`${name}-setup-failed.log`),telemetry.raw);for(let run=results.length+1;run<=runs;run++)results.push({...emptyResult(name,run),status:'failed',reason:String(error)})}
 finally{unregister();await launch?.close();proxy?.close();screenState('app-launch-after')}
 return results
}
