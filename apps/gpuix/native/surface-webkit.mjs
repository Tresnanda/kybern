import {execFileSync,spawnSync} from 'node:child_process'
import path from 'node:path'
const {webkit}=await import('/Users/mymac/projects/component-kit/node_modules/playwright-core/index.mjs')
const server=await webkit.launchServer({headless:false})
const browser=await webkit.connect(server.wsEndpoint())
const out='/Users/mymac/projects/ade/previews/gpuix/p1g'
function windowId(){
 const candidates=[server.process().pid]
 for(let n=0;n<candidates.length&&n<12;n++){
  const pid=candidates[n]
  const found=spawnSync('swift',[path.join(import.meta.dirname,'surface-window-id.swift'),String(pid)],{encoding:'utf8'})
  if(found.status===0)return found.stdout.trim()
  candidates.push(...spawnSync('pgrep',['-P',String(pid)],{encoding:'utf8'}).stdout.trim().split(/\s+/).filter(Boolean).map(Number))
 }
 throw Error('No task-owned browser window')
}
try{for(const theme of ['dark','light'])for(const kind of ['surface','links']){
 const height=kind==='surface'?600:420
 const page=await browser.newPage({viewport:{width:728,height},deviceScaleFactor:2,colorScheme:theme})
 page.on('pageerror',e=>console.error(e))
 await page.goto(`http://127.0.0.1:14373/surface-webkit.html?theme=${theme}&view=${kind}`)
 await page.waitForSelector('.chat-markdown a');await page.waitForTimeout(1000)
 const id=kind==='surface'?windowId():null
 const capture=async(suffix='')=>{
  const output=`${out}/${kind}-${theme}-tauri${suffix}.png`
  if(kind==='links'){await page.screenshot({path:output});return}
  const raw=`${out}/${kind}-${theme}-webkit${suffix}-window.png`
  execFileSync('screencapture',['-x','-o','-l',id,raw])
  execFileSync('swift',[path.join(import.meta.dirname,'surface-crop.swift'),raw,output,String(height)])
 }
 await page.mouse.move(5,height-10);await capture()
 if(kind==='surface')console.log(theme,await page.locator('[data-slot="dialog-popup"]').evaluate(e=>({filter:getComputedStyle(e).backdropFilter,bounds:e.getBoundingClientRect().toJSON()})))
 await page.locator('.chat-markdown a').first().hover();await page.waitForTimeout(100);await capture('-hover')
 await page.close();await new Promise(r=>setTimeout(r,400))
}}finally{await browser.close();await server.close()}
