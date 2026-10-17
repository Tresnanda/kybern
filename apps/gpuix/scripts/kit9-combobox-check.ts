// Combobox outside presses (kit9 review): a press in the input keeps the popup and the query, the trigger toggles it, outside closes.
import { startGallery, waitUntil } from './kit9-lib.ts'
const app = await startGallery('pickers', { light: process.argv.includes('--light') })
const pop = () => app.getByTestId('combobox-popup').count()
const out: string[] = []
const ok = (name: string, pass: boolean, detail = '') => { out.push(`${pass ? 'PASS' : 'FAIL'} ${name} ${detail}`); console.log(out.at(-1)) }
try {
  await app.getByTestId('combobox-input').click()
  await waitUntil(async () => (await pop()) === 1, 3000, 'open').catch(() => {})
  ok('click input opens', (await pop()) === 1)
  await app.getByTestId('combobox-input').fill('fix')
  await Bun.sleep(200)
  await app.getByTestId('combobox-input').click()
  await Bun.sleep(300)
  ok('second click in input keeps popup', (await pop()) === 1)
  ok('filtered rows', (await app.getByTestId('combobox-option-main').count()) === 0)
  await app.getByTestId('combobox-trigger').click()
  await Bun.sleep(300)
  ok('trigger closes open popup', (await pop()) === 0)
  await app.getByTestId('combobox-trigger').click()
  await Bun.sleep(300)
  ok('trigger reopens', (await pop()) === 1)
  await app.mouse.click({ x: 400, y: 380 })
  await Bun.sleep(300)
  ok('press outside closes', (await pop()) === 0)
  process.exitCode = out.some((l) => l.startsWith('FAIL')) ? 1 : 0
} finally { await app.closeAll() }
