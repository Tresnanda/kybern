import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../src/requests/harness.ts'
import { acquirePreviewUiLock } from './preview-ui-lock.ts'
import { pngPixels } from '../native/clip-pixels.ts'
import { until, absent, openDock } from './dock-waits.ts'
const data = '/Users/mymac/projects/ade-gpuix-scratch/round7-dock7b'
const out = '/Users/mymac/projects/ade/previews/gpuix/round7/dock7b'
const fixture = JSON.parse(readFileSync(`${data}/dock7-fixture.json`, 'utf8'))
mkdirSync(out, { recursive: true })
let release: (() => void) | undefined
const queue = '/tmp/kybern-gpuix-ui-queue'
if (!existsSync(queue) || !readFileSync(queue, 'utf8').split('\n').includes('dock7b')) appendFileSync(queue, 'dock7b\n')
console.log('dock7b queued for UI lock')
await until(async () => {
  if (readFileSync(queue, 'utf8').trim().split('\n')[0] !== 'dock7b') return false
  try { release = acquirePreviewUiLock(); return true } catch { return false }
}, 'exclusive UI lock', 30 * 60000)
try {
for (const theme of ['dark', 'light']) for (const reduced of ['0', '1']) {
  const label = `${theme}-${reduced === '1' ? 'reduced' : 'normal'}`
  writeFileSync(`${data}/gpuix-ui.json`, '{}')
  const run = await launchFixture(path.resolve('src/main.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_FULL_RATE: '1', KYBERN_DATA_DIR: data, KYBERN_GPUIX_THREAD: fixture.thread, KYBERN_CLIENT_CONFIG_DIR: `${data}/client-${label}`, KYBERN_GPUIX_CREDENTIALS_DIR: `${data}/credentials`, KYBERN_APPEARANCE: theme, KYBERN_REDUCED_MOTION: reduced, KYBERN_OPAQUE: '1', KYBERN_FRAME_TIMES: '1' })
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
        samples.push({ time, sibling: await app.getByTestId('dock-file-README.md').bounds(), chevron: await app.getByTestId('dock-chevron-src').bounds(), folders: await Promise.all((['open', 'closed'] as const).map(async state => ({ state, bounds: await app.getByTestId(`dock-folder-src-${state}`).count() ? await app.getByTestId(`dock-folder-src-${state}`).bounds() : null }))) })
        await shot(`${dir}/${String(time).padStart(3, '0')}.png`)
      }
      writeFileSync(`${dir}/bounds.json`, JSON.stringify(samples, null, 2))
      const startPixels = pngPixels(`${dir}/000.png`), endPixels = pngPixels(`${dir}/600.png`)
      const arrow = samples[0]!.chevron, scale = startPixels.width / 1280
      let changed = 0
      for (let y = arrow.y; y < arrow.y + arrow.height; y++) for (let x = arrow.x; x < arrow.x + arrow.width; x++) {
        if (startPixels.at(x * scale, y * scale).some((value, channel) => Math.abs(value - endPixels.at(x * scale, y * scale)[channel]!) > 16)) changed++
      }
      assert.ok(reduced === '1' ? changed === 0 : changed > 4, 'normal chevron rotates real pixels; reduced chevron has no tween')
      const displacement = Math.abs(samples[0]!.sibling.y - samples.at(-1)!.sibling.y)
      assert.ok(reduced === '1' ? displacement < 0.1 : displacement > 200, 'normal mode projects siblings; reduced mode is immediate')
      if (reduced === '0') {
        assert.equal(samples[0]!.folders.filter(folder => folder.bounds).length, 2, 'outgoing folder is retained during crossfade')
        assert.equal(samples.at(-1)!.folders.filter(folder => folder.bounds).length, 1, 'outgoing folder is removed by native completion')
        const incoming = samples[0]!.folders.find(folder => folder.state === (action === 'expand' ? 'open' : 'closed'))!
        assert.ok(incoming.bounds && incoming.bounds.width < 11, 'incoming folder starts at 0.75 scale')
        const settled = samples.at(-1)!.folders.find(folder => folder.bounds)!
        assert.ok(Math.abs(settled.bounds!.width - 14) < 0.1, 'folder settles at scale 1')
      }
      // Keep the visual-only clock paused across both actions: resume resets
      // the native clock to wall time and can rewind completed test springs.
      console.log(label, action, 'strip done')
    }
    await absent(app.getByTestId('dock-file-src/components'))
    console.log(label, 'exit rows unmounted')
    for (let n = 0; n < 4; n++) { await app.getByTestId('dock-file-src').click(); await app.clock.fastForward(32) }
    await app.clock.fastForward(1000)
    await absent(app.getByTestId('dock-file-src/components'))
    assert.ok(Math.abs((await app.getByTestId('dock-file-README.md').bounds()).y - 252.5) < 0.1, 'rapid reversal settles without stale rows or endpoints')
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
} finally { release?.(); writeFileSync(queue, readFileSync(queue, 'utf8').split('\n').filter(line => line && line !== 'dock7b').join('\n') + '\n') }
