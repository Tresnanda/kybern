/** Read-only native page verification. Never invokes a GitHub write action. */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'

const out = '/Users/mymac/projects/ade/previews/gpuix/pages'
mkdirSync(out, { recursive: true })
const variant = process.argv.includes('--light') ? 'light' : 'dark'
const watchdog = setTimeout(() => { console.error('Pages verification timed out'); process.exit(1) }, 180_000)
const app = await launch({ command: 'bun', args: [path.join(import.meta.dir, '../src/main.tsx')], env: { ...process.env, GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: variant } })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
try {
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 30_000 })
  await sleep(2500)
  await app.getByTestId('rail-usage').click()
  await app.getByTestId('usage-stats').waitFor({ timeoutMs: 20_000 })
  await sleep(700)
  await app.mouse.move({x: 1800, y: 60})
  await app.screenshot({ path: `${out}/usage-${variant}.png` })
  await app.mouse.wheel({x: 1100, y: 600}, 0, -900)
  await sleep(500)
  await app.screenshot({path: `${out}/usage-chart-${variant}.png`})
  await app.mouse.wheel({x: 1100, y: 600}, 0, 1500)
  await sleep(500)
  await app.getByTestId('usage-period').click()
  await app.getByTestId('usage-period-7').click()
  await sleep(700)
  await app.getByTestId('usage-group-model').click()
  await sleep(700)
  await app.screenshot({ path: `${out}/usage-week-model-${variant}.png` })
  await app.getByTestId('rail-pulls').click()
  await app.getByTestId('pr-search').waitFor({ timeoutMs: 10_000 })
  await sleep(25000)
  await app.screenshot({ path: `${out}/pulls-${variant}.png` })
  const rows = (await app.getByType('div').all()).filter(n => n.testId?.startsWith('pr-row-'))
  console.log(`Found ${rows.length} PR rows`)
  if (rows[0]) {
    await app.getByTestId(rows[0].testId!).click()
    await app.getByTestId('pr-summary').waitFor({ timeoutMs: 20_000 })
    await sleep(1000)
    await app.screenshot({ path: `${out}/summary-${variant}.png` })
    await app.getByTestId('pr-tab-changes').click()
    await sleep(3000)
    await app.screenshot({ path: `${out}/changes-${variant}.png` })
    await app.getByTestId('pr-tab-timeline').click()
    await sleep(2500)
    await app.screenshot({ path: `${out}/timeline-${variant}.png` })
    await app.getByTestId('pr-review').click()
    await sleep(500)
    await app.screenshot({ path: `${out}/review-${variant}.png` })
    await app.getByTestId('pr-review-popover').press('escape')
  }
  console.log(`Pages ${variant}: complete`)
} finally { clearTimeout(watchdog); await app.close() }
