// Explicitly requested headless desktop WebKit reference, never a Tauri launch.
import path from 'node:path'
import {createRequire} from 'node:module'
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import assert from 'node:assert/strict'
const root=path.resolve(import.meta.dirname,'../../../../..'),desktop=path.join(root,'apps/desktop'),require=createRequire(desktop+'/package.json')
const {createServer}=await import(require.resolve('vite'))
const base=(await import(path.join(desktop,'vite.config.ts'))).default
const {webkit}=await import(process.env.PLAYWRIGHT_CORE??'/Users/mymac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs')
const out='/Users/mymac/projects/ade/previews/gpuix/handson-r5/order/desktop';mkdirSync(out,{recursive:true})
const image='data:image/png;base64,'+readFileSync('/Users/mymac/projects/ade-gpuix-scratch/hr5-order-bench/projects/project-00/fixture.png').toString('base64')
const server=await createServer({...base,root:import.meta.dirname,configFile:false,resolve:{...base.resolve,alias:{...base.resolve.alias,'react':path.dirname(require.resolve('react/package.json')),'react-dom':path.dirname(require.resolve('react-dom/package.json'))}},optimizeDeps:{entries:['desktop.html']},server:{host:'127.0.0.1',port:14443,strictPort:true,fs:{allow:[root]}}})
await server.listen()
writeFileSync(out+'/compiled-desktop.txt',await (await fetch(server.resolvedUrls.local[0]+'desktop.tsx')).text())
const browser=await webkit.launch({headless:true}),results=[]
try{for(const theme of ['dark','light'])for(const reducedMotion of ['no-preference','reduce']){
 const page=await browser.newPage({viewport:{width:1280,height:820},deviceScaleFactor:2,colorScheme:theme,reducedMotion})
 const errors=[];page.on('pageerror',error=>{errors.push(String(error));console.error(error.stack??String(error))})
 try{
  await page.addInitScript(value=>{window.__orderImage=value;window.__orderKeys=[];document.addEventListener('keydown',event=>{window.__orderKeys.push({key:event.key,tag:document.activeElement?.tagName})},true)},image)
  await page.goto(server.resolvedUrls.local[0]+'desktop.html?theme='+theme)
  await page.locator('#row-500 img').waitFor()
  assert.deepEqual(errors,[])
  await page.evaluate(()=>{const row=document.querySelector('#row-500'),scroll=document.querySelector('#scroll');scroll.scrollTop=row.offsetTop-280})
  await page.mouse.move(850,400);await page.mouse.wheel(0,37);await page.waitForTimeout(150)
  const read=()=>page.evaluate(()=>({top:document.querySelector('#scroll').scrollTop,y:document.querySelector('#row-500').getBoundingClientRect().y}))
  for(const close of ['escape','button','outside']){
   const before=await read()
   await page.screenshot({path:`${out}/${theme}-${reducedMotion}-${close}-before.png`})
   await page.locator('#row-500 button.response-image-preview').click()
   await page.getByRole('dialog').waitFor();await page.waitForTimeout(300)
   assert.equal(await page.locator('[data-slot="dialog-viewport"]').evaluate(el=>getComputedStyle(el).position),'fixed','Actual desktop utility styles must be generated')
   await page.getByRole('dialog').focus()
   if(close==='escape')await page.screenshot({path:`${out}/${theme}-${reducedMotion}-open.png`})
   if(close==='escape')await page.getByRole('dialog').press('Escape')
   else if(close==='button')await page.getByRole('button',{name:'Close',exact:true}).click()
   else await page.mouse.click(40,400)
   writeFileSync(`${out}/${theme}-${reducedMotion}-${close}-input.json`,JSON.stringify(await page.evaluate(()=>({keys:window.__orderKeys,focus:document.activeElement?.outerHTML?.slice(0,600)})),null,2))
   await page.getByRole('dialog').waitFor({state:'detached'});await page.waitForTimeout(50)
   const after=await read();assert.deepEqual(after,before)
   await page.screenshot({path:`${out}/${theme}-${reducedMotion}-${close}-after.png`})
   results.push({theme,reducedMotion,close,before,after})
  }
 }finally{await page.close()}
}}finally{await browser.close();await server.close()}
writeFileSync(out+'/results.json',JSON.stringify(results,null,2));console.log(`PASS actual desktop ResponseImage: ${results.length} exact-position close checks`)
