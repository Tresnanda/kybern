// node scripts/kit9-controls-probe.mjs <section> [dark|light] [selector...] — computed geometry/colours of desktop kit
// gallery elements (desktop frontend in WebKit), to port exact values. Needs the gallery Vite server (kit9-pair.ts starts it).
const { webkit } = await import(process.env.PLAYWRIGHT_CORE ?? '/Users/mymac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs')
const [section = 'controls', theme = 'dark', ...sels] = process.argv.slice(2)
const browser = await webkit.launch()
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, colorScheme: theme })
  const page = await ctx.newPage()
  await page.goto(`http://127.0.0.1:5791/gallery.html?section=${section}&theme=${theme}`)
  await page.waitForSelector(`[data-gallery="${section}"]`)
  await page.waitForTimeout(800)
  const out = await page.evaluate((sels) => {
    const props = ['width', 'height', 'padding', 'border-width', 'border-color', 'border-radius', 'background-color', 'background-image', 'color', 'font-size', 'font-weight', 'font-family', 'line-height', 'opacity', 'box-shadow', 'transform', 'translate', 'scale', 'transition', 'gap', 'letter-spacing']
    const res = []
    for (const sel of sels) for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect(), s = getComputedStyle(el)
      const o = { sel, tag: el.tagName, cls: (el.getAttribute('class') ?? '').slice(0, 40), text: el.textContent.slice(0, 20), x: r.x, y: r.y, w: r.width, h: r.height }
      for (const p of props) { const v = s.getPropertyValue(p); if (v && v !== 'none' && v !== 'normal' && v !== '0px' && v !== 'rgba(0, 0, 0, 0)') o[p] = v }
      res.push(o)
    }
    return res
  }, sels)
  for (const o of out) console.log(JSON.stringify(o))
} finally { await browser.close() }
