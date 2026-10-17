import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import path from 'node:path'
const {webkit}=await import(process.env.PLAYWRIGHT_CORE)
const spec=JSON.parse(process.argv[2]),out='/Users/mymac/projects/ade/previews/gpuix/round3-resume/shell'
const slot=createHash('sha1').update(path.resolve(import.meta.dirname,'../../..')).digest('hex').slice(0,8)
const state=JSON.parse(readFileSync(`/Users/mymac/projects/ade-gpuix-scratch/visual-pair-${slot}/state.json`,'utf8'))
const browser=await webkit.launch()
try{
 for(const screen of ['usage','pr']){
  const ctx=await browser.newContext({viewport:{width:1280,height:820},deviceScaleFactor:2,colorScheme:spec.theme,reducedMotion:'reduce'})
  const page=await ctx.newPage()
  await page.goto(`http://localhost:${state.vitePort}/?url=${encodeURIComponent(spec.url)}&token=local-fixture`)
  await page.getByRole('button',{name:'Usage',exact:true}).waitFor()
  if(screen==='usage'){await page.getByRole('button',{name:'Usage',exact:true}).click()}
  else{
   await page.getByRole('button',{name:'Pull requests',exact:true}).first().click()
   const target=page.locator('[data-pr-row]').filter({hasText:'Review change 2'}).first()
   await target.click({timeout:8000}).catch(async e=>{await page.screenshot({path:`${out}/pr-reference-failure.png`});console.error((await page.locator('body').innerText()).slice(0,3000));throw e});await target.press('ArrowUp')
  }
  await page.mouse.move(1275,815);await page.waitForTimeout(500)
  await page.screenshot({path:`${out}/${screen}-${spec.theme}-tauri.png`})
  await ctx.close()
 }
}finally{await browser.close()}
