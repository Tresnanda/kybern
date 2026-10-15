// node measure.mjs <screen> <theme> <css selector>... — prints rect (CSS px) and key computed styles
// of matching elements in the Tauri reference, after running the screen's steps.
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
const { webkit } = await import(process.env.PLAYWRIGHT_CORE ?? '/Users/mymac/projects/component-kit/node_modules/playwright-core/index.mjs')
const { screens: base } = await import(path.join(import.meta.dirname, 'screens.tauri.mjs'))
const screens = { ...base }
const sub = path.join(import.meta.dirname, 'screens')
for (const f of readdirSync(sub).filter((x) => x.endsWith('.tauri.mjs')).sort()) Object.assign(screens, (await import(path.join(sub, f))).screens)
const state = JSON.parse(readFileSync(path.join(process.env.VISUAL_SCRATCH ?? `/Users/mymac/projects/ade-gpuix-scratch/visual-pair-${process.env.GPUIX_VISUAL_SLOT ?? createHash('sha1').update(path.resolve(import.meta.dirname, '../../..')).digest('hex').slice(0, 8)}`, 'state.json'), 'utf8'))
const [screen, theme, ...sels] = process.argv.slice(2)
const browser = await webkit.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, colorScheme: theme })
const page = await ctx.newPage()
await page.goto(`http://localhost:${state.vitePort}/?url=ws://127.0.0.1:${state.port}/ws&token=${state.token}`)
await page.waitForSelector('button[aria-label="Notes"]')
await page.waitForTimeout(6000)
await page.addStyleTag({ content: '*::-webkit-scrollbar{display:none}' })
await screens[screen](page)
for (const sel of sels) {
  const out = await page.evaluate((s) => [...document.querySelectorAll(s)].slice(0, 6).map((e) => {
    const r = e.getBoundingClientRect(), c = getComputedStyle(e)
    return { text: (e.textContent || '').trim().slice(0, 24), x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), font: `${c.fontSize}/${c.lineHeight} ${c.fontWeight} ${c.letterSpacing}`, color: c.color, bg: c.backgroundColor, radius: c.borderRadius, pad: c.padding, shadow: c.boxShadow.slice(0, 80) }
  }), sel)
  console.log(sel, JSON.stringify(out, null, 0).replace(/\},\{/g, '},\n  {'))
}
await browser.close()
