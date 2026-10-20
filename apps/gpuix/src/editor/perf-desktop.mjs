// Desktop reference for perf.ts: the desktop frontend in WebKit (Playwright), typing
// at the end of the same 2,000-word note, timed from sending the key to the first
// animation frame whose editor text contains it. Uses the scratch daemon and Vite
// server a `visual-pair.ts --keep` run left (GPUIX_VISUAL_SLOT, default editor9).
//
//   node src/editor/perf-desktop.mjs
import { readFileSync } from 'node:fs'
import { rpc } from '../../visual/screens/editor9-reset.mjs'

const { webkit } = await import(process.env.PLAYWRIGHT_CORE ?? '/Users/mymac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs')
const slot = process.env.GPUIX_VISUAL_SLOT ?? 'editor9'
const state = JSON.parse(readFileSync(`/Users/mymac/projects/ade-gpuix-scratch/visual-pair-${slot}/state.json`, 'utf8'))
const url = `ws://127.0.0.1:${state.port}/ws`
// samples.ts `long`, repeated here (this runs under node).
const vocabulary = ['notes', 'native', 'editor', 'formatted', 'reading', 'caret', 'history', 'block', 'quiet', 'paragraph']
const words = (n) => Array.from({ length: n }, (_, i) => vocabulary[i % 10]).join(' ')
const body = Array.from({ length: 40 }, (_, i) => `${i % 8 === 0 ? `## Section ${i / 8 + 1}\n\n` : ''}${words(50)}.`).join('\n\n') + '\n'
const title = 'Editor long sample'
await rpc(url, state.token, async (call) => {
  const old = (await call('notes.list', {})).notes.find(n => n.title === title)
  if (old) { const { note } = await call('notes.get', { id: old.id }); await call('notes.update', { id: note.id, expected_revision: note.revision, body }) }
  else await call('notes.create', { scope: 'global', project_id: null, title, body })
})
const browser = await webkit.launch()
const page = await (await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, colorScheme: 'dark' })).newPage()
try {
  await page.goto(`http://127.0.0.1:${state.vitePort}/?url=${url}&token=${state.token}`)
  await page.waitForSelector('button[aria-label="Notes"]', { timeout: 30000 })
  await page.getByRole('button', { name: 'Notes', exact: true }).first().click()
  await page.waitForTimeout(1200)
  await page.locator(`[data-note-card][aria-label="${title}"]`).first().click()
  await page.waitForSelector('.note-prose')
  await page.waitForTimeout(1500)
  await page.locator('.note-prose').click()
  await page.keyboard.press('Meta+ArrowDown')
  await page.keyboard.press('Space')
  const samples = []
  let typed = ' '
  for (let i = 0; i < 70; i++) {
    const ch = 'abcdefghij'[i % 10]
    typed += ch
    const t0 = performance.now()
    await page.keyboard.press(ch)
    await page.waitForFunction((s) => document.querySelector('.note-prose')?.textContent?.includes(s), `.${typed}`, { polling: 'raf' })
    if (i >= 10) samples.push(performance.now() - t0)
    await page.waitForTimeout(80)
  }
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
  console.log(JSON.stringify({ reference: 'desktop frontend in WebKit', words: body.split(/\s+/).filter(Boolean).length, keys: samples.length, p50: +at(0.5).toFixed(1), p95: +at(0.95).toFixed(1), max: +Math.max(...samples).toFixed(1) }))
} finally { await browser.close() }
