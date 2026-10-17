// Sidebar hover marquee, desktop reference (desktop frontend in WebKit): the pan as paused CSS transition strips at the same
// offsets as kit9-marquee.ts (desktop d = pointer arrival + d ms; GPUIX clock offset = d - 190), then the pan back.
//   node scripts/kit9-marquee-tauri.mjs [dark|light]     (needs the seeded scratch daemon: `bun scripts/visual-pair.ts notes-gallery --keep`)
import { readFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
const { webkit } = await import(process.env.PLAYWRIGHT_CORE)
const slot = createHash('sha1').update(path.resolve(import.meta.dirname, '../../..')).digest('hex').slice(0, 8)
const state = JSON.parse(readFileSync(`/Users/mymac/projects/ade-gpuix-scratch/visual-pair-${slot}/state.json`, 'utf8'))
const theme = process.argv[2] ?? 'dark'
const out = '/Users/mymac/projects/ade/previews/gpuix/phase2/kit9/marquee'
mkdirSync(out, { recursive: true })
const browser = await webkit.launch()
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: 'no-preference' })
  const page = await ctx.newPage()
  await page.goto(`http://127.0.0.1:${state.vitePort}/?url=ws://127.0.0.1:${state.port}/ws&token=${state.token}`)
  const host = page.locator('[data-marquee-host]', { hasText: 'A very long thread title' }).first()
  await host.waitFor({ timeout: 30000 })
  await page.addStyleTag({ content: '*::-webkit-scrollbar{display:none}' })
  await page.mouse.move(700, 600)
  await page.waitForTimeout(800)
  const b = await host.boundingBox()
  const clip = { x: b.x - 4, y: b.y - 2, width: b.width + 8, height: b.height + 4 }
  console.log('row', JSON.stringify(b))
  const span = host.locator('.t-marquee > span').first()
  console.log('css', await span.evaluate((el) => ({ transition: getComputedStyle(el).transition, shift: el.parentElement.style.getPropertyValue('--marquee-shift'), dur: el.parentElement.style.getPropertyValue('--marquee-dur') })))
  await host.hover()
  await page.waitForTimeout(100)
  await page.evaluate(() => { window.__a = document.getAnimations().filter((a) => a.transitionProperty === 'transform'); for (const a of window.__a) a.pause() })
  console.log('animations', await page.evaluate(() => window.__a.map((a) => ({ prop: a.transitionProperty, duration: a.effect.getTiming().duration, delay: a.effect.getTiming().delay, easing: a.effect.getTiming().easing }))))
  for (const d of [190, 350, 1350, 2350, 3350, 8190]) {
    await page.evaluate((d) => { for (const a of window.__a) a.currentTime = d }, d)
    await page.screenshot({ path: `${out}/tauri-${theme}-pan-${String(d).padStart(4, '0')}.png`, clip })
  }
  // The pan back, live: rest on the row for 2.5 s (the pan is under way), leave, sample the label's translateX every frame.
  await page.evaluate(() => { for (const a of window.__a) a.cancel() })
  await page.mouse.move(700, 600)
  await page.waitForTimeout(300)
  await host.hover()
  await page.waitForTimeout(2500)
  await span.evaluate((el) => { window.__samples = []; window.__t0 = performance.now(); const tx = () => new DOMMatrix(getComputedStyle(el).transform).m41; const frame = (t) => { window.__samples.push({ ms: Math.round(t - window.__t0), tx: Math.round(tx() * 100) / 100 }); if (t - window.__t0 < 700) requestAnimationFrame(frame) }; requestAnimationFrame(frame) })
  await page.mouse.move(700, 600)
  await page.waitForTimeout(800)
  const samples = await page.evaluate(() => window.__samples)
  /*
    const tx = () => new DOMMatrix(getComputedStyle(el).transform).m41
    const frame = (t) => { out.push({ ms: Math.round(t - t0), tx: Math.round(tx() * 100) / 100 }); if (t - t0 < 700) requestAnimationFrame(frame); else resolve(out) }
    requestAnimationFrame(frame)
  })) */
  console.log('back curve (translateX px by ms after leaving; starts mid-pan):', JSON.stringify(samples.filter((_, i) => i % 3 === 0)))
  console.log('done')
} finally { await browser.close() }
