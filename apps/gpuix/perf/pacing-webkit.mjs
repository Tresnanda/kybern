// Actual desktop frontend in WebKit; explicitly NOT a native Tauri shell.
import path from 'node:path'
import {createRequire} from 'node:module'
import {mkdirSync,writeFileSync} from 'node:fs'
const desktop=path.resolve(import.meta.dirname,'../../desktop'),require=createRequire(path.join(desktop,'package.json'))
const {createServer}=await import(require.resolve('vite'))
const {webkit}=await import(process.env.PLAYWRIGHT_CORE??'/Users/mymac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs')
const theme=process.argv[2]??'dark',reduced=process.argv[3]==='1',out='/Users/mymac/projects/ade/previews/gpuix/round7/pacing'
mkdirSync(out,{recursive:true})
const server=await createServer({root:desktop,configFile:path.join(desktop,'vite.config.ts'),server:{host:'127.0.0.1',port:0}})
await server.listen()
const browser=await webkit.launch()
try {
 const page=await browser.newPage({viewport:{width:1280,height:820},deviceScaleFactor:2,colorScheme:theme,reducedMotion:reduced?'reduce':'no-preference'})
 await page.addInitScript(()=>{window.__pacingCommits=0;window.__REACT_DEVTOOLS_GLOBAL_HOOK__={supportsFiber:true,renderers:new Map(),inject(){return 1},onCommitFiberRoot(){window.__pacingCommits++},onCommitFiberUnmount(){},onScheduleFiberRoot(){}}})
 await page.goto(`${server.resolvedUrls.local[0]}?url=${encodeURIComponent(process.env.KYBERN_URL)}&token=local-fixture`)
 await page.getByRole('button',{name:'Pull requests',exact:true}).first().click()
 await page.locator('[data-pr-row]').first().waitFor()
 const results=[]
 for(const scene of ['list','summary','changes','timeline']) {
  if(scene==='summary')await page.getByText('Preserve reading position while streaming',{exact:true}).first().click()
  if(scene==='changes'||scene==='timeline')await page.getByRole('tab',{name:new RegExp(`^${scene==='changes'?'Changes':'Timeline'}`)}).click()
  if(scene==='summary')await page.locator('.pr-summary-body').waitFor()
  if(scene==='changes')await page.locator('[data-pr-diff]').waitFor()
  if(scene==='timeline')await page.getByText('Finding 1',{exact:true}).first().waitFor()
  const target=scene==='list'?'.pr-inbox-list .overflow-y-auto':'[data-pr-scroll]'
  const metrics=await page.evaluate(async({target})=>{
   const el=document.querySelector(target);if(!el)throw Error(`No scroller ${target}`)
   document.activeElement?.blur?.()
   const intervals=[],latencies=[],times=[],before=window.__pacingCommits
   let previous,step=0,pending
   const start=performance.now()
   await new Promise(done=>{
    const tick=now=>{
     if(previous!==undefined)intervals.push(now-previous)
     if(pending!==undefined)latencies.push(now-pending)
     times.push(now);previous=now
     pending=performance.now();el.scrollBy(0,step<90?14:-14)
     if(++step<180)requestAnimationFrame(tick);else requestAnimationFrame(done)
    };requestAnimationFrame(tick)
   })
   const sorted=values=>[...values].sort((a,b)=>a-b),dt=sorted(intervals),lat=sorted(latencies)
   return {frames:times.length,p50:dt[Math.floor(dt.length*.5)],p95:dt[Math.floor(dt.length*.95)],inputToNextRafP50:lat[Math.floor(lat.length*.5)],inputToNextRafP95:lat[Math.floor(lat.length*.95)],commits:window.__pacingCommits-before,elapsedMs:performance.now()-start,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,intervals}
  },{target})
  results.push({scene,...metrics});console.log(JSON.stringify({scene,...metrics,intervals:undefined}))
  await page.screenshot({path:`${out}/desktop-webkit-${theme}-${reduced?1:0}-${scene}.png`})
 }
 writeFileSync(`${out}/desktop-webkit-${theme}-${reduced?1:0}.json`,JSON.stringify({host:'Playwright WebKit, desktop frontend, not Tauri',theme,reduced,results},null,2))
}finally{await browser.close();await server.close()}
