/**
 * Desktop twin of verify-tui.ts: the desktop frontend (xterm.js, WebKit) against the same scratch daemon.
 *   node verify-tui-desktop.mjs <vite port> <daemon data dir> <theme> <out dir> [scenario ...]
 * The data dir must be a scratch folder.
 */
import { readFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const [vite, data, theme = 'dark', out, ...wanted] = process.argv.slice(2)
if (path.resolve(data) === path.join(os.homedir(), '.kybern') || !path.resolve(data).includes('gpuix-scratch')) throw new Error('Not a scratch folder')
mkdirSync(out, { recursive: true })
const { DATA } = await import('./verify-scenarios.ts').catch(async () => import('./verify-scenarios.mjs'))
const { webkit } = await import(process.env.PLAYWRIGHT_CORE)
const port = readFileSync(`${data}/daemon.port`, 'utf8').trim(), token = readFileSync(`${data}/daemon.token`, 'utf8').trim()
const browser = await webkit.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: 'reduce' })
const page = await ctx.newPage()
await page.goto(`http://127.0.0.1:${vite}/?url=ws://127.0.0.1:${port}/ws&token=${token}`)
await page.waitForSelector('button[aria-label="Notes"]', { timeout: 30000 }); await page.waitForTimeout(1000)
await page.addStyleTag({ content: '*::-webkit-scrollbar{display:none}' })
const title = process.env.THREAD_TITLE
await page.getByText(title, { exact: true }).first().click(); await page.waitForTimeout(1200)
if (!await page.getByRole('button', { name: 'Add panel', exact: true }).count()) await page.keyboard.press('Meta+j')
await page.waitForTimeout(500)
await page.getByRole('button', { name: 'Add panel', exact: true }).click(); await page.getByRole('menuitem', { name: /^Terminal/ }).click()
await page.waitForSelector('.xterm-screen'); await page.waitForTimeout(2000)
const rpc = await page.evaluate(() => 0)
const call = (method, params) => page.evaluate(async ([method, params]) => { const { rpc } = await import('/src/state/rpc.ts'); return rpc().call(method, params) }, [method, params])
const threadId = process.env.THREAD_ID
const terminal = async () => (await call('terminals.list', { thread_id: threadId })).terminals.find(t => t.alive)
const input = async text => call('terminals.input', { terminal_id: (await terminal()).id, data: Buffer.from(text).toString('base64') })
const run = async steps => { for (const s of steps) { if (typeof s === 'string') await input(s); else await page.waitForTimeout(s.wait) } }
await input(`cd ${process.env.PROJECT_DIR}\r`); await page.waitForTimeout(800)
const shot = name => page.screenshot({ path: path.join(out, `${name}-${theme}-tauri.png`) })
for (const scenario of DATA) {
  if (wanted.length && !wanted.includes(scenario.name)) continue
  console.log('scenario', scenario.name)
  await run(scenario.steps); await page.waitForTimeout(300); await page.mouse.move(1275, 815); await shot(scenario.name)
  for (const more of scenario.then ?? []) { await run(more.steps); await page.waitForTimeout(300); await shot(scenario.name + more.label) }
}
for (const t of (await call('terminals.list', { thread_id: threadId })).terminals) await call('terminals.close', { terminal_id: t.id }).catch(() => {})
await browser.close()
