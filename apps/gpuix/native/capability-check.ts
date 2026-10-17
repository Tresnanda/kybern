import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../src/requests/harness.ts'
for (const mode of ['dark', 'light']) {
  const f = await launchFixture(path.join(import.meta.dir, 'capability-lab.tsx'), { KYBERN_APPEARANCE: mode, GPUIX_BACKGROUND: '1' })
  const a = f.app
  try {
    await a.getByTestId('app-ready').waitFor()
    const click = async (id: string) => { await a.getByTestId(id).click(); await Bun.sleep(100); return a.getByTestId('result').textContent() }
    assert.deepEqual(JSON.parse(await click('select-input')), { start: 1, end: 4, reversed: true, composing: false })
    assert.match(await click('bad-boundary'), /UTF-16/)
    assert.equal(await click('edit-input'), 'ok')
    await a.getByText('a**😀é** example').waitFor()
    await a.getByTestId('editor').press('cmd-z')
    assert.equal(await a.getByTestId('value').textContent(), 'a😀é example')
    await a.getByTestId('editor').press('cmd-shift-z')
    assert.equal(await a.getByTestId('value').textContent(), 'a**😀é** example')
    assert.match(await click('stale-edit'), /changed before transaction/)
    const old = await a.getByTestId('font-sample').bounds()
    assert.equal(await click('load-fonts'), 'ok')
    const next = await a.getByTestId('font-sample').bounds()
    assert.notEqual(old.width, next.width, 'Registered Cal Sans must change shaped glyph metrics')
    const ranges = JSON.parse(await click('select-prose'))
    assert.equal(ranges[0].text.slice(ranges[0].start, ranges[0].end), '😀')
    for (let i = 1; i <= 3; i++) {
      await a.call('keyDown', { elementId: (await a.getByTestId('app-ready').element()).id, key: 'x' }); await Bun.sleep(100)
      assert.deepEqual(JSON.parse(await a.getByTestId('result').textContent()), ranges)
      assert.ok((await a.call('getPaintedText', {})).text.includes(`Row 0 tick ${i}`), 'Virtual row cache must update')
    }
    await click('scroll-list')
    await a.getByText('Row 30 tick 3').waitFor()
    assert.ok((await a.getByTestId('row-30').bounds()).width > 300)
    const out = process.env.KYBERN_VERIFY_OUTPUT ?? path.join(import.meta.dir, 'build')
    mkdirSync(out, { recursive: true })
    await a.screenshot({ path: path.join(out, `capabilities-${mode}.png`) })
    console.log(`ok ${mode}: UTF-16 selection, transaction undo/redo/stale rejection, font metrics, cached prose selection, virtual row updates and scroll`)
  } catch (error) { console.error(f.diagnostics()); throw error }
  finally { await f.close() }
}
