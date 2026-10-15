import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { launchFixture } from '../requests/harness.ts'
const out = '/Users/mymac/projects/ade/previews/gpuix/p7'
mkdirSync(out, { recursive: true })
for (const theme of ['dark', 'light']) {
  const scratch = mkdtempSync(tmpdir() + '/gpuix-scratch-split-')
  const f = await launchFixture(import.meta.dir + '/native.fixture.tsx', { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch, KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_URL: '', KYBERN_TOKEN: '' })
  const app = f.app
  const until = async (check: () => Promise<boolean>) => { for (let i = 0; i < 100; i++) { if (await check()) return; await app.clock.fastForward(32); await Bun.sleep(20) } throw Error('Native paint did not settle') }
  const panes = async () => JSON.parse(await app.getByTestId('fixture-panes').textContent()) as { id: string; selected: string | null }[]
  const click = async (id: string) => { console.log('click', id); await app.getByTestId(id).waitFor(); await app.getByTestId(id).click(); await app.clock.fastForward(350) }
  try {
    await app.getByTestId('split-fixture').waitFor()
    await app.getByTestId('composer').waitFor()
    await app.clock.pause()
    await app.getByTestId('fixture-child').click()
    console.log('waiting outgoing'); await app.getByTestId('page-outgoing').waitFor()
    const painted = (await app.call('getPaintedText', {})).text.join('\n')
    assert.ok(painted.includes('parent') && painted.includes('child'))
    await app.clock.fastForward(100)
    await app.screenshot({ path: `${out}/transition-${theme}.png` })
    await app.clock.fastForward(1000)
    assert.equal(await app.getByTestId('page-outgoing').count(), 0)
    await click('fixture-keyboard')
    assert.equal(await app.getByTestId('page-outgoing').count(), 0)
    await app.clock.resume()
    await click('thread-actions'); await click('header-split-right')
    const pair = await panes(); assert.equal(pair.length, 2)
    await click('fixture-other')
    assert.deepEqual((await panes()).map(p => p.selected).sort(), ['other', 'parent'])
    await app.screenshot({ path: `${out}/split-${theme}.png` })
    // Resize with the same native pointer path as a real drag.
    const firstBox = await app.getByTestId(`pane-${pair[0]!.id}`).bounds()
    const seam = { x: firstBox.x + firstBox.width, y: firstBox.y + firstBox.height / 2 }
    await app.mouse.move(seam); await app.mouse.down(seam)
    await app.getByTestId('split-drag-layer').waitFor()
    await until(async () => (await app.getByTestId('split-drag-layer').bounds()).width > 0)
    await app.mouse.move({ x: seam.x + 50, y: seam.y }, { pressedButton: 0 })
    await app.mouse.up({ x: seam.x + 50, y: seam.y })
    await until(async () => await app.getByTestId('split-drag-layer').count() === 0)
    const resized = await app.getByTestId(`pane-${pair[0]!.id}`).bounds()
    assert.ok(resized.width > firstBox.width + 20, 'divider resizes the first pane')
    // Cancellation cannot commit a sidebar drop; release then creates a vertical split.
    if (process.argv.includes('--drag')) {
    const sourceBox = await app.getByTestId('thread-other').bounds()
    const start = { x: sourceBox.x + 10, y: sourceBox.y + sourceBox.height / 2 }
    const end = { x: firstBox.x + firstBox.width / 2, y: firstBox.y + firstBox.height - 40 }
    const dragTo = async (cancel: boolean) => {
      await app.mouse.move(start); await app.mouse.down(start)
      await app.mouse.move({ x: start.x + 8, y: start.y }, { pressedButton: 0 })
      await app.getByTestId('split-drag-layer').waitFor()
      await until(async () => (await app.getByTestId('split-drag-layer').bounds()).width > 0)
      await Bun.sleep(150)
      await app.mouse.move(end, { pressedButton: 0 })
      await app.mouse.move({ x: end.x + 1, y: end.y }, { pressedButton: 0 })
      await app.getByTestId('pane-drop-highlight').waitFor()
      await app.screenshot({ path: `${out}/drop-${theme}.png` })
      if (cancel) await app.getByTestId('app-ready').press('escape')
      await app.mouse.up(end)
      await until(async () => await app.getByTestId('split-drag-layer').count() === 0)
      await app.clock.fastForward(350)
    }
    await dragTo(true); assert.equal((await panes()).length, 2)
    await dragTo(false); assert.equal((await panes()).length, 3)
    const dropped = (await panes()).find(p => !pair.some(before => before.id === p.id))!
    await click(`pane-actions-${dropped.id}`); await click(`pane-close-${dropped.id}`)

    }
    await click(`pane-header-${pair[0]!.id}`)
    assert.equal(await app.getByTestId('fixture-focused').textContent(), 'parent')
    await click(`pane-actions-${pair[0]!.id}`); await click(`pane-down-${pair[0]!.id}`)
    assert.equal((await panes()).length, 3)
    await click('fixture-child')
    const triple = await panes()
    await click(`pane-actions-${triple.find(p => p.selected === 'child')!.id}`); await click(`pane-close-${triple.find(p => p.selected === 'child')!.id}`)
    assert.equal((await panes()).length, 2)
    console.log(`PASS ${theme}: frozen outgoing/incoming, keyboard instant, split, focus, nested split, close`)
  } finally { console.log(f.diagnostics()); await f.close(); rmSync(scratch, { recursive: true, force: true }) }
}
