import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { launchFixture } from '../src/requests/harness.ts'
for (const mode of ['dark', 'light']) {
  const f = await launchFixture(path.join(import.meta.dir, 'decoration-lab.tsx'), { KYBERN_APPEARANCE: mode, GPUIX_BACKGROUND: '1' })
  const a = f.app
  try {
    await a.getByTestId('app-ready').waitFor()
    const click = async (id: string) => { await a.getByTestId(id).click(); await Bun.sleep(100); return a.getByTestId('result').textContent() }
    await click('tick'); await click('tick') // settle nested caches before scrolling
    assert.equal(await click('decorate'), 'ok')
    assert.equal(JSON.parse(await click('adapter-selection')).start, 13)
    assert.deepEqual(JSON.parse(await click('hit-test')), ['computer', 'link'])
    assert.match(await click('bad-range'), /UTF-16/)
    assert.match(await click('stale'), /changed before decorations/)
    assert.match(await click('unsupported'), /do not support/)
    const out = process.env.KYBERN_VERIFY_OUTPUT ?? path.join(import.meta.dir, 'build')
    mkdirSync(out, { recursive: true })
    await click('decorate')
    await a.screenshot({ path: path.join(out, `decorations-${mode}.png`) })
    assert.equal(JSON.parse(await click('select-inside')).start, 15)
    await click('select-before')
    await a.getByTestId('editor').press('right')
    assert.equal(JSON.parse(await click('selection')).start, 15, 'right skips atom')
    await a.getByTestId('editor').press('left')
    assert.equal(JSON.parse(await click('selection')).start, 6, 'left skips atom')
    await a.getByTestId('editor').press('right')
    await a.getByTestId('editor').press('backspace')
    assert.equal(await a.getByTestId('value').textContent(), 'Hello  😀 bold italic code link end')
    await a.getByTestId('editor').press('cmd-z')
    assert.equal(await a.getByTestId('value').textContent(), 'Hello @Computer 😀 bold italic code link end')
    assert.equal(JSON.parse(await click('select-inside')).start, 15, 'undo restores atom')
    await a.getByTestId('editor').press('cmd-shift-z')
    assert.equal(await a.getByTestId('value').textContent(), 'Hello  😀 bold italic code link end')
    await a.getByTestId('editor').press('cmd-z')
    assert.equal(await click('insert-prefix'), 'ok')
    assert.equal(await a.getByTestId('value').textContent(), '😀Hello @Computer 😀 bold italic code link end')
    assert.equal(JSON.parse(await click('select-inside')).start, 17, 'UTF-16 atom rebases after insertion')
    await a.getByTestId('editor').press('cmd-z')
    assert.equal(JSON.parse(await click('select-inside')).start, 15)
    assert.equal(await click('replace-inside'), 'ok')
    assert.equal(await a.getByTestId('value').textContent(), 'Hello X 😀 bold italic code link end')
    await a.getByTestId('editor').press('cmd-z')
    assert.equal(JSON.parse(await click('select-inside')).start, 15)
    assert.equal(JSON.parse(await click('scroll-top'))[0], 0)
    await click('scroll')
    await a.getByText('Cached row 35').waitFor()
    const top = JSON.parse(await click('scroll-top'))
    assert.equal(top[0], 35, `cached scroll moved: ${top}`)
    await click('tick')
    assert.equal(JSON.parse(await click('scroll-top'))[0], 35)
    console.log(`ok ${mode}: styled input, atomic movement/deletion, UTF-16 rebase, undo/redo, stale rejection, nested cached 48-row scroll`)
  } catch (e) { console.error(f.diagnostics()); throw e }
  finally { await f.close() }
}
