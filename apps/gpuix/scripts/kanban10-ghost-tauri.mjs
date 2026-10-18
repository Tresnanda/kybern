// node scripts/kanban10-ghost-tauri.mjs [scenario...] — desktop frontend in WebKit: frame strips for dragging
// tall and short task cards past each other (kanban10-seed.ts data). Pair: scripts/kanban10-ghost.ts.
// Needs: the scratch daemon (GAP_DATA) and a Vite server for apps/desktop (VITE_PORT).
// dnd-kit's sort and drop transitions are CSS/WAAPI, so frames are real-time screenshots
// with performance timestamps (steps.json per strip), not a paused clock.
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
const { webkit } = await import(process.env.PLAYWRIGHT_CORE ?? '/Users/mymac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs')
const data = process.env.GAP_DATA
if (!data?.includes('gpuix-scratch')) throw new Error('GAP_DATA must be a gpuix-scratch daemon dir')
const vite = process.env.VITE_PORT ?? '5410'
const port = readFileSync(path.join(data, 'daemon.port'), 'utf8').trim()
const token = readFileSync(path.join(data, 'daemon.token'), 'utf8').trim()
const theme = process.env.KYBERN_APPEARANCE ?? 'dark'
const reduced = process.env.KYBERN_REDUCED_MOTION === '1'
const out = process.env.GAP_OUT ?? `/Users/mymac/projects/ade/previews/gpuix/phase2/kanban10/tauri-${theme}${reduced ? '-reduced' : ''}`
const { SCENARIOS } = await import('./kanban10-scenarios.mjs')
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCENARIOS)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await webkit.launch()
const path2 = (a, b, n) => Array.from({ length: n }, (_, i) => { const u = (i + 1) / n, e = u * u * (3 - 2 * u); return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e } })

async function open(view) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: reduced ? 'reduce' : 'no-preference' })
  const page = await ctx.newPage()
  await page.goto(`http://localhost:${vite}/?url=ws://127.0.0.1:${port}/ws&token=${token}`)
  await page.waitForSelector('button[aria-label="Notes"]', { timeout: 30000 })
  await page.addStyleTag({ content: '*::-webkit-scrollbar{display:none}' })
  await sleep(1200)
  await page.locator('button[aria-label="Tasks"]').first().click(); await sleep(500)
  await page.locator(`button[aria-label="${view === 'board' ? 'Board' : 'List'}"]`).click(); await sleep(800)
  return { ctx, page }
}
const item = (page, view, title) => page.locator(view === 'board' ? '[data-task-card]' : '[data-task-row]', { hasText: title }).first()
const box = async (loc) => loc.boundingBox()

async function plan(page, s) {
  const src = await box(item(page, s.view, s.drag)), over = await box(item(page, s.view, s.over))
  const from = { x: src.x + src.width / 2, y: src.y + Math.min(20, src.height / 2) }
  const to = { x: over.x + over.width / 2, y: s.edge === 'top' ? over.y + 4 : over.y + over.height - 4 }
  return { from, to, src, over }
}
async function strip(page, s, p, dir) {
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true })
  const log = []; let n = 0
  const t0 = Date.now()
  const shot = async (label) => { const t = Date.now() - t0; await page.screenshot({ path: `${dir}/${String(n).padStart(2, '0')}.png`, scale: 'css' }); log.push({ n: n++, t, label }) }
  await page.mouse.move(p.from.x, p.from.y); await sleep(40); await page.mouse.down(); await shot('press')
  for (const q of path2(p.from, p.to, 12)) { await page.mouse.move(q.x, q.y); await sleep(16); await shot('move') }
  for (let i = 0; i < 6; i++) { await sleep(16); await shot('hold') }
  // Peek: the pointer slides sideways inside the same card, so the overlay uncovers the slot.
  await page.mouse.move(p.to.x + 70, p.to.y)
  for (let i = 0; i < 3; i++) { await sleep(16); await shot('peek') }
  await sleep(250)
  await page.mouse.up()
  log.push({ n, t: Date.now() - t0, label: 'release' })
  for (let i = 0; i < 16; i++) { await sleep(16); await shot('settle') }
  writeFileSync(`${dir}/steps.json`, JSON.stringify({ plan: p, log }))
}
for (const name of names) {
  const s = SCENARIOS[name]
  execFileSync('bun', ['scripts/kanban10-seed.ts'], { env: { ...process.env, KYBERN_DATA_DIR: data } })
  const { ctx, page } = await open(s.view)
  try {
    const p = await plan(page, s)
    await strip(page, s, p, `${out}/${name}`)
    console.log('done', name)
  } catch (e) { console.log('FAILED', name, e.message.split('\n')[0]) }
  await ctx.close()
}
await browser.close()
