import { readFileSync } from 'node:fs'
const { webkit } = await import(process.env.PLAYWRIGHT_CORE ?? 'playwright-core')
const data = process.env.KYBERN_DATA_DIR ?? ''
if (!data.includes('gpuix-scratch/drag-release/')) throw Error('Dedicated scratch daemon required')
const port = readFileSync(`${data}/daemon.port`, 'utf8').trim()
const token = readFileSync(`${data}/daemon.token`, 'utf8').trim()
const browser = await webkit.launch(process.env.WEBKIT_EXECUTABLE ? { executablePath: process.env.WEBKIT_EXECUTABLE } : {})
try {
 for (const theme of ['dark', 'light']) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: 'reduce' })
  const page = await ctx.newPage()
  await page.goto(`http://127.0.0.1:5398/?url=ws://127.0.0.1:${port}/ws&token=${token}`)
  await page.getByRole('button', { name: 'Notes', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await page.getByText('Outline follows reading', { exact: true }).first().click()
  await page.locator('.note-outline').waitFor()
  const outline = page.locator('.note-outline')
  if (!await outline.getAttribute('data-open')) await page.getByRole('button', { name: 'Keep the outline open', exact: true }).click()
  await outline.getByRole('button', { name: 'Section 4', exact: true }).click()
  await page.waitForTimeout(500)
  if (await outline.locator('[aria-current="location"]').textContent() !== 'Section 4') throw Error('Reference outline failed to follow section 4')
  await page.addStyleTag({ content: '*::-webkit-scrollbar{display:none}' })
  await page.mouse.move(1275,815)
  await page.screenshot({ path: `/Users/mymac/projects/ade/previews/gpuix/note-outline/reference-${theme}.png` })
  console.log(`PASS ${theme}: desktop WebKit reference marks section 4`)
  await ctx.close()
 }
} finally { await browser.close() }
