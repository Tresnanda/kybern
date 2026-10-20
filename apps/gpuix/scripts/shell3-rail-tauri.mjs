// node scripts/shell3-rail-tauri.mjs [dark|light] — per-frame (rAF) trajectories of the desktop's message rail:
// first hover, glide to another tick, leave, and a transcript scroll. Needs `bun scripts/shell3-up.ts` running.
// Writes /Users/mymac/projects/ade/previews/gpuix/shell3/rail-tauri-<theme>.json
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
const { webkit } = await import(process.env.PLAYWRIGHT_CORE ?? '/Users/mymac/projects/component-kit/node_modules/playwright-core/index.mjs')
const { open } = await import('../visual/screens/conversation.tauri.mjs')
const theme = process.argv[2] ?? 'dark'
const slot = createHash('sha1').update(path.resolve(import.meta.dirname, '../../..')).digest('hex').slice(0, 8)
const state = JSON.parse(readFileSync(`/Users/mymac/projects/ade-gpuix-scratch/visual-pair-${slot}/state.json`, 'utf8'))
const browser = await webkit.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, colorScheme: theme })
const page = await ctx.newPage()
await page.goto(`http://localhost:${state.vitePort}/?url=ws://127.0.0.1:${state.port}/ws&token=${state.token}`)
await page.waitForSelector('button[aria-label="Notes"]')
await page.waitForTimeout(2500)
await page.addStyleTag({ content: '*::-webkit-scrollbar{display:none}' })
await open(page, 'Long review thread')
await page.waitForSelector('[data-slot="preview-rail-item"]')
await page.waitForTimeout(1200)
const items = page.locator('[data-slot="preview-rail-item"]')
const sample = (ms) => page.evaluate(async (ms) => {
  const out = []; const t0 = performance.now()
  await new Promise((done) => {
    const tick = (t) => {
      const ticks = [...document.querySelectorAll('[data-slot="preview-rail-tick"]')].map((e) => +e.getBoundingClientRect().width.toFixed(2))
      const card = document.querySelector('[data-slot="preview-rail-card"]')
      let c = null
      if (card) {
        const r = card.getBoundingClientRect()
        const chain = []
        for (let e = card; e && e.dataset?.slot !== 'preview-rail-card' || e === card; e = e.parentElement) { if (!e || chain.length > 4) break; const cs = getComputedStyle(e); chain.push({ o: +cs.opacity, f: cs.filter, tr: cs.transform }); }
        const wrapper = card.parentElement
        const cs = getComputedStyle(wrapper)
        c = { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(1), h: +r.height.toFixed(1), wrapOpacity: +cs.opacity, wrapFilter: cs.filter, wrapTransform: cs.transform, title: card.querySelector('[data-slot="preview-rail-title"]')?.textContent?.slice(0, 14) }
      }
      out.push({ t: +(t - t0).toFixed(1), ticks, c })
      if (t - t0 < ms) requestAnimationFrame(tick); else done()
    }
    requestAnimationFrame(tick)
  })
  return out
}, ms)
const run = async (name, action, ms = 700) => {
  const p = sample(ms)
  await page.waitForTimeout(40)
  await action()
  return [name, await p]
}
const box = await items.nth(4).boundingBox()
const result = Object.fromEntries([
  await run('hover-first', async () => { await page.mouse.move(box.x + 10, box.y + 7) }),
  await run('glide', async () => { const b = await items.nth(10).boundingBox(); await page.mouse.move(b.x + 10, b.y + 7) }),
  await run('glide-adjacent', async () => { const b = await items.nth(11).boundingBox(); await page.mouse.move(b.x + 10, b.y + 7) }, 500),
  await run('leave', async () => { await page.mouse.move(900, 400) }, 500),
  await run('scroll', async () => { await page.mouse.wheel(0, -900) }, 900),
])
writeFileSync(`/Users/mymac/projects/ade/previews/gpuix/shell3/rail-tauri-${theme}.json`, JSON.stringify(result))
console.log(Object.entries(result).map(([k, v]) => `${k}: ${v.length} frames`).join('\n'))
await browser.close()
