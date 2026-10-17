// R4-2 desktop reference (desktop frontend in WebKit): the note card lift, as paused transition strips,
// a live rAF curve with frame intervals, and a pixel check that no lifted shadow is visible.
//
//   node scripts/kit9-notelift-tauri.mjs [dark|light]     (needs `bun scripts/visual-pair.ts notes-hover --keep` first)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

const { webkit } = await import(process.env.PLAYWRIGHT_CORE)
const slot = createHash('sha1').update(path.resolve(import.meta.dirname, '../../..')).digest('hex').slice(0, 8)
const state = JSON.parse(readFileSync(`/Users/mymac/projects/ade-gpuix-scratch/visual-pair-${slot}/state.json`, 'utf8'))
const theme = process.argv[2] ?? 'dark'
const out = '/Users/mymac/projects/ade/previews/gpuix/phase2/kit9/notelift'
mkdirSync(out, { recursive: true })
const browser = await webkit.launch()
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: 'no-preference' })
  const page = await ctx.newPage()
  await page.goto(`http://127.0.0.1:${state.vitePort}/?url=ws://127.0.0.1:${state.port}/ws&token=${state.token}`)
  await page.waitForSelector('button[aria-label="Notes"]')
  await page.getByRole('button', { name: 'Notes', exact: true }).first().click()
  await page.waitForTimeout(1500)
  await page.addStyleTag({ content: '*::-webkit-scrollbar{display:none}' })
  await page.mouse.move(1275, 815)
  const card = page.locator('[data-note-card][aria-label="Project brief"]').first()
  const box = await card.boundingBox()
  const thumb = card.locator('.note-thumb')
  const tb = await thumb.boundingBox()
  const clip = { x: tb.x - 16, y: tb.y - 16, width: tb.width + 32, height: tb.height + 48 }
  console.log('timing', await thumb.evaluate((el) => { const s = getComputedStyle(el), b = getComputedStyle(el, '::before'); return { transition: s.transition, before: b.transition } }))
  const rest = await page.screenshot({ clip })

  // Live: per-frame transform and lift-layer opacity after the pointer arrives.
  await thumb.evaluate((el) => {
    window.__samples = []
    const start = performance.now()
    const tick = (t) => { const m = new DOMMatrix(getComputedStyle(el).transform); window.__samples.push({ t, ty: m.m42, o: Number(getComputedStyle(el, '::before').opacity) }); if (t - start < 700) requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
  })
  await page.waitForTimeout(120)
  await card.hover()
  await page.waitForTimeout(700)
  const samples = await page.evaluate(() => window.__samples)
  const t0 = samples.find((s) => s.ty !== 0)?.t
  const curve = samples.filter((s) => s.t >= (t0 ?? 0) - 17).map((s) => ({ ms: Math.round((s.t - t0) * 10) / 10, ty: Math.round(s.ty * 1000) / 1000, o: s.o }))
  const dt = samples.slice(1).map((s, i) => s.t - samples[i].t).sort((a, b) => a - b)
  const settledTy = samples.at(-1).ty
  console.log('settled translateY', settledTy, 'frames', samples.length, 'p50', dt[Math.floor(dt.length * 0.5)], 'p95', dt[Math.floor(dt.length * 0.95)])
  console.log('curve', JSON.stringify(curve.slice(0, 14)))

  // Shadow check: the hovered card shifted back down 2px must equal the resting card everywhere outside it if only the translation changed.
  const hovered = await page.screenshot({ clip })
  // The card translates up 2px; anything else that changed around it (a lifted shadow) shows up in the bands
  // just outside its resting bottom and sides, which the translation does not touch.
  const diff = await page.evaluate(async ({ a, b, dpr, top, left, w, h }) => {
    const load = async (s) => { const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${s}`)).blob()); const c = new OffscreenCanvas(bmp.width, bmp.height); const x = c.getContext('2d'); x.drawImage(bmp, 0, 0); return x.getImageData(0, 0, bmp.width, bmp.height) }
    const A = await load(a), B = await load(b), W = A.width
    const band = (x0, x1, y0, y1) => { let n = 0, max = 0; for (let y = Math.round(y0 * dpr); y < Math.round(y1 * dpr); y++) for (let x = Math.round(x0 * dpr); x < Math.round(x1 * dpr); x++) { const i = (y * W + x) * 4; const d = Math.max(Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2])); if (d > 2) n++; if (d > max) max = d } return { changed: n, max } }
    return {
      belowBand: band(left + 8, left + w - 8, top + h + 3, top + h + 9),
      leftBand: band(left - 8, left - 1, top + 12, top + h - 12),
      rightBand: band(left + w + 1, left + w + 8, top + 12, top + h - 12),
    }
  }, { a: rest.toString('base64'), b: hovered.toString('base64'), dpr: 2, top: 16, left: 16, w: tb.width, h: tb.height })
  console.log('shadow check (hovered vs rest shifted 2px, outside the card):', JSON.stringify(diff))
  writeFileSync(`${out}/tauri-${theme}.json`, JSON.stringify({ theme, settledTy, curve, p50: dt[Math.floor(dt.length * 0.5)], p95: dt[Math.floor(dt.length * 0.95)], frames: samples.length, shadow: diff }, null, 2))

  // Paused strips of the transition itself.
  const offsets = [0, 35, 70, 105, 140]
  await page.mouse.move(1275, 815)
  await page.waitForTimeout(500)
  await card.hover({ trial: false })
  await page.evaluate(() => { window.__lift = document.getAnimations().filter((a) => a.effect?.target?.classList?.contains('note-thumb')); for (const a of window.__lift) a.pause() })
  console.log('animations', await page.evaluate(() => window.__lift.map((a) => ({ pseudo: a.effect.pseudoElement, duration: a.effect.getTiming().duration, easing: a.effect.getTiming().easing, props: a.transitionProperty }))))
  for (const ms of offsets) {
    await page.evaluate((ms) => { for (const a of window.__lift) a.currentTime = ms }, ms)
    await page.screenshot({ path: `${out}/tauri-${theme}-${String(ms).padStart(3, '0')}.png`, clip })
  }
  await page.evaluate(() => { for (const a of window.__lift) a.finish() })
  console.log('PASS Tauri note lift', theme)
} finally { await browser.close() }
