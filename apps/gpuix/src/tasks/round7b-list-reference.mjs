// Fresh desktop frontend in WebKit; same seed and input positions as the native strip.
import {readFileSync,writeFileSync} from 'node:fs'
const {webkit}=await import('/Users/mymac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs')
const data='/Users/mymac/projects/ade-gpuix-scratch/round7-tasks7b',out='/Users/mymac/projects/ade/previews/gpuix/round7/tasks7b'
const token=readFileSync(`${data}/daemon.token`,'utf8').trim(),label=process.env.R7_LABEL
const task=JSON.parse(readFileSync(`${out}/fixture.json`,'utf8')).find(t=>t.title==='Inbox drag task 1')
const browser=await webkit.launch()
try{
 const ctx=await browser.newContext({viewport:{width:1280,height:820},deviceScaleFactor:2,colorScheme:process.env.KYBERN_APPEARANCE,reducedMotion:process.env.KYBERN_REDUCED_MOTION==='1'?'reduce':'no-preference'})
 const page=await ctx.newPage()
 await page.goto(`http://127.0.0.1:5398/?url=ws://127.0.0.1:4276/ws&token=${token}`)
 await page.addStyleTag({content:'*::-webkit-scrollbar{display:none}'})
 await page.getByRole('button',{name:'Tasks',exact:true}).first().click();await page.getByRole('button',{name:'List',exact:true}).click()
 const row=page.locator(`[data-task-row="${task.id}"]`);await row.waitFor()
 const b=await row.locator('.t').boundingBox(),from={x:b.x+b.width/2,y:b.y+b.height/2}
 const shot=name=>page.screenshot({path:`${out}/${label}-webkit-${name}.png`})
 await shot('list');await page.mouse.move(from.x,from.y);await page.mouse.down()
 const start=performance.now(),samples=[]
 for(let i=1;i<=60;i++){
  await page.mouse.move(from.x,from.y+i*3);await page.evaluate(()=>new Promise(requestAnimationFrame))
  if([1,10,30,60].includes(i)){await shot(`move-${i}`);samples.push({i,at:performance.now()-start})}
 }
 await page.keyboard.press('Escape');await page.mouse.up()
 const end=performance.now()
 for(const at of [0,80,160,300]){await new Promise(r=>setTimeout(r,Math.max(0,end+at-performance.now())));await shot(`cancel-${at}`)}
 writeFileSync(`${out}/${label}-webkit-frames.json`,JSON.stringify({from,samples,kind:'Desktop frontend in WebKit; screenshots separate from timing'}))
}finally{await browser.close()}
