/** Regression: screenshot → one Enter → RPC → recovery, without input retries. */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'
import { pagesFixture } from './pages-fixture.ts'
import { verifyPrRecovery } from './pages-recovery.ts'

const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/previews/gpuix/pages'
mkdirSync(out, { recursive: true })
const fixture = pagesFixture()
const variant = process.argv.includes('--light') ? 'light' : 'dark'
const reduced = process.argv.includes('--reduced')
const watchdog = setTimeout(() => process.exit(1), 120_000)
const app = await launch({ command: 'bun', args: [path.join(import.meta.dir, '../src/main.tsx')], env: { ...process.env, ...fixture.env, KYBERN_APPEARANCE: variant, KYBERN_REDUCED_MOTION: reduced ? '1' : '0' } })
try {
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 20_000 })
  await app.getByTestId('rail-pulls').click()
  await app.getByTestId('pr-row-108').waitFor({ timeoutMs: 10_000 })
  await app.getByTestId('pr-row-108').click()
  await app.getByTestId('pr-summary').waitFor({ timeoutMs: 10_000 })
  await app.getByTestId('pr-tab-timeline').click()
  await app.getByTestId('pr-timeline-filter-reviews').click()
  await Bun.sleep(700)
  await app.getByTestId('pr-timeline-more').press('enter')
  await Bun.sleep(700)
  for (let i = 0; i < 8; i++) {
    await app.mouse.move({ x: 1200, y: 40 })
    await app.screenshot({ path: path.join(out, `recovery-${variant}${reduced ? '-reduced' : ''}.png`) })
    await verifyPrRecovery(app, fixture, i % 2 ? 'auth' : 'missing')
  }
  console.log(`PASS: 8 screenshot/Enter/recovery transitions (${variant}, reduced=${reduced})`)
} finally { clearTimeout(watchdog); await app.close(); fixture.close() }
