import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { launchFixture } from '../requests/harness.ts'
const out = '/Users/mymac/projects/ade/previews/gpuix/split-drag'
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
    if (process.env.KYBERN_REDUCED_MOTION === '1') {
      assert.equal(await app.getByTestId('page-outgoing').count(), 0, 'Reduced motion has no outgoing page')
      const painted = (await app.call('getPaintedText', {})).text.join('\n')
      assert.ok(painted.includes('child'), 'Incoming child is present immediately')
    } else {
      console.log('waiting outgoing'); await app.getByTestId('page-outgoing').waitFor()
      const painted = (await app.call('getPaintedText', {})).text.join('\n')
      assert.ok(painted.includes('parent') && painted.includes('child'))
    }
    assert.equal(await app.getByTestId('error-fallback').count(), 0)
    await app.clock.fastForward(100)
    await app.screenshot({ path: `${out}/transition-${theme}.png` })
    await app.clock.fastForward(1000)
    assert.equal(await app.getByTestId('page-outgoing').count(), 0)
    await click('fixture-keyboard')
    assert.equal(await app.getByTestId('page-outgoing').count(), 0)
    await app.clock.resume()
    await click('thread-actions'); await click('header-split-right')
    const pair = await panes(); assert.equal(pair.length, 2)
    assert.equal(await app.getByTestId('error-fallback').count(), 0)
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
    for (let trial = 1; trial <= 3; trial++) {
    console.log(`drag ${theme} trial ${trial}`)
    const sourceBox = await app.getByTestId('thread-other').bounds()
    const start = { x: sourceBox.x + 10, y: sourceBox.y + sourceBox.height / 2 }
    const end = { x: firstBox.x + firstBox.width / 2, y: firstBox.y + firstBox.height - 40 }
    const dragTo = async (mode: 'escape' | 'source' | 'drop') => {
      await app.mouse.move(start); await app.mouse.down(start)
      await app.mouse.move({ x: start.x + 8, y: start.y }, { pressedButton: 0 })
      await app.getByTestId('split-drag-layer').waitFor()
      await until(async () => (await app.getByTestId('split-drag-layer').bounds()).width > 0)
      await Bun.sleep(150)
      await app.mouse.move(end, { pressedButton: 0 })
      await app.mouse.move({ x: end.x + 1, y: end.y }, { pressedButton: 0 })
      await app.getByTestId('pane-drop-highlight').waitFor()
      await app.clock.fastForward(200)
      await app.screenshot({ path: `${out}/drop-${theme}-${trial}.png` })
      if (mode === 'source') {
        await app.mouse.move(start, { pressedButton: 0 })
        await app.mouse.up(start)
      } else if (mode === 'escape') await app.getByTestId('app-ready').press('escape')
      if (mode !== 'source') await app.mouse.up(end)
      await until(async () => await app.getByTestId('split-drag-layer').count() === 0)
      await app.clock.fastForward(350)
    }
    await dragTo('escape'); assert.equal((await panes()).length, 2)
    await click(`pane-header-${pair[0]!.id}`)
    const beforeSource = await panes()
    await dragTo('source'); assert.deepEqual(await panes(), beforeSource)
    if (process.argv.includes('--physical')) {
    const [physical] = await Promise.all([exec('swift', [import.meta.dir + '/../../scripts/split-outside-pointer.swift', String(f.pid), String(start.x), String(start.y), '820']),
      app.getByTestId('split-drag-layer').waitFor({ timeoutMs: 30000 }),
    ])
    console.log(physical.stdout.trim())
    await until(async () => await app.getByTestId('split-drag-layer').count() === 0)
    await until(async () => await app.getByTestId('pane-drop-highlight').count() === 0)
    assert.equal((await panes()).length, 2, 'outside release must not commit')
    }
    await dragTo('drop'); assert.equal((await panes()).length, 3)
    const dropped = (await panes()).find(p => !pair.some(before => before.id === p.id))!
    assert.equal(dropped.selected, 'other')
    const dropBox = await app.getByTestId(`pane-${dropped.id}`).bounds()
    const keptBox = await app.getByTestId(`pane-${pair[0]!.id}`).bounds()
    assert.ok(dropBox.y > keptBox.y, 'bottom drop inserts below target')
    await click(`pane-actions-${dropped.id}`); await click(`pane-close-${dropped.id}`)
    await until(async () => await app.getByTestId('pane-drop-highlight').count() === 0)
    console.log(`PASS drag ${theme} trial ${trial}: Escape, source release, bottom drop, no stuck capture/highlight`)
    }

    }
    await click(`pane-header-${pair[0]!.id}`)
    assert.equal(await app.getByTestId('fixture-focused').textContent(), 'parent')
    await click(`pane-actions-${pair[0]!.id}`); await click(`pane-down-${pair[0]!.id}`)
    assert.equal((await panes()).length, 3)
    await click('fixture-child')
    const triple = await panes()
    await click(`pane-actions-${triple.find(p => p.selected === 'child')!.id}`); await click(`pane-close-${triple.find(p => p.selected === 'child')!.id}`)
    assert.equal((await panes()).length, 2)
    if (process.argv.includes('--drag')) {
      // All four sides start from one occupied pane; the center follows desktop
      // geometry (a directional split), while an empty pane opens directly.
      for (let trial = 1; trial <= 3; trial++) for (const zone of ['left', 'right', 'top', 'bottom', 'center', 'empty']) {
        await click('fixture-reset')
        if (zone === 'empty') { await click('thread-actions'); await click('header-split-right') }
        const before = await panes()
        const target = zone === 'empty' ? before.find(p => !p.selected)! : before[0]!
        const b = await app.getByTestId(`pane-${target.id}`).bounds()
        const source = await app.getByTestId('thread-other').bounds()
        const from = { x: source.x + 10, y: source.y + source.height / 2 }
        const to = { x: zone === 'left' ? b.x + 12 : zone === 'right' ? b.x + b.width - 12 : b.x + b.width / 2, y: zone === 'top' ? b.y + 12 : zone === 'bottom' ? b.y + b.height - 12 : b.y + b.height / 2 }
        await app.mouse.move(from); await app.mouse.down(from)
        await app.mouse.move({ x: from.x + 8, y: from.y }, { pressedButton: 0 })
        await app.getByTestId('split-drag-layer').waitFor()
        await app.mouse.move(to, { pressedButton: 0 })
        await app.getByTestId('pane-drop-highlight').waitFor()
        await app.clock.fastForward(200)
        if (trial === 1) await app.screenshot({ path: `${out}/${zone}-${theme}.png` })
        await app.mouse.up(to)
        await until(async () => await app.getByTestId('split-drag-layer').count() === 0)
        await until(async () => await app.getByTestId('pane-drop-highlight').count() === 0)
        const after = await panes()
        assert.equal(after.length, 2)
        const added = zone === 'empty' ? after.find(p => p.id === target.id)! : after.find(p => p.id !== target.id)!
        assert.equal(added.selected, 'other')
        if (zone !== 'empty') {
          assert.equal(after.find(p => p.id === target.id)!.selected, 'parent', 'occupied center never replaces')
          const a = await app.getByTestId(`pane-${added.id}`).bounds(), kept = await app.getByTestId(`pane-${target.id}`).bounds()
          if (zone === 'left') assert.ok(a.x < kept.x)
          if (zone === 'right') assert.ok(a.x > kept.x)
          if (zone === 'top') assert.ok(a.y < kept.y)
          if (zone === 'bottom') assert.ok(a.y > kept.y)
        }
        console.log(`PASS ${theme} trial ${trial}: ${zone}`)
      }
    }
    console.log(`PASS ${theme}: frozen outgoing/incoming, keyboard instant, split, focus, nested split, close`)
    assert.equal(await app.getByTestId('error-fallback').count(), 0)
    assert.ok(!f.diagnostics().includes('[error-boundary]'), f.diagnostics())
  } finally { console.log(f.diagnostics()); await f.close(); rmSync(scratch, { recursive: true, force: true }) }
}
