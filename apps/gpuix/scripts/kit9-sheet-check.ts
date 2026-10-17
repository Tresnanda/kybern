// Sheet + nested Select (kit9 review): a scrim press with the select open closes only the select, the next one the sheet; Escape closes the select only.
import { startGallery, waitUntil } from './kit9-lib.ts'
const app = await startGallery('overlays')
const n = (id: string) => app.getByTestId(id).count()
const out: string[] = []
const ok = (name: string, pass: boolean) => { out.push(`${pass ? 'PASS' : 'FAIL'} ${name}`); console.log(out.at(-1)) }
try {
  await app.getByTestId('sheet-right-trigger').click()
  await app.getByTestId('sheet-right-popup').waitFor({ timeoutMs: 5000 })
  await Bun.sleep(400)
  await app.getByTestId('sheet-right-select-trigger').click()
  await app.getByTestId('sheet-right-select-popup').waitFor({ timeoutMs: 5000 })
  await Bun.sleep(300)
  await app.mouse.click({ x: 200, y: 500 })
  await Bun.sleep(500)
  ok('scrim press with select open closes the select', (await n('sheet-right-select-popup')) === 0)
  ok('...and keeps the sheet', (await n('sheet-right-popup')) === 1)
  await app.mouse.click({ x: 200, y: 500 })
  await waitUntil(async () => (await n('sheet-right-popup')) === 0, 2000, 'sheet closes').catch(() => {})
  ok('second scrim press closes the sheet', (await n('sheet-right-popup')) === 0)
  await Bun.sleep(400)
  await app.getByTestId('sheet-right-trigger').click()
  await app.getByTestId('sheet-right-popup').waitFor({ timeoutMs: 5000 })
  await Bun.sleep(400)
  await app.getByTestId('sheet-right-select-trigger').click()
  await app.getByTestId('sheet-right-select-popup').waitFor({ timeoutMs: 5000 })
  await Bun.sleep(300)
  await app.getByTestId('sheet-right-select-popup').press('escape')
  await Bun.sleep(400)
  ok('Escape closes the select only', (await n('sheet-right-select-popup')) === 0 && (await n('sheet-right-popup')) === 1)
  process.exitCode = out.some((l) => l.startsWith('FAIL')) ? 1 : 0
} finally { await app.closeAll() }
