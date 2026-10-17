import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { launchFixture } from '../src/requests/harness.ts'

const out = process.env.KYBERN_VERIFY_OUTPUT
if (!out) throw Error('Set KYBERN_VERIFY_OUTPUT to the assigned conversation artifact folder')
mkdirSync(out, { recursive: true })
for (const appearance of ['dark', 'light']) for (const reduced of ['0', '1']) {
  const f = await launchFixture(path.join(import.meta.dir, 'rich-editor-lab.tsx'), { KYBERN_APPEARANCE: appearance, KYBERN_REDUCED_MOTION: reduced, GPUIX_BACKGROUND: '1', NAPI_RS_NATIVE_LIBRARY_PATH: process.env.NAPI_RS_NATIVE_LIBRARY_PATH! })
  const app = f.app
  const click = async (id: string) => { await app.getByTestId(id).click(); await Bun.sleep(80) }
  const source = async () => JSON.parse(await app.getByTestId('source').textContent()) as string
  const message = async () => JSON.parse(await app.getByTestId('message').textContent()) as string
  try {
    await app.getByTestId('app-ready').waitFor()
    await Bun.sleep(200)
    const painted = (await app.call('getPaintedText', {})).text.join('\n')
    assert(painted.includes('Write bold and italic with a link.'), painted)
    assert(painted.includes('Read Editor notes with Computer please'), painted)
    await app.screenshot({ path: path.join(out, `rich-${appearance}-reduce-${reduced}.png`) })
    await click('select-bold')
    await app.getByTestId('rich').press('cmd-b')
    assert.equal(await source(), 'Write bold and *italic* with [a link](https://example.com).\n\n')
    await app.getByTestId('rich').press('cmd-z')
    assert.equal(await source(), 'Write **bold** and *italic* with [a link](https://example.com).\n\n')
    await click('rich-selection')
    assert.deepEqual([JSON.parse(await app.getByTestId('result').textContent()).start, JSON.parse(await app.getByTestId('result').textContent()).end], [6, 10])
    await app.getByTestId('rich').press('cmd-shift-z')
    assert.equal(await source(), 'Write bold and *italic* with [a link](https://example.com).\n\n')
    await click('before-token')
    await app.getByTestId('tokens').press('right')
    await click('token-selection')
    assert.equal(JSON.parse(await app.getByTestId('result').textContent()).start, 20)
    await app.getByTestId('tokens').press('backspace')
    assert.equal(await message(), 'Read  with @Computer please')
    await app.getByTestId('tokens').press('cmd-z')
    assert.equal(await message(), 'Read @"Editor notes" with @Computer please')
    await app.getByTestId('tokens').press('cmd-shift-z')
    assert.equal(await message(), 'Read  with @Computer please')
    await click('pick-token')
    assert.equal(await message(), '@Computer  with @Computer please')
    await app.getByTestId('tokens').press('cmd-z')
    assert.equal(await message(), 'Read  with @Computer please')
    await click('select-token-range')
    await click('token-selection')
    const selected = JSON.parse(await app.getByTestId('result').textContent())
    assert.deepEqual([selected.start, selected.end, selected.reversed], [6, 10, true])
    await app.getByTestId('tokens').press('backspace')
    assert.equal(await message(), 'Read   @Computer please')
    await app.getByTestId('tokens').press('cmd-z')
    assert.equal(await message(), 'Read  with @Computer please')
    await click('token-selection')
    const restored = JSON.parse(await app.getByTestId('result').textContent())
    assert.deepEqual([restored.start, restored.end, restored.reversed], [6, 10, true])
    console.log(`ok ${appearance} reduce=${reduced}: visible formatting, selection format undo/redo, inline atomic labels, source offsets, mention deletion/pick history, reversed selection restored`)
  } catch (error) { console.error(f.diagnostics()); throw error }
  finally { await f.close() }
}
