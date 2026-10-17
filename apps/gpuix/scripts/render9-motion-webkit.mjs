// Desktop reference for render9 motion strips: the desktop's own `styles/motion.css` (press feedback, t-pop, t-success)
// and the composer's `transition-colors duration-200` in WebKit, laid out like scripts/render9-motion-lab.tsx, with
// every CSS animation/transition paused and stepped to the same offsets the GPUIX strips use.
//   node scripts/render9-motion-webkit.mjs <out dir> <theme> <reduced 0|1> '<tokens json>'
import { readFileSync, mkdirSync } from 'node:fs'
const [out, theme, reduced, tokensJson] = process.argv.slice(2)
const tk = JSON.parse(tokensJson)
mkdirSync(out, { recursive: true })
const motionCss = readFileSync(new URL('../../desktop/src/styles/motion.css', import.meta.url), 'utf8')
const { webkit } = await import(process.env.PLAYWRIGHT_CORE)
const browser = await webkit.launch()
const check = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'
const html = `<!doctype html><html><head><style>${motionCss}
html,body{margin:0;background:${tk.background};font-family:-apple-system,system-ui;}
.kit{position:absolute;left:24px;top:24px;display:flex;gap:16px;align-items:center}
.btn{height:32px;padding:0 11px;box-sizing:border-box;border-radius:10px;border:1px solid transparent;background:${tk.primary};color:${tk.primaryForeground};font-size:14px;font-weight:500;display:inline-flex;align-items:center}
.chrome{width:28px;height:28px;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;color:${tk.iconPrimary};font-size:20px}
.tile{position:absolute;left:24px;top:90px;display:flex;align-items:center;gap:10px;height:56px;width:240px;box-sizing:border-box;padding:0 32px 0 8px;border-radius:12px;border:1px solid ${tk.borderLight};background:${tk.composer}}
.tile .ic{width:40px;height:40px;border-radius:8px;background:${tk.elevated}}
.tile b{display:block;color:${tk.text};font-size:13px;font-weight:500;line-height:16px}.tile i{display:block;font-style:normal;color:${tk.textSecondary};font-size:11px;font-weight:500;line-height:14px;margin-top:2px}
.ok{position:absolute;left:300px;top:90px;width:40px;height:40px;border-radius:20px;background:${tk.success}1f;display:grid;place-items:center;color:${tk.success}}
.drop{position:absolute;left:380px;top:180px;width:200px;height:100px;box-sizing:border-box;border-radius:19.2px;border:1px solid ${tk.cardBorder};background:${tk.composer};transition:color 200ms cubic-bezier(.4,0,.2,1),background-color 200ms cubic-bezier(.4,0,.2,1),border-color 200ms cubic-bezier(.4,0,.2,1)}
.drop.over{border-color:${tk.focus}}
</style></head><body>
<div class="kit"><span id="press-kit" class="btn" data-slot="button">Continue</span><span id="press-chrome" class="chrome" data-slot="button">+</span></div>
<div id="slot-tile"></div><div class="ok" id="slot-ok"></div><div class="drop" id="drop"></div>
</body></html>`
try {
  const ctx = await browser.newContext({ viewport: { width: 640, height: 320 }, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: reduced === '1' ? 'reduce' : 'no-preference' })
  const page = await ctx.newPage()
  await page.setContent(html)
  const shot = (name) => page.screenshot({ path: `${out}/${name}.png` })
  const step = async (offsets, prefix) => {
    for (const o of offsets) {
      await page.evaluate((o) => { for (const a of document.getAnimations()) { a.pause(); a.currentTime = o } }, o)
      await shot(`${prefix}-${String(o).padStart(3, '0')}`)
    }
  }
  // Press: hold the primary button, then release (each transition paused and stepped).
  const b = await page.locator('#press-kit').boundingBox()
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await shot('press-rest')
  await page.mouse.down(); await step([0, 20, 40, 60, 80], 'press-down')
  await page.evaluate(() => { for (const a of document.getAnimations()) a.finish() })
  await page.mouse.up(); await step([0, 50, 100, 150], 'press-up')
  await page.evaluate(() => { for (const a of document.getAnimations()) a.finish() })
  // Attention pop on the attachment tile.
  await page.evaluate(() => { document.getElementById('slot-tile').innerHTML = '<div class="tile t-pop"><div class="ic"></div><div><b>notes.md</b><i>@notes MD</i></div></div>' })
  await step([0, 50, 100, 150, 200, 250], 'pop')
  await page.evaluate(() => { for (const a of document.getAnimations()) a.finish() })
  // Success check.
  await page.evaluate((check) => { document.getElementById('slot-ok').innerHTML = check.replace('<svg', '<svg class="t-success"') }, check)
  await step([0, 100, 200, 300, 400, 500], 'success')
  await page.evaluate(() => { for (const a of document.getAnimations()) a.finish() })
  // Drop highlight in and out.
  await page.evaluate(() => document.getElementById('drop').classList.add('over'))
  await step([0, 50, 100, 150, 200], 'drop-in')
  await page.evaluate(() => { for (const a of document.getAnimations()) a.finish() })
  await page.evaluate(() => document.getElementById('drop').classList.remove('over'))
  await step([0, 50, 100, 150, 200], 'drop-out')
  console.log('webkit frames', out)
} finally { await browser.close() }
