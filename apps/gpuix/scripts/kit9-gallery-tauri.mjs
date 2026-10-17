// node kit9-gallery-tauri.mjs '<json spec>' — the desktop kit gallery in WebKit (Playwright), one image per state.
// spec: { vite, theme, reduced, out, states: [name] }
import path from 'node:path'
const { webkit } = await import(process.env.PLAYWRIGHT_CORE)
const { states } = await import(path.join(import.meta.dirname, '../visual/kit/steps/index.ts'))
const spec = JSON.parse(process.argv[2])
const browser = await webkit.launch()
try {
  for (const name of spec.states) {
    const state = states[name]
    if (!state) { console.log(`[kit tauri] no state ${name}`); continue }
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, colorScheme: spec.theme, reducedMotion: spec.reduced ? 'reduce' : 'no-preference' })
    const page = await ctx.newPage()
    page.on('pageerror', (e) => console.log('[kit tauri] pageerror', e.message))
    await page.goto(`http://127.0.0.1:${spec.vite}/gallery.html?section=${state.section}&theme=${spec.theme}`)
    await page.waitForSelector(`[data-gallery="${state.section}"]`)
    await page.addStyleTag({ content: '*::-webkit-scrollbar{display:none}' })
    await page.waitForTimeout(400)
    if (state.tauri) await state.tauri(page)
    await page.waitForTimeout(state.settle ?? 500)
    const clip = state.clip ? { x: state.clip[0], y: state.clip[1], width: state.clip[2], height: state.clip[3] } : undefined
    await page.screenshot({ path: path.join(spec.out, `kit-${name}-${spec.theme}-tauri.png`), clip })
    console.log(`[kit tauri] ${name}`)
    await ctx.close()
  }
} finally { await browser.close() }
