/**
 * Theme switch cross-fade, GPUIX side: Settings > Appearance, switch dark -> light with the clock paused, then step through the
 * 280 ms fade (crops of the window), and measure presented-frame intervals during a live switch. Desktop: kit9-themefade-tauri.mjs.
 *   bun scripts/kit9-themefade.ts [--reduced]
 */
import { mkdirSync } from 'node:fs'
import { EVIDENCE, start, waitUntil } from './kit9-lib.ts'
const reduced = process.argv.includes('--reduced')
const dir = `${EVIDENCE}/themefade`
mkdirSync(dir, { recursive: true })
const shot0 = (n: string) => app.screenshot({ path: `${dir}/dbg-${n}.png` })
const sleep = (n: number) => new Promise((r) => setTimeout(r, n))
// The variant must not be pinned (KYBERN_APPEARANCE) or the preference changes nothing; the saved preference decides.
Bun.spawnSync(['rm', '-f', ...(await Array.fromAsync(new Bun.Glob('appearance-*.json').scan('/Users/mymac/projects/ade-gpuix-scratch/phase2-kit9-client'))).map((f) => `/Users/mymac/projects/ade-gpuix-scratch/phase2-kit9-client/${f}`)])
let app: Awaited<ReturnType<typeof start>>
app = await start({ reduced, full: true, env: { KYBERN_APPEARANCE: '' } })
try {
  await waitUntil(async () => (await app.getByTestId('rail-settings').count()) > 0, 30_000, 'app')
  await sleep(500)
  await shot0('boot')
  await app.getByTestId('rail-settings').click()
  await waitUntil(async () => (await app.getByTestId('settings-tab-appearance').count()) > 0, 10_000, 'settings tabs')
  console.log('settings open'); await app.getByTestId('settings-tab-appearance').click()
  await waitUntil(async () => (await app.getByTestId('settings-theme-dark').count()) > 0, 10_000, 'appearance settings')
  console.log('appearance tab'); await shot0('appearance'); await app.getByTestId('settings-theme-dark').click(); console.log('dark clicked'); await sleep(900); await shot0('dark')
  const shot = async (name: string) => app.screenshot({ path: `${dir}/${name}.png` })
  // Live: frame intervals while the cross-fade plays (no screenshots in the interval).
  const mark = app.frameTimes().at(-1) ?? 0
  const t0 = performance.now()
  await app.getByTestId('settings-theme-light').click()
  const clickMs = performance.now() - t0
  await sleep(700)
  const frames = app.frameTimes().filter((t) => t > mark)
  const dt = frames.slice(1).map((t, i) => t - frames[i]!).sort((a, b) => a - b)
  console.log(`click -> returns after ${clickMs.toFixed(0)} ms (includes the snapshot); frames: n=${frames.length} p50=${dt[Math.floor(dt.length * 0.5)]} p95=${dt[Math.floor(dt.length * 0.95)]} max=${dt.at(-1)} (KYBERN_FULL_RATE=1${reduced ? ', reduced' : ''})`)
  // Strip: back to dark, pause, switch to light, step.
  await app.getByTestId('settings-theme-dark').click(); await sleep(900)
  const at = await app.clock.pause()
  await app.getByTestId('settings-theme-light').click(); await sleep(250)
  for (const o of [0, 35, 70, 105, 140, 210, 280, 350]) { await app.clock.set(at + o); await shot(`gpuix-${reduced ? 'reduced-' : ''}${String(o).padStart(3, '0')}`) }
  await app.clock.resume()
  console.log('overlay left after the fade:', await app.getByTestId('theme-fade').count())
} catch (e) { console.error(String(e).slice(0, 300)); await app.screenshot({ path: `${dir}/failure.png` }).catch(() => {}); console.error(app.diagnostics().split('\n').filter((l: string) => /theme-fade|rror|panick/.test(l)).slice(-8).join('\n')); process.exitCode = 1 } finally { await app.closeAll(); process.exit(process.exitCode ?? 0) }
