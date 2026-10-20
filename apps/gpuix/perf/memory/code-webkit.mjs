// Read-only screenshots of the actual desktop Explorer in headless WebKit.
import path from 'node:path'
import {createRequire} from 'node:module'
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs'
const data=process.env.KYBERN_DATA_DIR, out=path.join(process.env.KYBERN_MEMORY_EVIDENCE,'desktop-reference');mkdirSync(out,{recursive:true})
// Bun owns scratch fixture lifecycle; Vite's native Rolldown binding runs in Node.
if (!process.argv.includes('--worker')) {
 const {seed}=await import('../bench/seed.ts')
 const fixture=await seed(data,4344)
 try {
  writeFileSync(path.join(fixture.manifest.projectPath,'memory-reference.ts'),readFileSync(fixture.manifest.code,'utf8').split('\n').slice(0,120).join('\n'))
  const child=Bun.spawn(['node',import.meta.filename,'--worker'],{env:{...process.env,...fixture.env,KYBERN_REFERENCE_THREAD:fixture.manifest.long3000,KYBERN_REFERENCE_PROJECT:fixture.manifest.projects[0]},stdout:'inherit',stderr:'inherit'})
  const code=await child.exited;if(code!==0)throw Error(`Desktop reference worker exited ${code}`)
 } finally {await fixture.close()}
} else {
const fixture={env:{KYBERN_URL:process.env.KYBERN_URL,KYBERN_TOKEN:process.env.KYBERN_TOKEN},manifest:{long3000:process.env.KYBERN_REFERENCE_THREAD,projects:[process.env.KYBERN_REFERENCE_PROJECT]}}

const desktop=path.resolve(import.meta.dirname,'../../../desktop'),require=createRequire(path.join(desktop,'package.json'))
const {createServer}=await import(require.resolve('vite'))
const {webkit}=await import(process.env.PLAYWRIGHT_CORE??'/Users/mymac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs')
let server,browser
try {
 server=await createServer({root:desktop,configFile:path.join(desktop,'vite.config.ts'),server:{host:'127.0.0.1',port:0}});await server.listen()
 browser=await webkit.launch({headless:true})
 for(const theme of ['dark','light']) for(const file of ['long.ts','memory-reference.ts']){
  const label=`${theme}-${file==='long.ts'?'large':'syntax'}`
  const page=await browser.newPage({viewport:{width:1280,height:820},deviceScaleFactor:2,colorScheme:theme})
  try {
   await page.goto(`${server.resolvedUrls.local[0]}?url=${encodeURIComponent(fixture.env.KYBERN_URL)}&token=${encodeURIComponent(fixture.env.KYBERN_TOKEN)}`)
   await page.getByRole('button',{name:'Pull requests',exact:true}).first().waitFor()
   await page.waitForFunction(async()=>{const {useStore}=await import('/src/state/store.ts');return Object.keys(useStore.getState().projects).length>0})
   await page.evaluate(async({thread,project,file})=>{
    const {useStore}=await import('/src/state/store.ts'),{loadThread}=await import('/src/state/rpc.ts')
    useStore.getState().selectThread(thread);await loadThread(thread)
   },{thread:fixture.manifest.long3000,project:fixture.manifest.projects[0],file})
   await page.locator('[data-message-role]').first().waitFor()
   await page.evaluate(async({project,file})=>{
    const {useStore}=await import('/src/state/store.ts')
    useStore.getState().set({rightOpen:true,rightTabs:['explorer'],rightTab:'explorer',explorerFile:{...useStore.getState().explorerFile,[project]:file}})
   },{thread:fixture.manifest.long3000,project:fixture.manifest.projects[0],file})
   console.log(`Capturing ${label}`)
   const code=page.locator('.editor-file-viewer').first();await code.waitFor();if(file==='memory-reference.ts')await code.locator('.line span').first().waitFor();else await code.locator('pre').first().waitFor()
   await page.waitForTimeout(700)
   await code.screenshot({path:path.join(out,`${label}-code.png`)})
   const geometry=await code.evaluate(el=>{const style=getComputedStyle(el.querySelector('code')??el),tokens=[...el.querySelectorAll('.line span')].slice(0,12).map(e=>({text:e.textContent,color:getComputedStyle(e).color}));return {width:el.clientWidth,height:el.clientHeight,scrollHeight:el.scrollHeight,fontFamily:style.fontFamily,fontSize:style.fontSize,lineHeight:style.lineHeight,tokens}})
   writeFileSync(path.join(out,`${label}-geometry.json`),JSON.stringify(geometry,null,2))
   await code.hover();await page.mouse.wheel(0,540);await page.waitForTimeout(300)
   await code.screenshot({path:path.join(out,`${label}-scrolled.png`)})
  } catch(error) {await page.screenshot({path:path.join(out,`${label}-failure.png`)});writeFileSync(path.join(out,`${label}-failure.txt`),(await page.locator('body').innerText()).slice(0,5000));throw error} finally {await page.close()}
 }
} catch(error) {throw Error(String(error).replaceAll(fixture.env.KYBERN_TOKEN,'[scratch token]'))} finally {await browser?.close();await server?.close()}
}
