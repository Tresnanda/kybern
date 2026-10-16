import '../src/native/local-build.ts'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { launchFixture } from '../src/requests/harness.ts'
import { parseMarkdownDocument } from '../../desktop/src/lib/markdownParser.ts'

const out = process.env.KYBERN_VERIFY_OUTPUT
if (!out) throw Error('Set KYBERN_VERIFY_OUTPUT to the assigned conversation artifact folder')
mkdirSync(out, { recursive: true })
for (const appearance of ['dark', 'light']) for (const reduced of ['0', '1']) {
  const f = await launchFixture(path.join(import.meta.dir, 'rich-document-lab.tsx'), { KYBERN_APPEARANCE: appearance, KYBERN_REDUCED_MOTION: reduced, GPUIX_BACKGROUND: '1', NAPI_RS_NATIVE_LIBRARY_PATH: process.env.NAPI_RS_NATIVE_LIBRARY_PATH! })
  const app = f.app
  const source = async () => JSON.parse(await app.getByTestId('source').textContent()) as string
  try {
    await app.getByTestId('app-ready').waitFor()
    await app.getByTestId('note-image').waitFor()
    await Bun.sleep(200)
    const initial = await source(), before = parseMarkdownDocument(initial)
    const painted = (await app.call('getPaintedText', {})).text.join('\n')
    assert(painted.includes('const code = "literal **text**"'), painted)
    assert(painted.includes('After bold and link.'), painted)
    assert(painted.includes('cell') && painted.includes('value'), painted)
    const image = await app.getByTestId('note-image').bounds()
    assert(image.width > 0 && image.height > 0)
    await app.getByTestId('mixed-2').click()
    await app.getByTestId('mixed-2').press('end')
    await app.getByTestId('mixed-2').press('x')
    await Bun.sleep(80)
    assert.equal(await source(), initial.replace('"title").', '"title").x'))
    await app.getByTestId('mixed-3-1-0').click()
    await app.getByTestId('mixed-3-1-0').press('end')
    await app.getByTestId('mixed-3-1-0').press('x')
    await Bun.sleep(80)
    const changed = await source(), after = parseMarkdownDocument(changed)
    assert(changed.includes('| cellx | **value** |'), changed)
    assert.equal(after.children[0]?.type, 'paragraph')
    assert.deepEqual(after.children[0], before.children[0], 'image syntax and source position remain exact')
    assert.deepEqual(after.children[1], before.children[1], 'code syntax and source position remain exact')
    assert.equal(after.children[3]?.type, 'table')
    await app.getByTestId('mixed-3-1-0').press('cmd-z')
    await Bun.sleep(80)
    assert((await source()).includes('| cell | **value** |'), await source())
    await app.getByTestId('mixed-2').click()
    await app.getByTestId('mixed-2').press('end')
    await app.getByTestId('mixed-2').press('enter')
    await app.getByTestId('mixed-2').press('z')
    await Bun.sleep(80)
    assert((await source()).includes('"title").x\nz'), await source())
    await app.screenshot({ path: path.join(out, `mixed-${appearance}-reduce-${reduced}.png`) })
    console.log(`ok ${appearance} reduce=${reduced}: native image, literal fenced code, editable following paragraph, formatted table cells, exact untouched image/code, table undo, Enter+typing survives source echo`)
  } catch (error) { console.error(f.diagnostics()); throw error }
  finally { await f.close() }
}
