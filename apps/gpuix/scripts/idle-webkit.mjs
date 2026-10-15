/** Full desktop frontend + isolated daemon; run via idle-fixture.ts. No Tauri shell is measured. */
import {readFileSync} from 'node:fs'
import {spawn,execFileSync} from 'node:child_process'
import path from 'node:path'
import {createRequire} from 'node:module'
const desktop=path.resolve(import.meta.dirname,'../../desktop')
const require=createRequire(path.join(desktop,'package.json'))
const {createServer}=await import(require.resolve('vite'))
const {webkit}=await import(process.env.PLAYWRIGHT_CORE??'/Users/mymac/projects/component-kit/node_modules/playwright-core/index.mjs')
const data=process.env.KYBERN_DATA_DIR
if(!data?.includes('gpuix-scratch')) throw Error('Use idle-fixture.ts')
const port=readFileSync(path.join(data,'daemon.port'),'utf8').trim()
if(port==='4219')throw Error('Reserved port')
const token=readFileSync(path.join(data,'daemon.token'),'utf8').trim()
const server=await createServer({root:desktop,configFile:path.join(desktop,'vite.config.ts'),server:{host:'127.0.0.1',port:0,strictPort:false}})
await server.listen()
const webkitPids=()=>execFileSync('ps',['-axo','pid=,command='],{encoding:'utf8'}).split('\n').filter(s=>s.includes('/ms-playwright/webkit-')&&s.includes('/Contents/MacOS/')).map(s=>Number(s.trim().split(/\s+/)[0]))
const priorPids=new Set(webkitPids())
const browserServer=await webkit.launchServer({headless:process.env.KYBERN_IDLE_HEADED!=='1'})
const browser=await webkit.connect(browserServer.wsEndpoint())
function descendants(pid){const rows=execFileSync('ps',['-axo','pid=,ppid='],{encoding:'utf8'}).trim().split('\n').map(s=>s.trim().split(/\s+/).map(Number));const ids=new Set([pid]);let size;do{size=ids.size;for(const [p,pp] of rows)if(ids.has(pp))ids.add(p)}while(size!==ids.size);return [...ids]}
try {
 const page=await browser.newPage({viewport:{width:1280,height:820},deviceScaleFactor:2,colorScheme:'dark',reducedMotion:'no-preference'})
 page.on('pageerror',e=>console.error('PAGE',e.message))
 await page.addInitScript(()=>{window.__idleCommits=0;window.__REACT_DEVTOOLS_GLOBAL_HOOK__={supportsFiber:true,renderers:new Map(),inject(renderer){this.renderers.set(1,renderer);return 1},onScheduleFiberRoot:()=>{},onCommitFiberRoot:()=>window.__idleCommits++,onCommitFiberUnmount:()=>{}}})
 await page.goto(`${server.resolvedUrls.local[0]}?url=ws://127.0.0.1:${port}/ws&token=${encodeURIComponent(token)}`)
 await page.getByRole('button',{name:'Tasks',exact:true}).first().waitFor({timeout:60000})
 if(process.env.KYBERN_IDLE_SETTLE_MS) await page.waitForTimeout(Number(process.env.KYBERN_IDLE_SETTLE_MS))
 let pausedStyle
 for(const scene of process.argv.slice(2).length?process.argv.slice(2):['home','tasks']) {
  if(pausedStyle){await pausedStyle.evaluate(el=>el.remove());pausedStyle=undefined}
  if(scene.startsWith('home')) await page.getByRole('button',{name:'Home',exact:true}).first().click()
  if(scene==='tasks'){await page.getByRole('button',{name:'Tasks',exact:true}).first().click();await page.getByRole('button',{name:'Board',exact:true}).click()}
  if(scene.endsWith('-still')) pausedStyle=await page.addStyleTag({content:'*,*::before,*::after{animation-play-state:paused!important}'})
  await page.mouse.move(1275,815)
  // Background native windows do not blink a text caret; park browser focus too.
  await page.evaluate(()=>document.activeElement instanceof HTMLElement && document.activeElement.blur())
  await page.waitForTimeout(10000)
  await page.evaluate(()=>document.activeElement instanceof HTMLElement && document.activeElement.blur())
  const state=()=>page.evaluate(()=>({commits:window.__idleCommits,visibility:document.visibilityState,activeTag:document.activeElement?.tagName,animations:document.getAnimations().filter(a=>a.playState==='running').length,text:document.body.innerText.slice(0,1000)}))
  const before=await state(),pids=[...new Set([...descendants(browserServer.process().pid),...webkitPids().filter(pid=>!priorPids.has(pid))])]
  console.log('SCENE',scene,'WEBKIT',pids,JSON.stringify(before))
  const sample=spawn('bun',[path.resolve(import.meta.dirname,'../perf/sample.ts'),'15',`WebKit=${pids.join(',')}`],{stdio:'inherit'})
  await new Promise((resolve,reject)=>sample.once('exit',code=>code?reject(Error('Sampler failed')):resolve()))
  const after=await state();console.log('REACT_COMMITS',after.commits-before.commits,'ANIMATIONS',after.animations)
 }
}finally{await browser.close();await browserServer.close();await server.close()}
