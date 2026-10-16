import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../src/requests/harness.ts'
import { acquirePreviewUiLock } from './preview-ui-lock.ts'
import { until, absent, openDock } from './dock-waits.ts'
const data = '/Users/mymac/projects/ade-gpuix-scratch/round7-dock'
const out = '/Users/mymac/projects/ade/previews/gpuix/round7/dock'
const fixture = JSON.parse(readFileSync(`${data}/dock7-fixture.json`, 'utf8'))
mkdirSync(out, { recursive: true })
let release: (() => void) | undefined
const queue = '/tmp/kybern-gpuix-ui-queue'
if (!existsSync(queue) || !readFileSync(queue, 'utf8').split('\n').includes('dock7')) appendFileSync(queue, 'dock7\n')
console.log('dock7 queued for UI lock')
await until(async () => {
  if (readFileSync(queue, 'utf8').trim().split('\n')[0] !== 'dock7') return false
  try { release = acquirePreviewUiLock(); return true } catch { return false }
}, 'exclusive UI lock', 30 * 60000)
try {
for (const theme of ['dark', 'light']) for (const reduced of ['0', '1']) {
  const label = `${theme}-${reduced === '1' ? 'reduced' : 'normal'}`
  writeFileSync(`${data}/gpuix-ui.json`, '{}')
  const run = await launchFixture(path.resolve('src/main.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_DATA_DIR: data, KYBERN_GPUIX_THREAD: fixture.thread, KYBERN_CLIENT_CONFIG_DIR: `${data}/client-${label}`, KYBERN_GPUIX_CREDENTIALS_DIR: `${data}/credentials`, KYBERN_APPEARANCE: theme, KYBERN_REDUCED_MOTION: reduced, KYBERN_OPAQUE: '1', KYBERN_FRAME_TIMES: '1' })
  const app = run.app
  try {
    await app.getByTestId('header-title').waitFor({ timeoutMs: 60000 })
    const windowIdProcess = Bun.spawn(['swift', 'visual/window-id.swift', String(run.pid)], { stdout: 'pipe', stderr: 'pipe' })
    const windowId = (await new Response(windowIdProcess.stdout).text()).trim()
    assert.equal(await windowIdProcess.exited, 0); assert.ok(windowId)
    const shot = async (file: string) => {
      const capture = Bun.spawn(['screencapture', '-x', '-o', '-l', windowId, file], { stdout: 'pipe', stderr: 'pipe' })
      assert.equal(await capture.exited, 0)
    }
    if (!await app.getByTestId('right-dock').count()) await app.getByTestId('app-ready').press('cmd-j')
    await openDock(app.getByTestId('right-dock'))
    await app.getByTestId('dock-add').click(); await app.getByTestId('dock-add-explorer').click()
    await app.getByTestId('dock-file-src').waitFor()
    console.log(label, 'ready')
    await app.clock.fastForward(600)
    // Warm lazy listings using real input, including two nested levels.
    await app.getByTestId('dock-file-src').click()
    await app.getByTestId('dock-file-src/components').waitFor()
    await app.clock.fastForward(600)
    await app.getByTestId('dock-file-src/components').click()
    await app.getByTestId('dock-file-src/components/kit').waitFor()
    await app.clock.fastForward(600)
    await app.getByTestId('dock-file-src/components/kit').click()
    await app.getByTestId('dock-file-src/components/kit/theme.ts').waitFor()
    await app.clock.fastForward(600)
    await app.getByTestId('dock-file-src/components/kit/theme.ts').click()
    await app.getByTestId('dock-code-chunk-0').waitFor()
    await shot(`${out}/explorer-nested-${label}-gpuix.png`)
    console.log(label, 'nested file painted')
    await app.getByTestId('dock-file-src').click(); await app.clock.fastForward(600)
    await absent(app.getByTestId('dock-file-src/components'))
    for (const action of ['expand', 'collapse']) {
      const dir = `${out}/${label}-${action}-gpuix`; mkdirSync(dir, { recursive: true })
      await app.clock.pause()
      await app.getByTestId('dock-file-src').click()
      let previous = 0
      const samples = []
      for (const time of [0, 16, 32, 64, 96, 128, 176, 224, 320, 600]) {
        await app.clock.fastForward(time - previous); previous = time
        samples.push({ time, sibling: await app.getByTestId('dock-file-README.md').bounds() })
        await shot(`${dir}/${String(time).padStart(3, '0')}.png`)
      }
      writeFileSync(`${dir}/bounds.json`, JSON.stringify(samples, null, 2))
      await app.clock.resume()
      console.log(label, action, 'strip done')
    }
    await absent(app.getByTestId('dock-file-src/components'))
    console.log(label, 'exit rows unmounted')
    // Exercise keyboard activation and the native virtual collection (>100 rows).
    const tree = app.getByTestId('dock-file-tree-focus')
    await tree.press('home'); await app.clock.fastForward(32); await tree.press('down'); await app.clock.fastForward(32); await tree.press('right')
    await app.getByTestId('dock-file-large/file-000.ts').waitFor()
    console.log(label, 'virtual branch ready')
    await tree.press('right'); await app.clock.fastForward(32); await tree.press('enter')
    await app.getByText('large › file-000.ts').waitFor({ timeoutMs: 10000 })
    await tree.press('end'); await app.clock.fastForward(64)
    await app.clock.fastForward(600)
    await shot(`${out}/explorer-large-${label}-gpuix.png`)
    await tree.press('home'); await app.clock.fastForward(64)
    await until(async () => { const b = await app.getByTestId('dock-file-large').bounds(); return b.y > 130 && b.y < 300 && (await app.call('getPaintedText', {})).text.includes('large') }, 'virtual root scrolls into view', 10000)
    await app.getByTestId('dock-file-large').click()
    await app.clock.fastForward(600)
    await until(async () => await app.getByTestId('dock-file-large/file-000.ts').count() === 0, 'virtual branch closes')
    console.log('PASS', label, 'nested selection, expand/collapse strips, virtual rows, keyboard')
  } finally { await run.close() }
}
const performanceRun = Bun.spawn(['bun', 'scripts/dock7-perf.ts'], { stdout: 'inherit', stderr: 'inherit' })
assert.equal(await performanceRun.exited, 0)
const pair = Bun.spawn(['bun', 'scripts/visual-pair.ts', 'dock7-provider-marks', 'dock7-explorer', '--theme', 'both', '--out', out, '--keep'], { env: { ...process.env, VISUAL_SCRATCH: `${data}/visual`, GPUIX_VISUAL_AREAS: 'dock7' }, stdout: 'inherit', stderr: 'inherit' })
assert.equal(await pair.exited, 0)
const reference = Bun.spawn(['node', 'scripts/dock7-reference.mjs'], { stdout: 'inherit', stderr: 'inherit' })
assert.equal(await reference.exited, 0)
} finally { release?.(); writeFileSync(queue, readFileSync(queue, 'utf8').split('\n').filter(line => line && line !== 'dock7').join('\n') + '\n') }
