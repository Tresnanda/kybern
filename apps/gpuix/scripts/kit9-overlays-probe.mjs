// node kit9-overlays-probe.mjs '<json spec>' — reads the desktop kit gallery's geometry, computed styles and
// running animations after a few user steps, so the GPUIX ports copy measured numbers rather than guesses.
// spec: { vite, theme, section, steps: [{ click|hover|press|type|wait }], dump: [selector], anim?: bool }
const { webkit } = await import(process.env.PLAYWRIGHT_CORE)
const spec = JSON.parse(process.argv[2])
const browser = await webkit.launch()
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, colorScheme: spec.theme ?? 'dark' })
  const page = await ctx.newPage()
  await page.goto(`http://127.0.0.1:${spec.vite ?? 5791}/gallery.html?section=${spec.section}&theme=${spec.theme ?? 'dark'}`)
  await page.waitForSelector(`[data-gallery="${spec.section}"]`)
  await page.waitForTimeout(300)
  let anims = []
  for (const s of spec.steps ?? []) {
    if (s.click) await page.locator(s.click).first().click()
    if (s.hover) await page.locator(s.hover).first().hover()
    if (s.press) await page.keyboard.press(s.press)
    if (s.type) await page.keyboard.type(s.type)
    if (s.wait) await page.waitForTimeout(s.wait)
    if (s.anim) {
      anims = await page.evaluate(() => document.getAnimations().map((a) => {
        const t = a.effect?.getTiming?.() ?? {}
        const el = a.effect?.target
        return { prop: a.transitionProperty ?? a.animationName, duration: t.duration, delay: t.delay, easing: t.easing, slot: el?.getAttribute?.('data-slot'), keyframes: a.effect?.getKeyframes?.() }
      }))
      console.log('ANIM', s.anim, JSON.stringify(anims))
    }
  }
  await page.waitForTimeout(spec.settle ?? 600)
  const out = await page.evaluate((sels) => {
    const props = ['display', 'width', 'height', 'padding', 'margin', 'gap', 'borderRadius', 'borderWidth', 'borderTopWidth', 'borderLeftWidth', 'borderColor', 'borderTopColor', 'backgroundColor', 'color', 'fontSize', 'fontWeight', 'lineHeight', 'fontFamily', 'boxShadow', 'opacity', 'transform', 'letterSpacing', 'transition']
    const res = []
    for (const sel of sels) for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el)
      const o = { sel, slot: el.getAttribute('data-slot'), tag: el.tagName, text: (el.innerText ?? '').slice(0, 40), rect: [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 100) / 100) }
      for (const p of props) o[p] = cs[p]
      const b = getComputedStyle(el, '::before')
      if (b.content !== 'none') o.before = { boxShadow: b.boxShadow, bg: b.backgroundColor }
      res.push(o)
    }
    return res
  }, spec.dump ?? [])
  for (const o of out) console.log(JSON.stringify(o))
} finally { await browser.close() }
