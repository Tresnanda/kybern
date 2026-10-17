// The hidden WKWebView runs the bundled Mermaid and rasterizes to PNG: a valid flowchart and
// sequence diagram produce images, invalid source gives none, a repeat is served from the cache.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { launchFixture } from '../requests/harness.ts'
import { EVIDENCE } from './live.ts'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? `${EVIDENCE}/mermaid`
mkdirSync(out, { recursive: true })
for (const theme of ['dark', 'light']) {
  const f = await launchFixture(import.meta.dir + '/mermaid.fixture.tsx', { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: theme, KYBERN_OPAQUE: '1' })
  try {
    const app = f.app
    await app.getByTestId('mermaid-fixture').waitFor({ timeoutMs: 30000 })
    const read = async () => String((await app.call('getPaintedText', {})).text)
    const end = Date.now() + 40000
    while (!(await read()).includes('cachedSame')) { if (Date.now() > end) throw Error('Mermaid did not finish: ' + f.diagnostics()); await Bun.sleep(100) }
    const text = await read()
    console.log(theme, text.replace(/\s+/g, ' ').slice(0, 300))
    assert.match(text, /flow: [\d.]+x[\d.]+/); assert.match(text, /sequence: [\d.]+x[\d.]+/); assert.match(text, /invalid: none/); assert.match(text, /cachedSame: true/)
    await Bun.sleep(600)
    await app.screenshot({ path: `${out}/fixture-${theme}.png` })
    console.log(`PASS ${theme}`)
  } catch (error) { console.log(f.diagnostics()); throw error } finally { await f.close() }
}
process.exit(0)
