// node tauri-shot.mjs '<json spec>' — captures the desktop web build in WebKit
// (the same engine as Tauri's WKWebView) at 1280x820 @2x, one image per screen.
import path from 'node:path'
import { readdirSync } from 'node:fs'
const { webkit } = await import(process.env.PLAYWRIGHT_CORE ?? '/Users/mymac/projects/component-kit/node_modules/playwright-core/index.mjs')
const { screens: base } = await import(path.join(import.meta.dirname, 'screens.tauri.mjs'))
const screens = { ...base }
const sub = path.join(import.meta.dirname, 'screens')
for (const f of readdirSync(sub).filter((x) => x.endsWith('.tauri.mjs')).sort()) Object.assign(screens, (await import(path.join(sub, f))).screens)
for (const name of ['blur-dialog', 'blur-palette', 'blur-popover']) screens[`${name}-base`] = async p => {
  await screens[name](p)
  await p.keyboard.press('Escape')
  await p.waitForTimeout(600); await p.mouse.move(1275,815)
}
screens['tasks-hover'] = async p => {
  await screens['tasks-list'](p)
  await p.getByText('Fix sidebar collapse jitter on resize', {exact:true}).first().hover()
  await p.waitForTimeout(500)
}
screens['dock-tab-hover'] = async p => {
  await screens['dock-agents'](p)
  await p.getByRole('button', {name:'Agents',exact:true}).hover()
  await p.waitForTimeout(500)
}
screens['dock-base'] = async p => {
  await p.getByText('Dock visual review', {exact:true}).first().click()
  await p.waitForTimeout(1200)
  if (!await p.getByRole('button', {name:'Add panel',exact:true}).count()) await p.keyboard.press('Meta+j')
  await p.waitForTimeout(600); await p.mouse.move(1275,815)
}
const spec = JSON.parse(process.argv[2])
const browser = await webkit.launch()
const fresh = () => browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, colorScheme: spec.theme, reducedMotion: process.env.KYBERN_REDUCED_MOTION === '0' ? 'no-preference' : 'reduce' })
let ctx = await fresh()
let page = await ctx.newPage()
const q = `?url=ws://127.0.0.1:${spec.port}/ws&token=${spec.token}`
await page.goto(`http://127.0.0.1:${spec.vite}/${q}`)
await page.waitForSelector('button[aria-label="Notes"]', { timeout: 30000 })
await page.waitForTimeout(1500)
for (const name of spec.screens) {
  const fn = screens[name]
  if (!fn) { console.log(`[tauri] no step for ${name}`); continue }
  // A fresh context per screen: display and layout choices persist in localStorage.
  await ctx.close()
  ctx = await fresh()
  page = await ctx.newPage()
  await page.goto(`http://127.0.0.1:${spec.vite}/${q}`)
  await page.waitForSelector('button[aria-label="Notes"]', { timeout: 30000 })
  await page.waitForTimeout(1000)
  // macOS overlay scrollbars take no layout width; headless WebKit would draw classic ones.
  await page.addStyleTag({ content: '*::-webkit-scrollbar{display:none}' })
  await fn(page)
  await page.screenshot({ path: path.join(spec.out, `${name}-${spec.theme}-tauri.png`) })
  console.log(`[tauri] ${name}`)
}
await browser.close()
