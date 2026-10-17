// Desktop components in cached WebKit; not a native Tauri host benchmark.
// NAPI's generic override would otherwise make Rolldown load the GPUIX addon.
delete process.env.NAPI_RS_NATIVE_LIBRARY_PATH
import {mkdirSync,writeFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
async function waitForNativeBuilds(){while(execFileSync('ps',['-axo','comm='],{encoding:'utf8'}).split('\n').some(line=>/(^|\/)(cargo|rustc)$/.test(line.trim())))await new Promise(resolve=>setTimeout(resolve,1000))}
const require=createRequire(new URL('../../desktop/package.json',import.meta.url))
const {createServer}=await import(require.resolve('vite'))
const {webkit}=await import(process.env.PLAYWRIGHT_CORE??'/Users/mymac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs')
const out=process.env.KYBERN_VERIFY_OUTPUT??'/Users/mymac/projects/ade/previews/gpuix/round8/loops/desktop-loops'
mkdirSync(out,{recursive:true})
const server=await createServer({configFile:path.join(import.meta.dirname,'loops8-webkit.config.mjs'),server:{port:0,strictPort:false}});await server.listen()
const browser=await webkit.launch()
try{for(const theme of ['dark','light'])for(const reduced of [false,true]){
 const page=await browser.newPage({viewport:{width:560,height:320},deviceScaleFactor:2,colorScheme:theme,reducedMotion:reduced?'reduce':'no-preference'})
 page.on('pageerror',e=>console.error(e));await page.goto(`${server.resolvedUrls.local[0]}loops8-webkit.html?theme=${theme}`);await page.locator('.t-matrix').first().waitFor()
 await waitForNativeBuilds()
 const samples=await page.evaluate(()=>new Promise(resolve=>{const times=[];function step(t){times.push(t);if(times.length===181)resolve(times);else requestAnimationFrame(step)}requestAnimationFrame(step)}))
 const intervals=samples.slice(1).map((t,i)=>t-samples[i]).sort((a,b)=>a-b)
 const shots=[]
 for(let i=0;i<10;i++){const file=`${out}/desktop-${theme}-${Number(reduced)}-${i}.png`;await page.screenshot({path:file});shots.push({file,time:await page.evaluate(()=>performance.now())});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)))}
 const result={theme,reduced,buildFree:true,p50:intervals[90],p95:intervals[171],shots,note:'Desktop components in WebKit; rAF timestamps, no GPU presentation fence'}
 writeFileSync(`${out}/desktop-${theme}-${Number(reduced)}.json`,JSON.stringify(result,null,2));console.log(JSON.stringify({...result,shots:undefined}));await page.close()
}}finally{await browser.close();await server.close()}
