/** Native dock checks. Writes only screenshots; uses the selected scratch thread.
 * NAPI_RS_NATIVE_LIBRARY_PATH=… KYBERN_DATA_DIR=… KYBERN_GPUIX_THREAD=… bun scripts/dock-check.ts [--light] [--perf]
 */
import { mkdirSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'
import { absent, openDock, painted, until } from '../../scripts/dock-waits.ts'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const run = promisify(execFile)
const variant = process.argv.includes('--light') ? 'light' : 'dark'
const narrow = process.argv.includes('--narrow')
const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/previews/gpuix/dock'
mkdirSync(out, { recursive: true })
let pid: number | undefined
const watchdog = setTimeout(() => { if (pid) try { process.kill(pid, 'SIGTERM') } catch {} ; process.exit(1) }, 180_000)
const app = await launch({
  command: 'bun', args: [path.join(import.meta.dir, 'verify-fixture.tsx')],
  env: { ...process.env, GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: variant, ...(narrow ? { KYBERN_WINDOW_SIZE: '980x820' } : {}) },
})
try {
  pid = (await app.call('initialize', { protocolVersion: 1, client: 'dock-check' })).pid
  console.log(`[dock] pid=${pid}`)
  await app.getByTestId('header-title').waitFor({ timeoutMs: 60_000 })
  await app.getByTestId('dock-toggle').click()
  await openDock(app.getByTestId('right-dock'))
  await app.getByTestId('dock-add').click()
  await app.getByTestId('dock-add-agents').click()
  await app.getByTestId('dock-agents-list').waitFor({ timeoutMs: 15000 })
  await app.getByTestId('dock-tabs').waitFor({ timeoutMs: 5000 })
  await app.getByTestId('app-ready').hover()
  await app.screenshot({ path: path.join(out, `01-agents-${variant}.png`) })
  console.log('[dock] opened')
  const before = await app.getByTestId('right-dock').bounds()
  await app.getByTestId('dock-resize').dragBy(60, 0)
  await until(async () => (await app.getByTestId('right-dock').bounds()).width < before.width, 'resize')
  const after = await app.getByTestId('right-dock').bounds()
  if (!(after.width < before.width)) throw new Error(`Resize did not shrink: ${before.width} → ${after.width}`)
  console.log(`[dock] resize ${before.width} → ${after.width}`)
  await app.getByTestId('app-ready').press('cmd-j')
  await absent(app.getByTestId('dock-tabs'))
  if (await app.getByTestId('dock-tabs').count()) throw new Error('Keyboard close did not unmount dock')
  await app.getByTestId('app-ready').press('cmd-j')
  await openDock(app.getByTestId('right-dock'))
  await app.getByTestId('dock-tabs').waitFor({ timeoutMs: 3000 })
  console.log('[dock] ⌘J close/open')
  for (const tab of ['activity', 'changes', 'explorer']) {
    await app.getByTestId('dock-add').click()
    await app.getByTestId(`dock-add-${tab}`).waitFor({ timeoutMs: 3000 })
    await app.getByTestId(`dock-add-${tab}`).click()
    await until(async () => tab === 'activity'
      ? !!await app.getByText('No background work').count() || !!await app.getByTestId('dock-activity-list').count()
      : !!await app.getByTestId(tab === 'changes' ? 'dock-file-diff-dock-example.ts' : 'dock-file-dock-example.ts').count(), `loaded ${tab}`)
    await app.screenshot({ path: path.join(out, `02-${tab}-${variant}.png`) })
    console.log(`[dock] ${tab}`)
    if (tab === 'changes') {
      const file = app.getByTestId('dock-file-diff-dock-example.ts')
      await file.waitFor({ timeoutMs: 15_000 })
      await file.click(); await painted(app.getByTestId('dock-native-diff-dock-example.ts')); await app.screenshot({ path: path.join(out, `03-diff-file-${variant}.png`) })
    }
    if (tab === 'explorer') {
      const file = app.getByTestId('dock-file-dock-example.ts')
      await file.waitFor({ timeoutMs: 15_000 })
      await file.click(); await painted(app.getByTestId('dock-code-chunk-0')); await app.screenshot({ path: path.join(out, `04-file-${variant}.png`) })
    }
  }
  await app.getByTestId('dock-tab-close-explorer').click()
  await absent(app.getByTestId('dock-file-tree'))
  if (await app.getByTestId('dock-file-tree').count()) throw new Error('Closed Explorer still mounted')
  console.log('[dock] tab close unmounted content')
  // Menu selection also brings a clipped tab back into view.
  await app.getByTestId('dock-add').click()
  await app.getByTestId('dock-add-agents').waitFor({ timeoutMs: 3000 })
  await app.getByTestId('dock-add-agents').click()
  await app.getByTestId('dock-tab-agents').waitFor({ timeoutMs: 3000 })
  await app.getByTestId(narrow ? 'dock-overlay' : 'dock-inline').waitFor({ timeoutMs: 3000 })
  await app.getByTestId('app-ready').hover()
  await app.screenshot({ path: path.join(out, `05-${narrow ? 'overlay' : 'inline'}-${variant}.png`) })
  console.log(`[dock] ${narrow ? 'narrow overlay' : 'wide inline'} layout`)
  if (process.argv.includes('--perf')) {
    for (let round = 1; round <= 2; round++) {
      const idle = await run('bun', [path.join(import.meta.dir, '../../perf/sample.ts'), '15', `GPUIX=${pid}`])
      console.log(`[dock] idle run ${round}\n${idle.stdout}`)
      const measurement = run('bun', [path.join(import.meta.dir, '../../perf/sample.ts'), '15', `GPUIX=${pid}`])
      const end = Date.now() + 15_000
      let toggles = 0
      while (Date.now() < end) { await app.getByTestId('dock-toggle').click(); toggles++; await wait(500) }
      console.log(`[dock] toggle run ${round}, ${toggles} toggles\n${(await measurement).stdout}`)
      if (!await app.getByTestId('dock-tabs').count()) await app.getByTestId('dock-toggle').click()
      await openDock(app.getByTestId('right-dock'))
    }
  }
  await app.getByTestId('dock-collapse').click()
  await absent(app.getByTestId('right-dock'))
  console.log('[dock] closed bounds', await app.getByTestId('right-dock').count() ? await app.getByTestId('right-dock').bounds() : null)
  await app.screenshot({ path: path.join(out, `08-closed-${variant}.png`) })
  if (await app.getByTestId('dock-tabs').count()) throw new Error('Pointer close did not unmount dock')
  console.log('[dock] PASS')
} catch (error) {
  await app.screenshot({ path: path.join(out, `dock-failure-${variant}.png`) });
  console.log(await app.getByTestId("dock-file-content").count(), await app.getByTestId("dock-file-horizontal").count());
  throw error
} finally {
  await Promise.race([app.close(), wait(2000)])
  if (pid) try { process.kill(pid, 'SIGTERM') } catch {}
  clearTimeout(watchdog)
}
