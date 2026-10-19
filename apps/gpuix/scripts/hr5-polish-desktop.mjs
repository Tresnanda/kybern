// Desktop reference for the round 5 polish items: the desktop frontend in headless WebKit (never Tauri).
//   node scripts/hr5-polish-desktop.mjs <composer|mention|dock|sidebar> [--widths 900,1000,...] [--vite PORT --port PORT]
import { readFileSync } from 'node:fs'
const { webkit } = await import(process.env.PLAYWRIGHT_CORE ?? '/Users/mymac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs')
const scratch = process.env.HR5_SCRATCH ?? '/Users/mymac/projects/ade-gpuix-scratch/hr5-polish'
const state = JSON.parse(readFileSync(`${scratch}/state.json`, 'utf8'))
const token = readFileSync(`${scratch}/data/daemon.token`, 'utf8').trim()
const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d)
const vite = arg('--vite', state.vitePort), port = arg('--port', state.daemonPort)
const out = '/Users/mymac/projects/ade/previews/gpuix/handson-r5/polish'
const mode = process.argv[2]
const widths = arg('--widths', '1280').split(',').map(Number)
const height = Number(arg('--height', '820'))
const browser = await webkit.launch()
async function open(theme, width, setup) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: 'reduce' })
  if (setup) await ctx.addInitScript(setup)
  const page = await ctx.newPage()
  await page.goto(`http://localhost:${vite}/?url=ws://127.0.0.1:${port}/ws&token=${token}`)
  await page.waitForSelector('button[aria-label="Notes"]', { timeout: 30000 })
  await page.waitForTimeout(1200)
  await page.addStyleTag({ content: '*::-webkit-scrollbar{display:none}' })
  return { ctx, page }
}
const thread = async (page, title) => { await page.getByText(title, { exact: true }).first().click(); await page.waitForTimeout(1500) }
try {
  for (const theme of ['dark', 'light']) {
    if (mode === 'composer') for (const width of widths) {
      const sidebar = arg('--sidebar', '')
      const { ctx, page } = await open(theme, width, sidebar ? `localStorage.setItem('kybern.sidebar.width', '${sidebar}')` : undefined)
      await thread(page, 'Narrow composer')
      if (process.argv.includes('--dock')) { if (!await page.getByRole('button', { name: 'Add panel', exact: true }).count()) await page.keyboard.press('Meta+j'); await page.waitForTimeout(1000) }
      const tag = (process.argv.includes('--dock') ? '-dock' : '') + (sidebar ? `-sb${sidebar}` : '')
      const footer = page.locator('[data-chat-composer-footer]').first()
      const box = await footer.boundingBox()
      const labels = await page.evaluate(() => {
        const f = document.querySelector('[data-chat-composer-footer]'); if (!f) return null
        const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.display !== 'none' && s.visibility !== 'hidden' }
        const texts = [...f.querySelectorAll('span, button')].filter((el) => el.children.length === 0 && el.textContent.trim() && visible(el)).map((el) => el.textContent.trim())
        return { width: f.getBoundingClientRect().width, content: f.clientWidth, texts }
      })
      console.log(theme, width, JSON.stringify(labels))
      await footer.screenshot({ path: `${out}/composer-desktop-${theme}-${width}${tag}-footer.png` })
      await page.screenshot({ path: `${out}/composer-desktop-${theme}-${width}${tag}.png` })
      await ctx.close()
    }
    if (mode === 'mention') {
      const { ctx, page } = await open(theme, 1280)
      await thread(page, 'Rounded clip review')
      const editor = page.locator('[data-chat-composer-footer]').locator('xpath=ancestor::div[1]').locator('..').locator('[contenteditable="true"]').first()
      await editor.click(); await page.keyboard.type('@' + (process.env.MENTION_QUERY ?? '')); await page.waitForTimeout(900)
      if (process.env.DESK_CHIP) { await page.getByRole('tab', { name: process.env.DESK_CHIP, exact: true }).first().click(); await page.waitForTimeout(600) }
      await page.screenshot({ path: `${out}/mention${process.env.MENTION_QUERY ? '-' + process.env.MENTION_QUERY : ''}${process.env.DESK_CHIP ?? process.env.MENTION_CHIP ?? ''}-desktop-${theme}.png` })
      await ctx.close()
    }
    if (mode === 'dock') {
      const { ctx, page } = await open(theme, 1280)
      await thread(page, 'Rounded clip review')
      if (!await page.getByRole('button', { name: 'Add panel', exact: true }).count()) await page.keyboard.press('Meta+j')
      await page.waitForTimeout(600)
      // close every tab
      for (let i = 0; i < 12; i++) { const close = page.locator('[aria-label^="Close"]').first(); if (!await close.count()) break; await close.click({ force: true }); await page.waitForTimeout(150) }
      await page.waitForTimeout(600)
      await page.screenshot({ path: `${out}/dock-empty-desktop-${theme}.png` })
      await ctx.close()
    }
    if (mode === 'sidebar') {
      for (const sidebar of [208, 256]) {
        const { ctx, page } = await open(theme, 1280, `localStorage.setItem('kybern.sidebar.width', '${sidebar}')`)
        await page.screenshot({ path: `${out}/sidebar-empty-desktop-${theme}-${sidebar}.png` })
        await ctx.close()
      }
    }
  }
} finally { await browser.close() }
