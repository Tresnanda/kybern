// Desktop frontend reference for font-weight-check.ts: widths of the ladder strings in WebKit with the app's system-ui stack.
const { webkit } = await import(process.env.PLAYWRIGHT_CORE)
const browser = await webkit.launch()
try {
  const page = await browser.newPage()
  await page.setContent('<div id="r" style="font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif"></div>')
  const out = await page.evaluate(() => {
    const r = document.getElementById('r'), res = {}
    for (const w of [400, 500, 510, 590, 600, 650, 700]) for (const [kind, size, text] of [['w', 14, `Weight ${w}: The quick brown fox jumps over the lazy dog`], ['s', 12, `12px ${w}: Pending · Needs review · 3 tasks`]]) {
      const s = document.createElement('span'); s.style.cssText = `font-size:${size}px;font-weight:${w};white-space:nowrap`; s.textContent = text; r.appendChild(s); r.appendChild(document.createElement('br'))
      res[`${kind}-${w}`] = s.getBoundingClientRect().width
    }
    return res
  })
  process.stdout.write(JSON.stringify(out))
} finally { await browser.close() }
