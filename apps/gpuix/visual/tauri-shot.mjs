// node tauri-shot.mjs '<json spec>' — captures the desktop web build in WebKit
// (the same engine as Tauri's WKWebView) at 1280x820 @2x, one image per screen.
import path from 'node:path'
const { webkit } = await import(process.env.PLAYWRIGHT_CORE ?? '/Users/mymac/projects/component-kit/node_modules/playwright-core/index.mjs')
const { screens } = await import(path.join(import.meta.dirname, 'screens.tauri.mjs'))
const spec = JSON.parse(process.argv[2])
const browser = await webkit.launch()
const fresh = () => browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, colorScheme: spec.theme })
let ctx = await fresh()
let page = await ctx.newPage()
const q = `?url=ws://127.0.0.1:${spec.port}/ws&token=${spec.token}`
await page.goto(`http://localhost:${spec.vite}/${q}`)
await page.waitForSelector('button[aria-label="Notes"]', { timeout: 30000 })
await page.waitForTimeout(1500)
for (const name of spec.screens) {
  const fn = screens[name]
  if (!fn) { console.log(`[tauri] no step for ${name}`); continue }
  // A fresh context per screen: display and layout choices persist in localStorage.
  await ctx.close()
  ctx = await fresh()
  page = await ctx.newPage()
  await page.goto(`http://localhost:${spec.vite}/${q}`)
  await page.waitForSelector('button[aria-label="Notes"]', { timeout: 30000 })
  await page.waitForTimeout(1000)
  // macOS overlay scrollbars take no layout width; headless WebKit would draw classic ones.
  await page.addStyleTag({ content: '*::-webkit-scrollbar{display:none}' })
  await fn(page)
  await page.screenshot({ path: path.join(spec.out, `${name}-${spec.theme}-tauri.png`) })
  console.log(`[tauri] ${name}`)
}
await browser.close()
