// Desktop reference for motion10 press strips: the desktop's `styles/motion.css` press rules on replicas of the desktop controls
// (kit `Button` size chip / default = `[data-slot="button"]`, the `press` format button and `DockFooterLink`), laid out like
// motion10-press-lab.tsx, with each transition paused and stepped to the strip offsets. Real mouse down/up.
//   node scripts/motion10-press-webkit.mjs <out dir> <theme> <reduced 0|1> '<tokens json>' '<heading svg>'
import { readFileSync, mkdirSync } from 'node:fs'
const [out, theme, reduced, tokensJson, headingSvg] = process.argv.slice(2)
const tk = JSON.parse(tokensJson)
mkdirSync(out, { recursive: true })
const motionCss = readFileSync(new URL('../../desktop/src/styles/motion.css', import.meta.url), 'utf8')
const { webkit } = await import(process.env.PLAYWRIGHT_CORE)
const browser = await webkit.launch()
const icon = headingSvg.replace('<svg ', '<svg width="14" height="14" ').replace(/stroke="#000"/g, 'stroke="currentColor"').replace(/ width="24" height="24"/, '')
const html = `<!doctype html><html><head><style>${motionCss}
html,body{margin:0;background:${tk.background};font-family:-apple-system,system-ui;}
.c{position:absolute;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;cursor:pointer;border:0}
#press-action{left:24px;top:24px;height:28px;padding:0 8px;border-radius:6px;color:${tk.textSecondary};font-size:11px;background:transparent}
#press-action:hover{background:${tk.hover2}}
#press-env{left:24px;top:72px;height:32px;padding:0 11px;border-radius:10px;border:1px solid transparent;background:${tk.primary};color:${tk.primaryText};font-size:14px;font-weight:500}
#press-format{left:160px;top:24px;width:28px;height:28px;border-radius:7px;color:${tk.textSecondary};background:transparent}
#press-format:hover{background:${tk.hover2}}
#press-footer{left:160px;top:72px;width:168px;height:28px;padding:0 8px;justify-content:flex-start;border-radius:6px;color:${tk.muted};font-size:13px;background:transparent}
#press-footer:hover{background:${tk.hover}}
</style></head><body>
<button class="c" data-slot="button" id="press-action">Stop all</button>
<button class="c" data-slot="button" id="press-env">Connect</button>
<button class="c press" id="press-format">${icon}</button>
<button class="c press" id="press-footer">Show all in Notes</button>
</body></html>`
try {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 140 }, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: reduced === '1' ? 'reduce' : 'no-preference' })
  const page = await ctx.newPage()
  await page.setContent(html)
  const shot = (name) => page.screenshot({ path: `${out}/${name}.png` })
  const step = async (offsets, prefix) => {
    for (const o of offsets) {
      await page.evaluate((o) => { for (const a of document.getAnimations()) { a.pause(); a.currentTime = o } }, o)
      await shot(`${prefix}-${String(o).padStart(3, '0')}`)
    }
  }
  for (const id of ['press-action', 'press-env', 'press-format', 'press-footer']) {
    const b = await page.locator('#' + id).boundingBox()
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.waitForTimeout(50); await shot(`${id}-rest`)
    await page.mouse.down(); await step([0, 20, 40, 60, 80], `${id}-down`)
    await page.evaluate(() => { for (const a of document.getAnimations()) a.finish() })
    await page.mouse.up(); await step([0, 50, 100, 150], `${id}-up`)
    await page.evaluate(() => { for (const a of document.getAnimations()) a.finish() })
  }
  console.log('webkit frames', out)
} finally { await browser.close() }
