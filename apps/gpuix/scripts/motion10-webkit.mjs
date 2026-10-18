// Desktop reference for motion10 strips: the desktop's own `styles/motion.css` with the markup of `CheckIcon className="t-success
// size-5"` in the sign-in success circle (AddAccountSheet) and the kit Checkbox (`components/kit/checkbox.tsx`: indicator
// `transition-[opacity,scale] duration-quick ease-smooth-out` from `data-starting-style` scale .8 / opacity 0, path `t-check-path`),
// in WebKit, every CSS animation/transition paused and stepped to the offsets the GPUIX strips use.
//   node scripts/motion10-webkit.mjs <out dir> <theme> <reduced 0|1> '<tokens json>' '<check svg>'
import { readFileSync, mkdirSync } from 'node:fs'
const [out, theme, reduced, tokensJson, checkSvg] = process.argv.slice(2)
const tk = JSON.parse(tokensJson)
mkdirSync(out, { recursive: true })
const motionCss = readFileSync(new URL('../../desktop/src/styles/motion.css', import.meta.url), 'utf8')
const { webkit } = await import(process.env.PLAYWRIGHT_CORE)
const browser = await webkit.launch()
const check = checkSvg.replace('<svg ', '<svg class="t-success" width="20" height="20" ').replace(/stroke="#000"/g, 'stroke="currentColor"').replace(/ width="24" height="24"/, '')
const box = `<svg width="12" height="12" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="3" viewBox="0 0 24 24"><path class="t-check-path" d="M5.252 12.7 10.2 18.63 18.748 5.37"/></svg>`
const html = `<!doctype html><html><head><style>${motionCss}
html,body{margin:0;background:${tk.background};font-family:-apple-system,system-ui;}
.ok{position:absolute;left:300px;top:90px;width:40px;height:40px;border-radius:20px;background:${tk.success}1f;display:grid;place-items:center;color:${tk.success}}
.ok svg{display:block}
.cb{position:absolute;left:24px;top:24px;width:16px;height:16px;box-sizing:border-box;border-radius:4px;border:1px solid ${tk.borderLight};background:${tk.cbFill};display:inline-flex;align-items:center;justify-content:center}
.ind{position:absolute;inset:-1px;display:flex;align-items:center;justify-content:center;border-radius:4px;color:${tk.primaryForeground};background:${tk.primary};transition:opacity 150ms cubic-bezier(0.22,1,0.36,1),scale 150ms cubic-bezier(0.22,1,0.36,1)}
.ind.start{scale:.8;opacity:0}
@media (prefers-reduced-motion: reduce){.ind{transition:none}}
</style></head><body>
<span class="cb" id="cb"></span><div class="ok" id="slot-ok"></div>
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
  const offsets = JSON.parse(process.env.MOTION10_OFFSETS)
  // Checkbox: the indicator mounts with data-starting-style, then transitions; the path draws (t-check-path).
  await page.evaluate((box) => {
    const ind = document.createElement('span'); ind.className = 'ind start'; ind.innerHTML = box
    document.getElementById('cb').appendChild(ind); ind.getBoundingClientRect(); ind.classList.remove('start')
  }, box)
  await step(offsets.checkbox, 'checkbox')
  await page.evaluate(() => { for (const a of document.getAnimations()) a.finish() })
  await page.evaluate((check) => { document.getElementById('slot-ok').innerHTML = check }, check)
  await step(offsets.success, 'success')
  console.log('webkit frames', out)
} finally { await browser.close() }
