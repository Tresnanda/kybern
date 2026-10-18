import { spawn } from 'node:child_process'
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { connectStdio } from '@gpuix/react/automation'
import { createHash } from 'node:crypto'
import { assertScratchEnv } from '../../src/requests/harness.ts'
if(process.argv[2]==='mounts' && !process.env.TRANSCRIPT_PAIR){await import('./pair.ts');process.exit(0)}
const label=process.argv[2]??'baseline',count=Number(process.argv[3]??1000),theme=process.argv[4]??'dark'
const out='/Users/mymac/projects/ade/previews/gpuix/perf/transcript';mkdirSync(out,{recursive:true})
const data='/Users/mymac/projects/ade-gpuix-scratch/perf-transcript';mkdirSync(data,{recursive:true})
const env={...process.env,TRANSCRIPT_BASELINE:label.startsWith('baseline')?'1':'0',TRANSCRIPT_TURNS:String(count),KYBERN_DATA_DIR:data,KYBERN_CLIENT_CONFIG_DIR:data,KYBERN_URL:'',KYBERN_TOKEN:'',GPUIX_BACKGROUND:'1',KYBERN_OPAQUE:'1',KYBERN_APPEARANCE:theme,KYBERN_FULL_RATE:'1',KYBERN_FRAME_TIMES:'1',KYBERN_FRAME_COSTS:'1'};assertScratchEnv(env)
const buildMarkers=()=>readdirSync('/tmp').filter(name=>name.startsWith('kybern-gpuix-native-build.'))
const processChecks: {stage:string;processes:string}[]=[]
function checkProcesses(stage:string, ownPid?:number) {
 const probe=Bun.spawnSync(['pgrep','-fl','bun .*ade-gpuix'])
 const processes=probe.stdout.toString().trim()
 processChecks.push({stage,processes})
 const foreign=processes.split('\n').filter(line=>line && Number(line.split(' ')[0])!==ownPid && /\/(?:app|entry|main|[^ /]*(?:fixture|lab))\.tsx?(?:\s|$)/.test(line))
 if(foreign.length)throw Error(`Foreign GPUIX app/fixture/lab at ${stage}; discard and repeat: ${foreign.join('; ')}`)
}
if(buildMarkers().length)throw Error('Native build active before timing; discard and rerun after build')
checkProcesses('before launch')
const controlFile=data+'/transcript-control.json';rmSync(controlFile,{force:true})
const child=spawn('bun',[import.meta.dir+'/entry.ts'],{env,stdio:['pipe','pipe','pipe']})
const frames:{native:number;received:number}[]=[],costs:{render:number;layout:number}[]=[],reactRenders:number[]=[],inputPaints:{packets:number;firstMs:number;lastMs:number}[]=[]
let raw='',remainder=''
child.stderr.on('data',c=>{raw+=String(c);const lines=(remainder+String(c)).split('\n');remainder=lines.pop()??'';for(const line of lines){const f=line.match(/\[kybern-submit\] ([\d.]+)/);if(f)frames.push({native:Number(f[1]),received:performance.now()});const c=line.match(/\[kybern-work\] renderMs=([\d.]+) layoutMs=([\d.]+)/);if(c)costs.push({render:Number(c[1]),layout:Number(c[2])});const react=line.match(/\[transcript-render\].*actualMs=([\d.]+)/);if(react)reactRenders.push(Number(react[1]));const paint=line.match(/\[scroll-input-paint\] packets=(\d+) firstMs=([\d.]+) lastMs=([\d.]+)/);if(paint)inputPaints.push({packets:Number(paint[1]),firstMs:Number(paint[2]),lastMs:Number(paint[3])})}})
const p=(v:number[],f:number)=>v.sort((a,b)=>a-b)[Math.min(v.length-1,Math.floor(v.length*f))]??null
const observedBuilds=new Set<string>()
const buildWatch=setInterval(()=>{for(const marker of buildMarkers())observedBuilds.add(marker)},250)
const addonPath=process.env.NAPI_RS_NATIVE_LIBRARY_PATH??import.meta.dir+'/../../native/build/gpuix-native.darwin-arm64.node'
const addonHash=existsSync(addonPath)?createHash('sha256').update(readFileSync(addonPath)).digest('hex'):null
const fixtureHash=createHash('sha256').update(readFileSync(import.meta.dir+'/fixture.tsx')).digest('hex')
const wheelPath=data+'/transcript-wheel.dylib',wheelHash=process.env.TRANSCRIPT_INPUT==='appkit'&&existsSync(wheelPath)?createHash('sha256').update(readFileSync(wheelPath)).digest('hex'):null
const startedAt=new Date().toISOString()
const started=performance.now()
let app:Awaited<ReturnType<typeof connectStdio>>|undefined
try{
 app=await Promise.race([connectStdio({write:v=>{child.stdin.write(v)},feed:l=>child.stdout.on('data',c=>l(String(c))),close:async()=>{child.kill()}}),new Promise<never>((_,reject)=>{child.on('exit',c=>reject(Error(`Exit ${c}: ${raw.slice(-2000)}`)));setTimeout(()=>reject(Error('Startup timeout: '+raw.slice(-2000))),120000).unref()})])
 let port=0
 for(let i=0;i<6000;i++){if(existsSync(controlFile)){const c=JSON.parse(readFileSync(controlFile,'utf8'));if(c.pid===child.pid){port=c.port;break}}await Bun.sleep(20)}
 if(!port)throw Error('No benchmark control endpoint')
 const control=async()=>{const response=await fetch(`http://127.0.0.1:${port}`,{method:'POST',body:JSON.stringify({action:'state'})});return response.json() as Promise<{bounds?:{x:number;y:number;width:number;height:number}}>}
 let b: {x:number;y:number;width:number;height:number}|undefined
 for(let i=0;i<6000;i++){try{const state=await control();if(state.bounds?.width&&state.bounds.height){b=state.bounds;break}}catch{}await Bun.sleep(20)}
 if(!b)throw Error('No painted transcript viewport')
 const point={x:b.x+b.width/2,y:b.y+b.height/2}
 let painted=false;for(let i=0;i<200;i++){if((await app.call('getPaintedText',{})).text.join('\n').match(/Prompt |BENCH_RESULT_|Stable syntax|Word |Live /)){painted=true;break}await Bun.sleep(20)}if(!painted){writeFileSync(`${out}/${label}-${count}-${theme}-unpainted.json`,JSON.stringify(await app.call('getPaintedText',{})));await app.screenshot({path:`${out}/${label}-${count}-${theme}-unpainted.png`});throw Error('Transcript has no formatted visible content')}
 const firstVisibleMs=performance.now()-started
 const sharedInput=existsSync(import.meta.dir+'/../bench/input.ts')?import.meta.dir+'/../bench/input.ts':'/Users/mymac/projects/ade-gpuix-perf-bench/apps/gpuix/perf/bench/input.ts'
 const inputHash=createHash('sha256').update(readFileSync(sharedInput)).digest('hex')
 const {drive:sharedDrive}=await import(sharedInput)
 async function drive(ms:number,fling=false){
  if(process.env.TRANSCRIPT_INPUT==='appkit'){
   const result=await (await fetch(`http://127.0.0.1:${port}`,{method:'POST',body:JSON.stringify({action:'wheel-drive',durationMs:ms,fling,allPackets:process.env.TRANSCRIPT_MATCHED==='1',...point})})).json() as {sent:number[];accepted:number;productionMs:number;input:string}
   return {offeredPackets:result.sent.length,accepted:result.accepted,fixedSequence:process.env.TRANSCRIPT_MATCHED==='1',maxOutstanding:0,productionMs:result.productionMs,ackP95:null,drainMs:0,input:result.input,inputHash:createHash('sha256').update(readFileSync(import.meta.dir+'/appkit.ts')).digest('hex')}
  }
  const result=await sharedDrive(app!,point,ms,fling);return {offeredPackets:result.sent.length,maxOutstanding:result.maxOutstanding,productionMs:result.productionMs,ackP95:p(result.acks,.95),drainMs:result.drainMs,input:result.input,inputHash}
 }

 if(process.env.TRANSCRIPT_CAPTURE==='1'){await app.screenshot({path:`${out}/${label}-${count}-${theme}.png`});console.log(JSON.stringify({label,count,theme,firstVisibleMs,captured:true}));}
 else{
 await drive(10000)
 await app.mouse.move(point);await control();await Bun.sleep(1000)
 // Accepted NSEvents alone do not prove a live scroll target. Verify native
 // movement after warm-up and normalize both variants to the same destination.
 let preflight:unknown=null
 if(process.env.TRANSCRIPT_PREFLIGHT!=='0'){
  const where=async(action='where',args:object={})=>(await (await fetch(`http://127.0.0.1:${port}`,{method:'POST',body:JSON.stringify({action,...args})})).json()) as Promise<{anchor:number[]}>
  const before=await where()
  await app.mouse.wheel(point,0,800);await Bun.sleep(100)
  let moved=await where()
  if(JSON.stringify(before.anchor)===JSON.stringify(moved.anchor)){
   await app.mouse.wheel(point,0,-1600);await Bun.sleep(100);moved=await where()
  }
  if(JSON.stringify(before.anchor)===JSON.stringify(moved.anchor))throw Error('Native wheel preflight did not move the logical anchor; reject timing')
  await where('jump',{index:100000000});await Bun.sleep(500)
  preflight={before:before.anchor,moved:moved.anchor,normalized:(await where()).anchor}
  console.log('INPUT PREFLIGHT '+JSON.stringify(preflight))
 }
 const results=[]
 for(const scenario of (process.env.TRANSCRIPT_SCENES??'scroll,fling,idle').split(',')){
 if(scenario==='idle')await Bun.sleep(10000)
 checkProcesses(`before ${scenario}`,child.pid)
 const first=frames.length,c0=costs.length,react0=reactRenders.length,input0=inputPaints.length
 const sample=Bun.spawn(['bun',import.meta.dir+'/../sample.ts','15',`GPUIX=${child.pid}`],{stdout:'pipe',stderr:'pipe'})
 const profile=scenario==='scroll'?Bun.spawn(['sample',String(child.pid),'5','-file',`${out}/${label}-${count}-${theme}-sample.txt`],{stdout:'ignore',stderr:'ignore'}):null
 const input=scenario==='idle'?(await Bun.sleep(15000),null):await drive(15000,scenario==='fling')
 const resource=await new Response(sample.stdout).text();await sample.exited;await profile?.exited
 const fs=frames.slice(first),intervals=fs.slice(1).map((f,i)=>f.native-fs[i]!.native),work=costs.slice(c0)
 if(scenario!=='idle'&&!work.length&&!fs.length)throw Error('Active input produced no native render work; reject timing')
 const markersAfter=buildMarkers();if(markersAfter.length||observedBuilds.size)throw Error(`Native build overlapped timing; discard and repeat: ${[...observedBuilds,...markersAfter].join(', ')}`)
 checkProcesses(`after ${scenario}`,child.pid)
 const applied=inputPaints.slice(input0)
 const formattedOutput=(await app.call('getPaintedText',{})).text.join('\n');if(!/Prompt |BENCH_RESULT_|Stable syntax|Word |Live |Result |reading position|Paint/.test(formattedOutput))throw Error('Scroll ended without formatted transcript content')
 const r={preflight,formattedOutput:true,scenario,count,theme,fullRate:1,startedAt,addonHash,fixtureHash,wheelHash,nativeFirstInputToCpuPaintP95:p(applied.map(v=>v.firstMs),.95),nativeLastInputToCpuPaintP95:p(applied.map(v=>v.lastMs),.95),mergedPacketsMax:Math.max(0,...applied.map(v=>v.packets)),config:{buffer:process.env.KYBERN_TRANSCRIPT_WINDOW_BUFFER??'1',slotCache:process.env.KYBERN_TRANSCRIPT_SLOT_CACHE??'1',window:!label.startsWith('baseline')&&process.env.KYBERN_TRANSCRIPT_WINDOW!=='0',layout:process.env.KYBERN_TRANSCRIPT_LAYOUT??'1',islands:process.env.KYBERN_SCROLL_ISLANDS??'0',coalesce:process.env.KYBERN_SCROLL_COALESCE??'pr',inputFrameDraw:process.env.KYBERN_INPUT_FRAME_DRAW??'0'},firstVisibleMs,frames:fs.length,p50:p([...intervals],.5),p95:p([...intervals],.95),p99:p([...intervals],.99),over16_7:intervals.filter(v=>v>16.7).length,over33:intervals.filter(v=>v>33).length,reactCommits:reactRenders.length-react0,reactRenderP95:p(reactRenders.slice(react0),.95),renderP95:p(work.map(v=>v.render),.95),layoutP95:p(work.map(v=>v.layout),.95),input,resource};results.push(r);console.log(JSON.stringify(r))
 }
 writeFileSync(`${out}/${label}-${count}-${theme}.json`,JSON.stringify(results,null,2))
 }
}finally{
 clearInterval(buildWatch)
 writeFileSync(`${out}/${label}-${count}-${theme}.log`,raw)
 writeFileSync(`${out}/${label}-${count}-${theme}-processes.json`,JSON.stringify(processChecks,null,2))
 const exited=new Promise<void>(resolve=>{if(child.exitCode!==null||child.signalCode!==null)resolve();else child.once('exit',()=>resolve())})
 await app?.close().catch(()=>{})
 child.kill()
 const kill=setTimeout(()=>child.kill('SIGKILL'),2000)
 await exited
 clearTimeout(kill)
}
