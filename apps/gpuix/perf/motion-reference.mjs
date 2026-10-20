// Actual desktop frontend in headless Playwright WebKit. This is a source/UI
// reference, not the shipped Tauri/WKWebView or its resource coalition.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {createRequire} from 'node:module'
import path from 'node:path'
const desktop=path.resolve(import.meta.dirname,'../../desktop'),require=createRequire(path.join(desktop,'package.json'))
const {createServer}=await import(require.resolve('vite'))
const {webkit}=await import(process.env.PLAYWRIGHT_CORE??'/Users/mymac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs')
const data=process.env.KYBERN_DATA_DIR??''
if(!data.includes('gpuix-scratch/round5/motion/'))throw Error('Own motion fixture required')
const out='/Users/mymac/projects/ade/previews/gpuix/round5/motion';mkdirSync(out,{recursive:true})
const port=readFileSync(path.join(data,'daemon.port'),'utf8').trim(),token=readFileSync(path.join(data,'daemon.token'),'utf8').trim()
const server=await createServer({root:desktop,configFile:path.join(desktop,'vite.config.ts'),cacheDir:path.join(data,'vite-cache'),optimizeDeps:{include:['shiki/core','shiki/engine/javascript','shiki/langs','shiki/themes']},server:{host:'127.0.0.1',port:0,strictPort:false,fs:{allow:[path.resolve(desktop,'../..'),'/Users/mymac/projects/ade-gpuix/apps/desktop/node_modules']}}})
await server.listen()
const browser=await webkit.launch(),records=[]
try{
 for(const theme of ['dark','light'])for(const reduced of [false,true]){
  const context=await browser.newContext({viewport:{width:1280,height:820},deviceScaleFactor:2,colorScheme:theme,reducedMotion:reduced?'reduce':'no-preference'})
  const page=await context.newPage()
  try{
   await page.goto(`${server.resolvedUrls.local[0]}?url=ws://127.0.0.1:${port}/ws&token=${encodeURIComponent(token)}`)
   await page.getByText('Combined verification',{exact:true}).first().click()
   const button=page.getByRole('button',{name:'Toggle environment panel',exact:true})
   await button.waitFor();await page.waitForTimeout(1200);await page.evaluate(()=>document.fonts.ready)
   const timingPromise=page.evaluate(async()=>{const times=[];const start=performance.now();await new Promise(resolve=>{const tick=t=>{times.push(t);if(t-start<650)requestAnimationFrame(tick);else resolve()};requestAnimationFrame(tick)});const dt=times.slice(1).map((v,i)=>v-times[i]).sort((a,b)=>a-b);return{frames:times.length,p50:dt[Math.floor(dt.length*.5)],p95:dt[Math.floor(dt.length*.95)],max:dt.at(-1)}})
   await button.click()
   const reference=await page.evaluate(()=>{
    const panel=document.querySelector('[data-environment-panel-variant] aside'),inset=document.querySelector('[data-chat-scroll-container]')?.closest('.transition-\\[padding-right\\]')
    const nodes=[...document.querySelectorAll('*')].filter(el=>getComputedStyle(el).transitionProperty==='padding-right')
    return {panel:panel?{transition:getComputedStyle(panel).transition,transform:getComputedStyle(panel).transform,opacity:getComputedStyle(panel).opacity}:null,insets:nodes.map(el=>({transition:getComputedStyle(el).transition,paddingRight:getComputedStyle(el).paddingRight})),animations:document.getAnimations().map(a=>({duration:a.effect.getTiming().duration,keyframes:a.effect.getKeyframes().filter(k=>'paddingRight'in k||'transform'in k).map(({paddingRight,transform,opacity})=>({paddingRight,transform,opacity}))})).filter(a=>a.keyframes.length)}
   })
   const frameIntervalsMs=await timingPromise
   await page.waitForTimeout(350);await page.screenshot({path:`${out}/reference-environment-${theme}-${+reduced}.png`})
   await page.getByRole('button',{name:'Tasks',exact:true}).first().click();await page.getByRole('button',{name:'Board',exact:true}).click()
   const card=page.locator('[data-task-card]').filter({hasText:'Idle task 0'}).first();await card.waitFor();const b=await card.boundingBox()
   await page.mouse.move(b.x+b.width/2,b.y+30);await page.mouse.down();await page.mouse.move(b.x+b.width/2+70,b.y+40,{steps:5})
   const overlay=page.locator('.tk-card[data-overlay]');await overlay.waitFor()
   const lift=await overlay.evaluate(el=>({rotate:getComputedStyle(el).rotate,boxShadow:getComputedStyle(el).boxShadow,transform:getComputedStyle(el).transform,bounds:el.getBoundingClientRect().toJSON()}))
   await page.screenshot({path:`${out}/reference-drag-${theme}-${+reduced}.png`})
   await page.mouse.up();await page.waitForTimeout(350)
   records.push({theme,reduced,reference,lift,frameIntervalsMs});console.log('PASS desktop WebKit reference',theme,reduced)
  }finally{await context.close()}
 }
 writeFileSync(`${out}/desktop-reference.json`,JSON.stringify(records,null,2))
}finally{await browser.close();await server.close()}
