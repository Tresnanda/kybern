const native=new URL('../../native/',import.meta.url).pathname
import {execFileSync,spawnSync} from 'node:child_process'
import path from 'node:path'
import {writeFileSync} from 'node:fs'
const {webkit}=await import(process.env.PLAYWRIGHT_CORE??'/Users/mymac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs')
const server=await webkit.launchServer({headless:false})
const browser=await webkit.connect(server.wsEndpoint())
const out='/Users/mymac/projects/ade/previews/gpuix/perf/backdrop/compositor-reference'
function windowId(){
 const candidates=[server.process().pid]
 for(let n=0;n<candidates.length&&n<12;n++){
  const pid=candidates[n]
  const found=spawnSync('swift',[path.join(native,'surface-window-id.swift'),String(pid)],{encoding:'utf8'})
  if(found.status===0)return found.stdout.trim()
  candidates.push(...spawnSync('pgrep',['-P',String(pid)],{encoding:'utf8'}).stdout.trim().split(/\s+/).filter(Boolean).map(Number))
 }
 throw Error('No task-owned browser window')
}
const audit=[]
try{for(const theme of ['dark','light'])for(const kind of ['surface','links'])for(const mode of kind==='surface'?['translucent','opaque','increased-contrast']:['translucent']){
 const height=kind==='surface'?600:420
 const page=await browser.newPage({viewport:{width:728,height},deviceScaleFactor:2,colorScheme:theme})
 page.on('pageerror',e=>console.error(e))
 await page.goto(`http://127.0.0.1:14379/surface-webkit.html?theme=${theme}&view=${kind}`)
 await page.waitForSelector('.chat-markdown a')
 if(mode==='increased-contrast')await page.emulateMedia({contrast:'more'})
 if(mode==='opaque')await page.evaluate(()=>{document.documentElement.setAttribute('data-window-material','opaque');document.documentElement.removeAttribute('data-full-translucency')})
 await page.waitForTimeout(1000)
 const id=kind==='surface'?windowId():null
 const capture=async(suffix='')=>{
  const output=`${out}/${kind}-${theme}-${mode}-tauri${suffix}.png`
  if(kind==='links'){await page.screenshot({path:output});return}
  const raw=`${out}/${kind}-${theme}-${mode}-webkit${suffix}-window.png`
  execFileSync('screencapture',['-x','-o','-l',id,raw])
  execFileSync('swift',[path.join(native,'surface-crop.swift'),raw,output,String(height)])
 }
 await page.mouse.move(5,height-10);await capture()
 if(kind==='surface'){const material=await page.locator('[data-slot="dialog-popup"]').evaluate(e=>({filter:getComputedStyle(e).backdropFilter,bounds:e.getBoundingClientRect().toJSON(),contrast:matchMedia('(prefers-contrast: more)').matches}));if(mode==='increased-contrast'&&(!material.contrast||material.filter!=='none'))throw Error('Contrast material fallback failed');audit.push({theme,mode,...material});console.log(theme,mode,material)}
 await page.locator('.chat-markdown a').first().hover();await page.waitForTimeout(100);await capture('-hover')
 if(kind==='surface'){await page.mouse.move(100,470);await page.mouse.wheel(0,55);await page.waitForTimeout(300);await capture('-scroll')}
 await page.close();await new Promise(r=>setTimeout(r,400))
}writeFileSync(out+'/materials.json',JSON.stringify(audit,null,2))}finally{await browser.close();await server.close()}
