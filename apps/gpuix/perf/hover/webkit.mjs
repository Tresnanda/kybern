// Actual desktop frontend, headless WebKit; native audit coordinates drive it.
import path from 'node:path'
import {readFileSync,readdirSync,writeFileSync} from 'node:fs'
const {webkit}=await import(process.env.PLAYWRIGHT_CORE)
const visual=path.resolve(import.meta.dirname,'../../visual'),spec=JSON.parse(process.argv[2])
const {screens:base}=await import(path.join(visual,'screens.tauri.mjs')),screens={...base}
for(const file of readdirSync(path.join(visual,'screens')).filter(n=>n.endsWith('.tauri.mjs')))Object.assign(screens,(await import(path.join(visual,'screens',file))).screens)
// The audit adds enough cards to virtualize the original named note away.
// Open the same newest populated note as the native editor selection probe.
screens['notes-editor']=async page=>{await screens['notes-gallery'](page);await page.getByPlaceholder('Search notes').fill('Hover audit note 31');await page.waitForTimeout(500);await page.locator('[data-note-card][aria-label="Hover audit note 31"]').first().click();await page.waitForTimeout(1200);await page.mouse.move(1275,815)}
const reduced=process.env.KYBERN_REDUCED_MOTION??'0',native=path.join(spec.evidence,'after-app')
const records=readdirSync(native).filter(n=>n.startsWith(`audit-${spec.theme}-${reduced}-`)&&n.endsWith('.json')).flatMap(n=>JSON.parse(readFileSync(path.join(native,n),'utf8')))
const browser=await webkit.launch(),checks=[]
try{
 for(const name of spec.screens){
  const context=await browser.newContext({viewport:{width:1280,height:820},deviceScaleFactor:2,colorScheme:spec.theme,reducedMotion:reduced==='1'?'reduce':'no-preference'})
  try{
   const page=await context.newPage()
   await page.goto(`http://127.0.0.1:${spec.vite}/?url=ws://127.0.0.1:${spec.port}/ws&token=${spec.token}`)
   await page.waitForSelector('button[aria-label="Notes"]',{timeout:30000});await page.waitForTimeout(1000)
   await page.addStyleTag({content:'*::-webkit-scrollbar{display:none}'})
   if(!screens[name])throw Error(`Missing desktop screen ${name}`)
   await screens[name](page)
   const shot=label=>page.screenshot({path:path.join(spec.out,`${name}-${spec.theme}-${label}.png`)})
   await shot('tauri')
   const record=records.find(r=>r.surface===name&&!r.checks.error),point=record?.checks.pointer
   if(!point)throw Error(`Missing native pointer for ${name}`)
   await page.mouse.move(point.x,point.y);await page.waitForTimeout(1000);await shot('hover')
   await page.mouse.wheel(0,-(record.checks.wheelDelta??-112));await page.waitForTimeout(1000);await shot('stationary-scroll')
   await page.mouse.move(point.x+.1,point.y);await page.waitForTimeout(200);await shot('nudged')
   await page.setViewportSize({width:1180,height:820});await page.waitForTimeout(1000);await shot('stationary-reflow')
   await page.mouse.move(point.x+.2,point.y);await page.waitForTimeout(200);await shot('reflow-nudged')
   checks.push({surface:name,theme:spec.theme,reduced,point,bodyUserSelect:await page.evaluate(()=>getComputedStyle(document.body).userSelect)})
   console.log(`[webkit] ${name}/${spec.theme}/${reduced}`)
  }finally{await context.close()}
 }
}finally{await browser.close();writeFileSync(path.join(spec.out,`checks-${spec.theme}-${spec.screens[0]}.json`),JSON.stringify(checks,null,2))}
