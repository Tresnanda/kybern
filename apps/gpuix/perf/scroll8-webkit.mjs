// Actual desktop frontend in WebKit; explicitly NOT a native Tauri shell.
import path from 'node:path'
import {execFileSync,spawn} from 'node:child_process'
import {createRequire} from 'node:module'
import {mkdirSync,writeFileSync} from 'node:fs'
const desktop=path.resolve(import.meta.dirname,'../../desktop'),require=createRequire(path.join(desktop,'package.json'))
const {createServer}=await import(require.resolve('vite'))
const {webkit}=await import(process.env.PLAYWRIGHT_CORE??'/Users/mymac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs')
const theme=process.argv[2]??'dark',reduced=process.argv[3]==='1',out='/Users/mymac/projects/ade/previews/gpuix/round8/scroll'
const real=process.env.SCROLL8_REAL==='1',reference=real?'desktop-webkit-real-120hz':'desktop-webkit-120hz'
mkdirSync(out,{recursive:true})
const server=await createServer({root:desktop,configFile:path.join(desktop,'vite.config.ts'),server:{host:'127.0.0.1',port:0}})
await server.listen()
const processTable=()=>execFileSync('ps',['-Ao','pid=,ppid=,comm='],{encoding:'utf8'}).trim().split('\n').map(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);return[Number(m[1]),Number(m[2]),m[3]]})
const existingPids=new Set(processTable().map(([pid])=>pid)),webkitRoot=path.dirname(webkit.executablePath())
const browser=await webkit.launch()
try {
 const page=await browser.newPage({viewport:{width:1280,height:820},deviceScaleFactor:2,colorScheme:theme,reducedMotion:reduced?'reduce':'no-preference'})
 await page.addInitScript(()=>{window.__pacingCommits=0;window.__REACT_DEVTOOLS_GLOBAL_HOOK__={supportsFiber:true,renderers:new Map(),inject(){return 1},onCommitFiberRoot(){window.__pacingCommits++},onCommitFiberUnmount(){},onScheduleFiberRoot(){}}})
 await page.goto(`${server.resolvedUrls.local[0]}?url=${encodeURIComponent(process.env.KYBERN_URL)}&token=local-fixture`)
 await page.getByRole('button',{name:'Pull requests',exact:true}).first().click()
 await page.locator('[data-pr-row]').first().waitFor()
 const results=[]
 for(const scene of ['list','summary','changes','timeline']) {
  if(scene==='summary')await page.locator(`[data-pr-row][data-row-key$=":${process.env.SCROLL8_PR_NUMBER??108}"]`).click()
  if(scene==='changes'||scene==='timeline')await page.getByRole('tab',{name:new RegExp(`^${scene==='changes'?'Changes':'Timeline'}`)}).click()
  if(scene==='summary')await page.locator('.pr-summary-body').waitFor()
  if(scene==='changes'){await page.locator('[data-pr-diff]').waitFor();if(real&&process.env.SCROLL8_FILE_INDEX)await page.locator('.pr-changes-files button[aria-pressed]').nth(Number(process.env.SCROLL8_FILE_INDEX)).click()}
  if(scene==='timeline'){if(real)await page.getByText('No comments on this page.',{exact:true}).waitFor();else await page.getByText('Finding 1',{exact:true}).first().waitFor()}
  const target=scene==='list'?'.pr-inbox-list .overflow-y-auto':'[data-pr-scroll]'
  const bounds=await page.locator(target).boundingBox()
  if(!bounds)throw Error(`Missing target ${target}`)
  await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2)
  // Browser input dispatch, using the same 120 Hz packet schedule/deltas as native.
  const input=async(count,warm=false)=>{
   const start=performance.now(),packets=[],pending=[];let outstanding=0,maxOutstanding=0
   for(let i=0;i<count;i++){
    const phase=i%300,cycle=i%600
    const delta=warm?(phase<120?3:3*Math.exp(-(phase-120)/45)):(phase<120?6*Math.sin(Math.PI*Math.min(phase+1,30)/60):6*Math.exp(-(phase-120)/45))
    const sent=performance.now();outstanding++;maxOutstanding=Math.max(maxOutstanding,outstanding);pending.push(page.mouse.wheel(0,(cycle<300?1:-1)*delta).then(()=>{packets.push(performance.now()-sent);outstanding--}))
    const due=start+(i+1)*1000/120;if(due>performance.now())await new Promise(r=>setTimeout(r,due-performance.now()))
   }
   const offeredMs=performance.now()-start;await Promise.all(pending);const inputMs=performance.now()-start,sorted=[...packets].sort((a,b)=>a-b);return{packets,inputMs,offeredMs,drainMs:inputMs-offeredMs,maxOutstanding,packetAckP50:sorted[Math.floor(sorted.length*.5)],packetAckP95:sorted[Math.floor(sorted.length*.95)]}
  }
  let metrics={},inputMetrics={},resourceText="",resourcePids=[]
  if(process.env.SCROLL8_VISUAL!=='1'){
  await input(1200,true)
  const processes=processTable()
  const owned=new Set([process.pid]);let more=true
  while(more){more=false;for(const[pid,parent]of processes)if(owned.has(parent)&&!owned.has(pid)){owned.add(pid);more=true}}
  resourcePids=processes.filter(([pid,,command])=>{
   if(!/WebKit|MiniBrowser|Playwright|WebProcess|NetworkProcess|GPUProcess/.test(command))return false
   if(owned.has(pid))return true
   if(existingPids.has(pid))return false
   // macOS adopts WebKit XPC services into launchd. Their loaded cached
   // framework identifies this browser without reading process environments.
   if(command.includes(webkitRoot))return true
   try{return execFileSync('lsof',['-a','-p',String(pid),'-d','txt','-Fn'],{encoding:'utf8'}).includes(webkitRoot)}catch{return false}
  }).map(([pid])=>pid)
  if(resourcePids.length<2)throw Error(`Incomplete WebKit process group: ${JSON.stringify(processes.filter(([pid,,command])=>!existingPids.has(pid)&&/WebKit|Playwright|WebProcess|NetworkProcess|GPUProcess/.test(command)))}`)
  const sampler=spawn('bun',[path.join(import.meta.dirname,'sample.ts'),'15',`WebKit=${resourcePids.join(',')}`],{stdio:['ignore','pipe','pipe']})
  let sampleOutput='',sampleError='';sampler.stdout.on('data',chunk=>sampleOutput+=String(chunk));sampler.stderr.on('data',chunk=>sampleError+=String(chunk))
  const sampleDone=new Promise((resolve,reject)=>sampler.once('exit',code=>code===0?resolve():reject(Error(sampleError))))
  await page.evaluate(()=>{
   window.__scroll8={times:[],commits:window.__pacingCommits,running:true,wheels:[],pending:null}
   window.__scroll8.onWheel=()=>{const now=performance.now(),m=window.__scroll8;m.pending??={first:now,last:now,packets:0};m.pending.last=now;m.pending.packets++};window.addEventListener("wheel",window.__scroll8.onWheel,{passive:true})
   const tick=now=>{if(!window.__scroll8.running)return;window.__scroll8.times.push(now);const m=window.__scroll8;if(m.pending){m.wheels.push({firstMs:now-m.pending.first,lastMs:now-m.pending.last,packets:m.pending.packets});m.pending=null}requestAnimationFrame(tick)};requestAnimationFrame(tick)
  })
  inputMetrics=await input(1800)
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
  metrics=await page.evaluate(({target})=>{
   const m=window.__scroll8;m.running=false;window.removeEventListener("wheel",m.onWheel)
   const intervals=m.times.slice(1).map((t,i)=>t-m.times[i]),sorted=[...intervals].sort((a,b)=>a-b),el=document.querySelector(target)
   const percentile=(values,fraction)=>{const a=[...values].sort((a,b)=>a-b);return a[Math.floor(a.length*fraction)]??null}
   return{domWheelToRafP50:percentile(m.wheels.map(v=>v.firstMs),.5),domWheelToRafP95:percentile(m.wheels.map(v=>v.firstMs),.95),domMergedPacketsMax:Math.max(0,...m.wheels.map(v=>v.packets)),domWheelEvents:m.wheels.reduce((n,v)=>n+v.packets,0),frames:m.times.length,p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.floor(sorted.length*.95)],commits:window.__pacingCommits-m.commits,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,intervals}
  },{target})
  await sampleDone;resourceText=sampleOutput
  }
  results.push({scene,...metrics,...inputMetrics,resourceText,resourcePids});console.log(JSON.stringify({scene,...metrics,intervals:undefined}))
  if(process.env.SCROLL8_VISUAL==='1'){
   await page.evaluate(async()=>{await document.fonts.ready;await Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))})
   if(scene==='summary'&&!real){await page.locator('.pr-summary-body strong').first().waitFor();await page.locator('.pr-summary-body code').first().waitFor()}
   await page.screenshot({path:`${out}/${reference}-${theme}-${reduced?1:0}-${scene}.png`})
  }
 }
 writeFileSync(`${out}/${process.env.SCROLL8_VISUAL==='1'?'visual-':''}${reference}-${theme}-${reduced?1:0}.json`,JSON.stringify({host:'Playwright WebKit, desktop frontend, not Tauri',theme,reduced,results},null,2))
}finally{await browser.close();await server.close()}
