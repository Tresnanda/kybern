// Actual desktop frontend in Playwright WebKit; not the native Tauri shell.
import path from 'node:path'
import {quietOrder} from './build-overlap.ts'
import {processInventory} from './process-gate.ts'
import {createRequire} from 'node:module'
import {execFileSync,spawn} from 'node:child_process'
import {readFileSync,writeFileSync,readdirSync,watch} from 'node:fs'
const require=createRequire(path.resolve(import.meta.dirname,'../../../desktop/package.json'))
const {createServer}=await import(require.resolve('vite'))
const {webkit}=await import(process.env.PLAYWRIGHT_CORE??'/Users/mymac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs')
const [name,runsArg,secondsArg,warmupArg,out]=process.argv.slice(2),runs=Number(runsArg),seconds=Number(secondsArg),warmup=Number(warmupArg)
const manifest=JSON.parse(readFileSync(path.join(process.env.KYBERN_DATA_DIR,'bench-manifest.json'),'utf8'))
const desktop=path.resolve(import.meta.dirname,'../../../desktop')
const server=await createServer({root:desktop,configFile:path.join(desktop,'vite.config.ts'),server:{host:'127.0.0.1',port:0}});await server.listen()
const table=()=>execFileSync('ps',['-Ao','pid=,ppid=,comm='],{encoding:'utf8'}).trim().split('\n').map(l=>{const m=l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);return [Number(m[1]),Number(m[2]),m[3]]})
const old=new Set(table().map(p=>p[0])),webkitRoot=path.dirname(webkit.executablePath()),browser=await webkit.launch()
const percentile=(v,f)=>{const a=[...v].sort((a,b)=>a-b);return a[Math.min(a.length-1,Math.floor(a.length*f))]??null}
const dist=v=>({p50:percentile(v,.5),p95:percentile(v,.95),p99:percentile(v,.99),max:v.length?Math.max(...v):null})
const markers=()=>readdirSync('/tmp').filter(name=>name.startsWith('kybern-gpuix-native-build.')).sort()
const quiet=()=>readdirSync('/tmp').filter(name=>name.startsWith('kybern-gpuix-quiet.')).sort()
const results=[]
const blank=run=>({scenario:name,run,host:'desktop frontend in WebKit',status:'ok',fullRate:process.env.KYBERN_FULL_RATE??'1',frames:{...dist([]),count:0,over16_7:0,over33:0},latency:{kind:'DOM wheel event to next requestAnimationFrame; not physical presentation',inputToPresentMs:null,proxyMs:dist([]),samples:0},resources:{cpuPercent:null,gpuMs:null,footprintMiB:null,sampleSeconds:null},timings:{},work:{reactCommits:0,renderMs:dist([]),layoutMs:dist([])},evidence:{browserVersion:browser.version(),browserExecutable:webkit.executablePath()}})
const auth=process.env.KYBERN_TOKEN||readFileSync(path.join(process.env.KYBERN_DATA_DIR,'daemon.token'),'utf8').trim()
const url=process.env.KYBERN_URL||`ws://127.0.0.1:${readFileSync(path.join(process.env.KYBERN_DATA_DIR,'daemon.port'),'utf8').trim()}/ws`
const safeError=e=>String(e).replaceAll(auth,'[redacted scratch token]').replaceAll(encodeURIComponent(auth),'[redacted scratch token]')
const input=async(page,b,ms,fling=false)=>{
 await page.mouse.move(b.x+b.width/2,b.y+b.height/2)
 const start=performance.now(),pending=new Set();let count=0,maxOutstanding=0
 while(performance.now()-start<ms){
  if(pending.size>=8){await Promise.race(pending);continue}
  const i=Math.floor((performance.now()-start)*120/1000),phase=i%300,cycle=i%600,delta=fling?(phase<20?45:45*Math.exp(-(phase-20)/35)):(phase<120?6*Math.sin(Math.PI*Math.min(phase+1,30)/60):6*Math.exp(-(phase-120)/45))
  const packet=page.mouse.wheel(0,(cycle<300?1:-1)*delta);pending.add(packet);packet.finally(()=>pending.delete(packet));count++;maxOutstanding=Math.max(maxOutstanding,pending.size)
  const due=start+(i+1)*1000/120;if(due>performance.now())await new Promise(r=>setTimeout(r,due-performance.now()))
 }
 const offeredMs=performance.now()-start;await Promise.all(pending);return {offeredMs,drainMs:performance.now()-start-offeredMs,packets:count,maxOutstanding}
}
let page,target,b
const children=new Set()
const scrolling=name.endsWith('scroll')||name==='thread-fling'||name.startsWith('pr-')
const stop=async(code)=>{for(const child of children)child.kill();await browser.close();await server.close();process.exit(code)}
process.once('SIGTERM',()=>void stop(143));process.once('SIGINT',()=>void stop(130))
try{
 if(name==='startup-warm'){
  const primer=await browser.newPage({viewport:{width:1280,height:820},deviceScaleFactor:2,colorScheme:'dark'})
  await primer.goto(`${server.resolvedUrls.local[0]}?url=${encodeURIComponent(url)}&token=${encodeURIComponent(auth)}`)
  await primer.waitForFunction(async()=>{const {useStore}=await import('/src/state/store.ts');return Object.keys(useStore.getState().projects).length>0})
  await primer.close()
 }
 for(let run=1;run<=runs;run++){
  const orderBefore=quietOrder(),processBefore=processInventory(),buildBefore=markers(),seen=new Set(buildBefore),quietBefore=quiet(),r=blank(run)
  const watcher=watch('/tmp',(_event,file)=>{if(String(file).startsWith('kybern-gpuix-native-build.'))seen.add(String(file))})
  try{
   if(!page){
   page=await browser.newPage({viewport:{width:1280,height:820},deviceScaleFactor:2,colorScheme:'dark'})
   await page.addInitScript(()=>{window.__commits=0;window.__REACT_DEVTOOLS_GLOBAL_HOOK__={supportsFiber:true,renderers:new Map(),inject(){return 1},onCommitFiberRoot(){window.__commits++},onCommitFiberUnmount(){},onScheduleFiberRoot(){}}})
   const launch=performance.now()
   await page.goto(`${server.resolvedUrls.local[0]}?url=${encodeURIComponent(url)}&token=${encodeURIComponent(auth)}`)
   await page.getByRole('button',{name:'Pull requests',exact:true}).first().waitFor()
   r.timings.firstPaintedShellMs=performance.now()-launch
   await page.waitForFunction(async()=>{const {useStore}=await import('/src/state/store.ts');return Object.keys(useStore.getState().projects).length>0})
   r.timings.firstContentMs=performance.now()-launch
   if(name.startsWith('startup-')){const buildAfter=markers();r.evidence.quietMarkersBefore=quietBefore;r.evidence.quietMarkersAfter=quiet();r.evidence.buildMarkersBefore=buildBefore;r.evidence.buildMarkersAfter=buildAfter;if(buildBefore.length||buildAfter.length){r.status='discarded';r.reason='build overlap: discarded'};watcher.close();r.evidence.buildMarkersDuring=[...seen];if(seen.size){r.status='discarded';r.reason='build overlap: discarded'};r.evidence.cold='fresh browser page; browser and Vite process reused (not an OS-cache-cold control)';results.push(r);await page.close();page=null;continue}
   target='[data-chat-scroll-container]'
   if(name.startsWith('pr-')){
    await page.getByRole('button',{name:'Pull requests',exact:true}).first().click();await page.locator('[data-pr-row]').first().click()
    if(name==='pr-changes'){await page.getByRole('tab',{name:/^Changes/}).click();await page.locator('[data-pr-diff]').waitFor()}else await page.locator('.pr-summary-body').waitFor()
    target='[data-pr-scroll]'
   }else if(name==='sidebar-scroll'){target='[data-sidebar-scroll]';if(!await page.locator(target).count())target='aside .overflow-y-auto'}
   else if(name!=='idle-home'){
    const at=performance.now()
    await page.evaluate(async({id})=>{const {useStore}=await import('/src/state/store.ts');const {loadThread}=await import('/src/state/rpc.ts');useStore.getState().selectThread(id);await loadThread(id)}, {id:manifest.long3000})
    await page.locator('[data-message-role]').first().waitFor();r.timings.firstVisibleMessageMs=performance.now()-at
    if(name==='markdown-scroll'||name==='code-scroll'){
     await page.evaluate(async({projectId,file})=>{const {useStore}=await import('/src/state/store.ts');const s=useStore.getState();s.set({rightOpen:true,rightTabs:['explorer'],rightTab:'explorer',explorerFile:{...s.explorerFile,[projectId]:file}})}, {projectId:manifest.projects[0],file:name==='markdown-scroll'?'long.md':'long.ts'})
     await page.getByText(name==='markdown-scroll'?'long.md':'long.ts',{exact:true}).first().waitFor()
     target=name==='markdown-scroll'?'div.overflow-auto:has(> div > .chat-markdown)':'.editor-file-viewer'
     await page.locator(target).first().waitFor({state:'visible'})
     if(name==='markdown-scroll')await page.locator(`${target} strong`).first().waitFor()
    }
   }
   b=scrolling?await page.locator(target).first().boundingBox():null
   if(scrolling&&!b)throw Error(`No scroll target ${target}`)
   if(scrolling)await input(page,b,warmup*1000,name==='thread-fling');else await new Promise(r=>setTimeout(r,warmup*1000))
   await page.evaluate(()=>{if(document.activeElement instanceof HTMLElement)document.activeElement.blur()})
   } // Warm once, then keep the same scene for consecutive endpoint windows.
   if(name==='open-long'&&run>1){
    await page.evaluate(async()=>{const {useStore}=await import('/src/state/store.ts');useStore.getState().selectThread(null)})
    await page.locator('[data-message-role]').first().waitFor({state:'detached'})
    const at=performance.now();await page.evaluate(async(id)=>{const {useStore}=await import('/src/state/store.ts');const {loadThread}=await import('/src/state/rpc.ts');useStore.getState().selectThread(id);await loadThread(id)},manifest.long3000)
    await page.locator('[data-message-role]').first().waitFor();r.timings.firstVisibleMessageMs=performance.now()-at
   }
   // Include XPC services adopted by launchd, as scroll8-webkit.mjs does.
   const processes=table(),owned=new Set([process.pid]);let more=true
   while(more){more=false;for(const[pid,parent]of processes)if(owned.has(parent)&&!owned.has(pid)){owned.add(pid);more=true}}
   const pids=processes.filter(([pid,,command])=>{
    if(!/WebKit|MiniBrowser|Playwright|WebProcess|NetworkProcess|GPUProcess/.test(command))return false
    if(owned.has(pid))return true;if(old.has(pid))return false;if(command.includes(webkitRoot))return true
    try{return execFileSync('lsof',['-a','-p',String(pid),'-d','txt','-Fn'],{encoding:'utf8'}).includes(webkitRoot)}catch{return false}
   }).map(([pid])=>pid)
   if(pids.length<2)throw Error('Incomplete WebKit process coalition')
   const resourceBuildBefore=markers(),resourceQuietBefore=quiet()
   const sampler=spawn('bun',[path.resolve(import.meta.dirname,'../sample.ts'),String(seconds),`WebKit=${pids.join(',')}`],{stdio:['ignore','pipe','pipe']})
   children.add(sampler)
   let raw='',error='';sampler.stdout.on('data',v=>raw+=v);sampler.stderr.on('data',v=>error+=v)
   const done=new Promise((resolve,reject)=>sampler.once('exit',code=>{children.delete(sampler);code?reject(Error(error)):resolve()}))
   await page.evaluate(()=>{
    const m=window.__bench={times:[],latencies:[],active:true,commits:window.__commits,pending:null}
    m.wheel=()=>{m.pending??=performance.now()};window.addEventListener('wheel',m.wheel,{passive:true})
    const frame=now=>{if(!m.active)return;m.times.push(now);if(m.pending!=null){m.latencies.push(now-m.pending);m.pending=null}requestAnimationFrame(frame)};requestAnimationFrame(frame)
   })
   if(scrolling)r.evidence.input=await input(page,b,seconds*1000,name==='thread-fling');else await new Promise(r=>setTimeout(r,seconds*1000))
   const metrics=await page.evaluate(()=>{const m=window.__bench;m.active=false;window.removeEventListener('wheel',m.wheel);return {times:m.times,latencies:m.latencies,commits:window.__commits-m.commits}})
   await done
   const buildAfter=markers();r.evidence.quietMarkersBefore=resourceQuietBefore;r.evidence.quietMarkersAfter=quiet();r.evidence.buildMarkersBefore=resourceBuildBefore;r.evidence.buildMarkersAfter=buildAfter;if(resourceBuildBefore.length||buildAfter.length){r.status='discarded';r.reason='build overlap: discarded'}
   const match=raw.match(/total\s+([\d.]+) MiB\s+cpu\s+([\d.]+)%\s+gpu\s+([\d.-]+) ms over ([\d.]+)s/);if(!match)throw Error(`Invalid sample ${raw}`)
   r.resources={footprintMiB:Number(match[1]),cpuPercent:Number(match[2]),gpuMs:Number(match[3]),sampleSeconds:Number(match[4])}
   const intervals=metrics.times.slice(1).map((t,i)=>t-metrics.times[i]);r.frames={...dist(intervals),count:metrics.times.length,over16_7:intervals.filter(v=>v>16.7).length,over33:intervals.filter(v=>v>33).length};r.latency.proxyMs=dist(metrics.latencies);r.latency.samples=metrics.latencies.length;r.work.reactCommits=metrics.commits
   r.evidence={...r.evidence,frameSemantics:'requestAnimationFrame cadence; cannot infer idle native submissions or physical presentation',resourcePids:pids,target,scrollHeight:scrolling?await page.locator(target).first().evaluate(el=>el.scrollHeight):null,resourceText:raw}
  }catch(e){r.status='failed';r.reason=safeError(e)}finally{const processAfter=processInventory();r.evidence.quietOrderBefore=orderBefore;r.evidence.quietOrderAfter=quietOrder();r.evidence.gpuixProcessesBefore=processBefore.processes;r.evidence.gpuixProcessesAfter=processAfter.processes;r.evidence.foreignProcessesBefore=processBefore.foreign;r.evidence.foreignProcessesAfter=processAfter.foreign;if(processBefore.foreign.length||processAfter.foreign.length){r.status='discarded';r.reason='foreign GPUIX process: discarded'};watcher.close();r.evidence.buildMarkersDuring=[...seen];r.evidence.buildMarkersFinal=markers();r.evidence.quietMarkersFinal=quiet();if(seen.size||r.evidence.buildMarkersFinal.length){r.status='discarded';r.reason='build overlap: discarded'};if(run===runs||r.status==='failed'||r.status==='discarded'){await page?.close();page=null}}
  results.push(r)
 }
}catch(e){console.error(safeError(e));process.exitCode=1}finally{for(const child of children)child.kill();await browser.close();await server.close();writeFileSync(out,JSON.stringify(results,null,2))}
