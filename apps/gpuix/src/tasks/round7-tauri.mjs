// Actual desktop frontend in Playwright WebKit, following scripts/drag-tauri.mjs.
// This is a WKWebView-engine reference, not the packaged native Tauri shell.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
const {webkit}=await import(process.env.PLAYWRIGHT_CORE ?? '/Users/mymac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs')
const data='/Users/mymac/projects/ade-gpuix-scratch/round7-tasks'
const root='/Users/mymac/projects/ade/previews/gpuix/round7/tasks'
const token=readFileSync(`${data}/daemon.token`,'utf8').trim()
const browser=await webkit.launch()
const titles=JSON.parse(readFileSync(`${root}/fixture.json`,'utf8'))
const task=titles.find(t=>t.title.startsWith('Mobile parity'))
try {
for(const theme of ['dark','light'])for(const reduced of [false,true])for(const width of [1280,1920]){
 const label=`${theme}-${reduced?'reduced':'normal'}-${width}`
 const ctx=await browser.newContext({viewport:{width,height:820},deviceScaleFactor:2,colorScheme:theme,reducedMotion:reduced?'reduce':'no-preference'})
 const page=await ctx.newPage()
 try{
 await page.goto(`http://127.0.0.1:5397/?url=ws://127.0.0.1:4272/ws&token=${token}`)
 // Native macOS overlay scrollbars reserve no width. Headless WebKit otherwise
 // takes 10px from every column and gives the title a different wrap width.
 await page.addStyleTag({content:'*::-webkit-scrollbar{display:none}'})
 await page.getByRole('button',{name:'Tasks',exact:true}).first().click()
 await page.evaluate(async()=>{const {rpc}=await import('/src/state/rpc.ts');const client=rpc();const {tasks}=await client.call('tasks.items.list',{});for(const task of tasks.filter(t=>t.title==='Round7 saved task'))await client.call('tasks.items.delete',{id:task.id});const mobile=tasks.find(t=>t.title.startsWith('Mobile parity')),wide=tasks.find(t=>t.title.startsWith('WWWW'));await client.call('tasks.items.update',{id:mobile.id,status:'todo',before_id:wide.id})})
 await page.getByRole('button',{name:'Board',exact:true}).click()
 await page.locator(`[data-task-card="${task.id}"]`).waitFor()
 await page.mouse.move(width-5,815)
 await page.screenshot({path:`${root}/${label}-tauri-board.png`})
 const geometry=await page.locator('[data-task-card]').evaluateAll(nodes=>nodes.map(n=>({id:n.dataset.taskCard,card:n.getBoundingClientRect().toJSON(),title:n.querySelector('.tt')?.getBoundingClientRect().toJSON()})))
 writeFileSync(`${root}/${label}-tauri-geometry.json`,JSON.stringify(geometry,null,2))
 await page.getByRole('button',{name:'New task in To do',exact:true}).click()
 await page.getByPlaceholder('Task title').waitFor()
 await page.screenshot({path:`${root}/${label}-tauri-quick.png`})
 await page.keyboard.press('Escape')
 await page.screenshot({path:`${root}/${label}-tauri-cancel.png`})
 for(const view of ['Board','List']){
  await page.getByRole('button',{name:view,exact:true}).click()
  await page.getByRole('button',{name:'New task in To do',exact:true}).click()
  await page.getByPlaceholder('Task title').fill('Round7 saved task')
  await page.keyboard.press('Enter')
  const saved=page.locator('[data-task-card],[data-task-row]').filter({hasText:'Round7 saved task'}).first()
  await saved.waitFor();await page.keyboard.press('Escape');await saved.scrollIntoViewIfNeeded()
  await page.screenshot({path:`${root}/${label}-tauri-${view.toLowerCase()}-save.png`})
  await page.evaluate(async()=>{
   const {rpc}=await import('/src/state/rpc.ts')
   const client=rpc(),{tasks}=await client.call('tasks.items.list',{})
   for(const task of tasks.filter(t=>t.title==='Round7 saved task'))await client.call('tasks.items.delete',{id:task.id})
  })
 }
 await page.getByRole('button',{name:'Board',exact:true}).click()
 const card=page.locator(`[data-task-card="${task.id}"]`)
 await card.scrollIntoViewIfNeeded()
 // Same first drop as GPUIX: Mobile parity moves 220px down within To do.
 const mobileTitle=await card.locator('.tt').boundingBox(),mobileFrom={x:mobileTitle.x+mobileTitle.width/2,y:mobileTitle.y+mobileTitle.height/2}
 const dropDir=`${root}/${label}-tauri-drop`;mkdirSync(dropDir,{recursive:true})
 await page.mouse.move(mobileFrom.x,mobileFrom.y);await page.mouse.down()
 for(let i=1;i<=60;i++){await page.mouse.move(mobileFrom.x,mobileFrom.y+220*i/60);await page.evaluate(()=>new Promise(requestAnimationFrame));if([1,10,30,60].includes(i))await page.screenshot({path:`${dropDir}/move-${i}.png`})}
 await page.mouse.up()
 const dropStart=performance.now(),dropFrames=[]
 for(const at of [0,80,160,300]){await new Promise(r=>setTimeout(r,Math.max(0,dropStart+at-performance.now())));await page.screenshot({path:`${dropDir}/drop-${at}.png`});dropFrames.push({at,actual:performance.now()-dropStart})}
 writeFileSync(`${dropDir}/frames.json`,JSON.stringify(dropFrames))
 // Same cancel strip as GPUIX: title pickup on Inbox task 1, +240px/+180px.
 const cancelTask=titles.find(t=>t.title==='Inbox drag task 1')
 const b=await page.locator(`[data-task-card="${cancelTask.id}"] .tt`).boundingBox(),from={x:b.x+b.width/2,y:b.y+b.height/2}
 const to={x:from.x+240,y:from.y+180}
 const dir=`${root}/${label}-tauri-drag`;mkdirSync(dir,{recursive:true})
 await page.mouse.move(from.x,from.y);await page.mouse.down()
 const times=[];await page.evaluate(()=>{window.__r7=[];window.__r7Live=true;const tick=t=>{if(window.__r7Live){window.__r7.push(t);requestAnimationFrame(tick)}};requestAnimationFrame(tick)})
 for(let i=1;i<=60;i++){
  const u=i/60;await page.mouse.move(from.x+(to.x-from.x)*u,from.y+(to.y-from.y)*u)
  await page.evaluate(()=>new Promise(requestAnimationFrame))
  if([1,10,30,60].includes(i))await page.screenshot({path:`${dir}/move-${i}.png`})
 }
 const raf=await page.evaluate(()=>{window.__r7Live=false;return window.__r7})
 await page.keyboard.press('Escape');await page.mouse.up()
 const cancelStart=performance.now()
 for(const at of [0,80,160,300]){await new Promise(r=>setTimeout(r,Math.max(0,cancelStart+at-performance.now())));const start=performance.now();await page.screenshot({path:`${dir}/cancel-${at}.png`});times.push({at,time:performance.now()-cancelStart,cost:performance.now()-start})}
 // Measure separately from the screenshot strip: capture overhead must not be
 // counted as animation cadence. The first drag was cancelled, so layout agrees.
 await page.mouse.move(from.x,from.y);await page.mouse.down()
 await page.evaluate(()=>{window.__r7=[];window.__r7Live=true;const tick=t=>{if(window.__r7Live){window.__r7.push(t);requestAnimationFrame(tick)}};requestAnimationFrame(tick)})
 for(let i=1;i<=90;i++){
  await page.mouse.move(from.x+(to.x-from.x)*i/90,from.y+(to.y-from.y)*i/90)
  await page.evaluate(()=>new Promise(requestAnimationFrame))
 }
 const pacing=await page.evaluate(()=>{window.__r7Live=false;return window.__r7})
 await page.keyboard.press('Escape');await page.mouse.up()
 const intervals=pacing.slice(1).map((t,i)=>t-pacing[i]).sort((a,b)=>a-b)
 writeFileSync(`${root}/${label}-tauri-pacing.json`,JSON.stringify({kind:'Screenshot-free WebKit rAF callbacks, not OS display presents',frames:pacing.length,p50:intervals[Math.floor(intervals.length*.5)],p95:intervals[Math.floor(intervals.length*.95)],stripFrames:raf.length,times},null,2))
 console.log('reference',label)
 }finally{await ctx.close()}
}
}finally{await browser.close()}
