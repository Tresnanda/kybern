// Attention pop, desktop reference (desktop frontend in WebKit): the sidebar "Projects · Pinned" summary's `.t-pop`, paused and
// stepped at the same offsets as kit9-pop.ts.
//   PLAYWRIGHT_CORE=... node scripts/kit9-pop-tauri.mjs [dark|light]     (needs `bun scripts/visual-pair.ts notes-gallery --keep`)
import { readFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
const { webkit } = await import(process.env.PLAYWRIGHT_CORE)
const slot = createHash('sha1').update(path.resolve(import.meta.dirname, '../../..')).digest('hex').slice(0, 8)
const state = JSON.parse(readFileSync(`/Users/mymac/projects/ade-gpuix-scratch/visual-pair-${slot}/state.json`, 'utf8'))
const theme = process.argv[2] ?? 'dark'
const out = '/Users/mymac/projects/ade/previews/gpuix/phase2/kit9/pop'
mkdirSync(out, { recursive: true })
const browser = await webkit.launch()
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: 'no-preference' })
  const page = await ctx.newPage()
  await page.goto(`http://127.0.0.1:${state.vitePort}/?url=ws://127.0.0.1:${state.port}/ws&token=${state.token}`)
  const projects = page.getByText('Projects', { exact: true }).first()
  await projects.waitFor({ timeout: 30000 })
  await projects.hover()
  await page.getByRole('button', { name: 'Filter threads' }).first().click()
  await page.getByRole('menuitemradio', { name: 'Pinned' }).or(page.getByRole('menuitem', { name: 'Pinned' })).first().click()
  const span = page.locator('.t-pop', { hasText: 'Pinned' }).first()
  await span.waitFor()
  await page.evaluate(() => { window.__pop = document.getAnimations().filter((a) => a.animationName === 't-pop'); for (const a of window.__pop) a.pause() })
  console.log('animations', await page.evaluate(() => window.__pop.map((a) => ({ name: a.animationName, duration: a.effect.getTiming().duration, easing: a.effect.getTiming().easing, fill: a.effect.getTiming().fill }))))
  const header = await projects.boundingBox()
  await page.mouse.move(700, 700)
  const clip = { x: 55, y: header.y - 11, width: 280, height: 38 }
  for (const o of [0, 60, 125, 250]) {
    await page.evaluate((o) => { for (const a of window.__pop) a.currentTime = o }, o)
    await page.screenshot({ path: `${out}/tauri-${theme}-${String(o).padStart(3, '0')}.png`, clip })
  }
  console.log('done')
} finally { await browser.close() }
