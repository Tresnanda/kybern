/**
 * Desktop twin of verify-dock9.ts (the frontend in WebKit against the same scratch daemon).
 *   THREAD_TITLE=<title> PROJECT_DIR=<dir> PLAYWRIGHT_CORE=... node verify-dock9-desktop.mjs <vite port> <data dir> <theme> <out dir> [scenario ...]
 */
import { readFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const [vite, data, theme = 'dark', out, ...wanted] = process.argv.slice(2)
if (path.resolve(data) === path.join(os.homedir(), '.kybern') || !path.resolve(data).includes('gpuix-scratch')) throw new Error('Not a scratch folder')
mkdirSync(out, { recursive: true })
const { webkit } = await import(process.env.PLAYWRIGHT_CORE)
const port = readFileSync(`${data}/daemon.port`, 'utf8').trim(), token = readFileSync(`${data}/daemon.token`, 'utf8').trim()
const browser = await webkit.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: 'reduce' })
const page = await ctx.newPage()
await page.goto(`http://127.0.0.1:${vite}/?url=ws://127.0.0.1:${port}/ws&token=${token}`)
await page.waitForSelector('button[aria-label="Notes"]', { timeout: 30000 }); await page.waitForTimeout(1000)
await page.addStyleTag({ content: '*::-webkit-scrollbar{display:none}' })
await page.getByText(process.env.THREAD_TITLE, { exact: true }).first().click(); await page.waitForTimeout(1200)
if (!await page.getByRole('button', { name: 'Add panel', exact: true }).count()) await page.keyboard.press('Meta+j')
await page.waitForTimeout(500)
const shot = name => page.screenshot({ path: path.join(out, `${name}-${theme}-tauri.png`) })
const openTab = async label => { await page.getByRole('button', { name: 'Add panel', exact: true }).click(); await page.getByRole('menuitem', { name: new RegExp(`^${label}`) }).click(); await page.waitForTimeout(900) }
const ran = name => !wanted.length || wanted.includes(name)
const dir = process.env.PROJECT_DIR
if (ran('preview')) {
  console.log('scenario preview')
  await openTab('Preview')
  await page.getByRole('textbox', { name: 'Address' }).fill(`${dir}/preview.html`); await page.keyboard.press('Enter'); await page.waitForTimeout(2500)
  await page.mouse.move(1275, 815); await shot('preview-file')
  await page.keyboard.press('Alt+Meta+p'); await page.waitForTimeout(1200); await page.mouse.move(1275, 815); await shot('preview-mini')
  const mini = page.locator('[data-preview-mini]').first()
  const box = await mini.boundingBox().catch(() => null)
  if (box) { await page.mouse.move(box.x + box.width / 2, box.y + 14); await page.waitForTimeout(500); await shot('preview-mini-hover') }
  await page.mouse.move(20, 20); await page.keyboard.press('Alt+Meta+p'); await page.waitForTimeout(1000); await page.mouse.move(1275, 815); await shot('preview-docked-again')
}
if (ran('artifacts')) {
  console.log('scenario artifacts')
  await openTab('Artifacts')
  await page.mouse.move(1275, 815); await shot('artifacts')
  await page.getByRole('textbox', { name: 'Artifact file path' }).fill('artifacts/dashboard.html'); await page.getByRole('button', { name: 'Preview file' }).click(); await page.waitForTimeout(2500)
  await page.mouse.move(1275, 815); await shot('artifact-html')
  await page.getByRole('button', { name: 'Source' }).click(); await page.waitForTimeout(800); await shot('artifact-source')
  await page.keyboard.press('Escape'); await page.waitForTimeout(500)
  await page.getByRole('textbox', { name: 'Artifact file path' }).fill('artifacts/notes.md'); await page.getByRole('button', { name: 'Preview file' }).click(); await page.waitForTimeout(1500); await shot('artifact-markdown')
  await page.keyboard.press('Escape'); await page.waitForTimeout(500)
}
if (ran('environment')) {
  console.log('scenario environment')
  await page.getByRole('button', { name: 'Toggle environment panel' }).click(); await page.waitForTimeout(1000)
  await page.mouse.move(1275, 815); await shot('environment')
  await page.getByRole('button', { name: 'Panel sections' }).click(); await page.waitForTimeout(500); await shot('environment-sections')
}
await browser.close()
