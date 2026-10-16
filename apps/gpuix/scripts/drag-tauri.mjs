// node drag-tauri.mjs [scenario...]  — Tauri (WebKit) reference strips + rAF pacing for the 4 drag scenarios.
// Needs: scratch daemon (DRAG_DATA, default drag-data) and a Vite server for apps/desktop (VITE_PORT, default 5391).
// Real-time capture: dnd-kit overlays/drop animations run on CSS/WAAPI, which page.clock does not control,
// so frames are real screenshots with performance.now() timestamps (steps.json per strip).
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
const { webkit } = await import(process.env.PLAYWRIGHT_CORE ?? '/Users/mymac/projects/component-kit/node_modules/playwright-core/index.mjs')
const data = process.env.DRAG_DATA ?? '/Users/mymac/projects/ade-gpuix-scratch/drag-data'
const vite = process.env.VITE_PORT ?? '5391'
const port = readFileSync(path.join(data, 'daemon.port'), 'utf8').trim()
const token = readFileSync(path.join(data, 'daemon.token'), 'utf8').trim()
const out = process.env.DRAG_OUT ?? '/Users/mymac/projects/ade/previews/gpuix/drag/tauri'
const names = process.argv.slice(2).length ? process.argv.slice(2) : ['tasks-board', 'tasks-list', 'split', 'projects']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await webkit.launch()

async function open() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, colorScheme: process.env.KYBERN_APPEARANCE ?? 'dark' })
  const page = await ctx.newPage()
  await page.addInitScript(() => {
    window.__raf = []; window.__rafOn = false
    const tick = (t) => { if (window.__rafOn) window.__raf.push(t); requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
  })
  await page.goto(`http://localhost:${vite}/?url=ws://127.0.0.1:${port}/ws&token=${token}`)
  await page.waitForSelector('button[aria-label="Notes"]', { timeout: 30000 })
  await page.addStyleTag({ content: '*::-webkit-scrollbar{display:none}' })
  await sleep(1500)
  return { ctx, page }
}
const center = async (loc) => { const b = await loc.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } }
const path2 = (a, b, n) => Array.from({ length: n }, (_, i) => { const u = (i + 1) / n, e = u * u * (3 - 2 * u); return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e } })

const setups = {
  async 'tasks-board'(page) {
    await page.locator('button[aria-label="Tasks"]').first().click(); await sleep(500)
    await page.locator('button[aria-label="Board"]').click(); await sleep(800)
    const card = page.locator('[data-task-card]', { hasText: 'Drag task' }).nth(1)
    const from = await center(card)
    const col = await page.locator('section.tk-col[aria-label^="Todo"], section.tk-col[data-column*="todo"]').first().boundingBox()
    return { from, to: { x: col.x + col.width / 2, y: col.y + 150 } }
  },
  async 'tasks-list'(page) {
    await page.locator('button[aria-label="Tasks"]').first().click(); await sleep(500)
    await page.locator('button[aria-label="List"]').click(); await sleep(800)
    const row = page.locator('[data-task-row]', { hasText: 'Drag task' }).nth(1)
    const from = await center(row)
    return { from, to: { x: from.x, y: from.y + 200 } }
  },
  async split(page) {
    await page.getByText('alpha-app thread 1', { exact: true }).first().click(); await sleep(1500)
    const from = await center(page.getByText('alpha-app thread 2', { exact: true }).first())
    return { from, to: { x: 1100, y: 420 } }
  },
  async projects(page) {
    const a = page.locator('[data-project-id]', { hasText: 'alpha-app' }).first()
    const b = page.locator('[data-project-id]', { hasText: 'beta-docs' }).first()
    const from = await center(a.getByText('alpha-app', { exact: true }).first()), bb = await b.boundingBox()
    return { from, to: { x: from.x, y: bb.y + bb.height + 10 } } // projects are expanded: drop just past beta-docs' block
  },
}
async function strip(page, plan, dir, cancel) {
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true })
  const log = []; let n = 0
  const t0 = Date.now()
  const selected = process.env.DRAG_CAPTURE_FRAMES?.split(',').map(Number)
  const shot = async (label) => { const t = Date.now() - t0; if (!selected || selected.includes(n)) await page.screenshot({ path: `${dir}/${String(n).padStart(2, '0')}.png`, scale: 'css' }); log.push({ n: n++, t, label }) }
  await page.mouse.move(plan.from.x, plan.from.y); await page.waitForTimeout(40); await page.mouse.down(); await shot('press')
  for (const p of path2(plan.from, plan.to, 12)) { await page.mouse.move(p.x, p.y); await sleep(16); await shot('move') }
  for (let i = 0; i < 6; i++) { await sleep(16); await shot('hold') }
  if (cancel) await page.keyboard.press('Escape'); else await page.mouse.up()
  log.push({ n: n, t: Date.now() - t0, label: cancel ? 'escape' : 'release' })
  for (let i = 0; i < 16; i++) { await sleep(16); await shot('settle') }
  if (cancel) await page.mouse.up()
  writeFileSync(`${dir}/steps.json`, JSON.stringify(log))
}
async function pacing(page, plan) {
  await page.mouse.move(plan.from.x, plan.from.y); await page.waitForTimeout(40); await page.mouse.down()
  await page.evaluate(() => { window.__raf.length = 0; window.__rafOn = true })
  for (const p of path2(plan.from, plan.to, 90)) { await page.mouse.move(p.x, p.y); await sleep(8) }
  const ticks = await page.evaluate(() => { window.__rafOn = false; return window.__raf })
  await page.mouse.up(); await sleep(600)
  const d = ticks.slice(1).map((t, i) => t - ticks[i]).sort((a, b) => a - b)
  const q = (f) => +d[Math.min(d.length - 1, Math.floor(d.length * f))].toFixed(2)
  return { p50: q(0.5), p95: q(0.95), max: +d[d.length - 1].toFixed(2), frames: ticks.length }
}
const pacingFile = path.join(out, 'pacing.json')
let all = {}; try { all = JSON.parse(readFileSync(pacingFile, 'utf8')) } catch {}
for (const name of names) {
  for (const mode of (process.env.DRAG_MODES?.split(',') ?? ['drop', 'cancel', 'pacing'])) {
    const { ctx, page } = await open()
    try {
      const plan = await setups[name](page)
      if (mode === 'pacing') all[name] = await pacing(page, plan)
      else await strip(page, plan, `${out}/${name}${mode === 'cancel' ? '-cancel' : ''}`, mode === 'cancel')
      console.log('done', name, mode, mode === 'pacing' ? JSON.stringify(all[name]) : '')
    } catch (e) { console.log('FAILED', name, mode, e.message.split('\n')[0]) }
    await ctx.close()
  }
}
writeFileSync(pacingFile, JSON.stringify(all, null, 1))
await browser.close()
