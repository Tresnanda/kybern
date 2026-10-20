// Continue the exact visual-pair WebKit steps, recording failures per screen.
import path from 'node:path'
import { readdirSync,readFileSync,writeFileSync,existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
const root=path.resolve(import.meta.dirname,'..'), repo=path.resolve(root,'../..')
const slot=createHash('sha1').update(repo).digest('hex').slice(0,8)
const state=JSON.parse(readFileSync(`/Users/mymac/projects/ade-gpuix-scratch/visual-pair-${slot}/state.json`,'utf8'))
const out='/Users/mymac/projects/ade/previews/gpuix/audit-2026-10-16/visual'
const {webkit}=await import('/Users/mymac/projects/component-kit/node_modules/playwright-core/index.mjs')
const {screens:base}=await import('../visual/screens.tauri.mjs');const screens={...base}
for(const f of readdirSync(path.join(root,'visual/screens')).filter(x=>x.endsWith('.tauri.mjs')).sort())Object.assign(screens,(await import(path.join(root,'visual/screens',f))).screens)
const results=[]
const browser=await webkit.launch()
try{for(const theme of ['dark','light'])for(const [name,fn] of Object.entries(screens)){
 const file=path.join(out,`${name}-${theme}-tauri.png`)
 if(existsSync(file)){results.push({name,theme,status:'Pass',priorFreshCapture:true});continue}
 const ctx=await browser.newContext({viewport:{width:1280,height:820},deviceScaleFactor:2,colorScheme:theme});const page=await ctx.newPage()
 try{
  await page.goto(`http://localhost:${state.vitePort}/?url=ws://127.0.0.1:${state.port}/ws&token=${state.token}`)
  await page.waitForSelector('button[aria-label="Notes"]',{timeout:30000});await page.waitForTimeout(1000)
  await page.addStyleTag({content:'*::-webkit-scrollbar{display:none}'})
  await fn(page);await page.screenshot({path:file});results.push({name,theme,status:'Pass'});console.log('PASS',name,theme)
 }catch(e){const error=String(e).replaceAll(state.token,'[redacted]');results.push({name,theme,status:'Fail',error});console.log('FAIL',name,theme,error);await page.screenshot({path:path.join(out,`${name}-${theme}-tauri-failed.png`)}).catch(()=>{})}
 finally{await ctx.close();writeFileSync(path.join(out,'reference-results.json'),JSON.stringify(results,null,2))}
}}finally{await browser.close()}
