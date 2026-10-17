// Theme cross-fade, desktop reference (desktop frontend in WebKit): Settings > Appearance, dark -> light, with the view
// transition's animations paused and stepped at the same offsets as kit9-themefade.ts; prints the centre pixel luminance.
//   PLAYWRIGHT_CORE=... node scripts/kit9-themefade-tauri.mjs     (needs the seeded scratch daemon + Vite: visual-pair --keep)
import { readFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
const { webkit } = await import(process.env.PLAYWRIGHT_CORE)
const slot = createHash('sha1').update(path.resolve(import.meta.dirname, '../../..')).digest('hex').slice(0, 8)
const state = JSON.parse(readFileSync(`/Users/mymac/projects/ade-gpuix-scratch/visual-pair-${slot}/state.json`, 'utf8'))
const out = '/Users/mymac/projects/ade/previews/gpuix/phase2/kit9/themefade'
mkdirSync(out, { recursive: true })
const browser = await webkit.launch()
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, colorScheme: 'dark', reducedMotion: 'no-preference' })
  const page = await ctx.newPage()
  await page.goto(`http://127.0.0.1:${state.vitePort}/?url=ws://127.0.0.1:${state.port}/ws&token=${state.token}`)
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click()
  await page.getByText('Appearance', { exact: true }).first().click()
  await page.waitForTimeout(600)
  await page.getByRole('radio', { name: /Dark/ }).first().click().catch(async () => { await page.getByText('Dark', { exact: true }).first().click() })
  await page.waitForTimeout(900)
  console.log('has startViewTransition', await page.evaluate(() => typeof document.startViewTransition))
  await page.evaluate(() => { window.__fade = null; const orig = document.startViewTransition.bind(document); document.startViewTransition = (cb) => { const t = orig(cb); window.__fade = t; return t } })
  const lum = async (name) => { const p = `${out}/tauri-${name}.png`; await page.screenshot({ path: p }); return p }
  await (page.getByRole('radio', { name: /Light/ }).first().click().catch(async () => { await page.getByText('Light', { exact: true }).first().click() }))
  await page.waitForTimeout(10)
  const anims = await page.evaluate(async () => { await window.__fade?.ready; const a = document.getAnimations().filter((x) => String(x.effect?.pseudoElement ?? '').includes('view-transition')); window.__vt = a; for (const x of a) x.pause(); return a.map((x) => ({ pseudo: x.effect.pseudoElement, duration: x.effect.getTiming().duration, easing: x.effect.getTiming().easing })) })
  console.log('view-transition animations', JSON.stringify(anims))
  for (const o of [0, 35, 70, 105, 140, 210, 280, 350]) {
    await page.evaluate((o) => { for (const x of window.__vt) x.currentTime = Math.min(o, 280) }, o)
    await lum(String(o).padStart(3, '0'))
  }
  console.log('done')
} finally { await browser.close() }
