// Desktop WebKit reference: paused transition strips and separate live rAF timing.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {createHash} from 'node:crypto'
import path from 'node:path'

const {webkit}=await import(process.env.PLAYWRIGHT_CORE)
const slot=createHash('sha1').update(path.resolve(import.meta.dirname,'../../..')).digest('hex').slice(0,8)
const scratch=`/Users/mymac/projects/ade-gpuix-scratch/visual-pair-${slot}`
const state=JSON.parse(readFileSync(`${scratch}/state.json`,'utf8'))
const up=JSON.parse(readFileSync(`${scratch}/shell3-up.json`,'utf8'))
const theme=process.argv[2]??'dark',out='/Users/mymac/projects/ade/previews/gpuix/round3-resume/shell'
const browser=await webkit.launch()
try{
 const context=await browser.newContext({viewport:{width:1280,height:820},deviceScaleFactor:2,colorScheme:theme,reducedMotion:'no-preference'})
 const page=await context.newPage()
 await page.goto(`http://localhost:${state.vitePort}/?url=${up.proxy}&token=${state.token}`)
 await page.waitForSelector('button[aria-label="Notes"]')
 await page.getByText('Long review thread',{exact:true}).first().waitFor({state:'attached',timeout:15000}).catch(async()=>{await page.getByText(/^Show \d+ more$/).first().click()})
 await page.getByText('Long review thread',{exact:true}).first().click()
 await page.waitForSelector('[data-chat-scroll-container]')
 await page.waitForTimeout(500)
 const button=page.getByRole('button',{name:'Toggle environment panel',exact:true})
 await button.hover();await page.waitForTimeout(180)
 const sample=async(action)=>{
  const promise=page.evaluate(async()=>{const times=[];const start=performance.now();await new Promise(done=>{const tick=t=>{times.push(t);if(t-start<650)requestAnimationFrame(tick);else done()};requestAnimationFrame(tick)});return times})
  await action();const ticks=await promise,dt=ticks.slice(1).map((t,i)=>t-ticks[i]).sort((a,b)=>a-b)
  return {frames:ticks.length,p50:dt[Math.floor(dt.length*.5)],p95:dt[Math.floor(dt.length*.95)]}
 }
 const timing={open:await sample(()=>button.click()),close:await sample(()=>button.click())}
 const dir=`${out}/environment-tauri-${theme}`;mkdirSync(dir,{recursive:true})
 await button.click()
 await page.evaluate(()=>{document.querySelector('[data-environment-panel-variant] aside')?.getBoundingClientRect();window.__motions=document.getAnimations().filter(a=>a.effect?.target?.closest?.('[data-environment-panel-variant]') || a.effect?.getKeyframes?.().some(k=>'paddingRight'in k));for(const a of window.__motions)a.pause()})
 console.log('reference animations',await page.evaluate(()=>window.__motions.map(a=>({duration:a.effect.getTiming().duration,keyframes:a.effect.getKeyframes().map(({transform,translate,opacity,paddingRight})=>({transform,translate,opacity,paddingRight}))}))))
 const data=[]
 for(const delta of [0,40,80,140,220,320]){
  await page.evaluate(delta=>{for(const a of window.__motions)a.currentTime=delta},delta)
  await page.screenshot({path:`${dir}/open-${delta}.png`})
  data.push({delta,panel:await page.locator('[data-environment-panel-variant] aside').boundingBox()})
 }
 if(Math.abs(data[0].panel.x-data.at(-1).panel.x)<100)throw Error('Reference capture did not contain panel motion; settled images are not accepted')
 writeFileSync(`${out}/environment-tauri-${theme}.json`,JSON.stringify({timing,data},null,2))
 console.log('PASS Tauri Environment',theme,JSON.stringify(timing))
}finally{await browser.close()}
