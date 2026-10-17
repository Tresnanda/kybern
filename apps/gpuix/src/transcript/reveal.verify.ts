import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { launchFixture } from '../requests/harness.ts'
const source = 'A calm stream preserves whole words and Unicode 🌿 while the provider pauses between bursts. '.repeat(12)
for (const reduced of ['0', '1']) {
  const scratch = mkdtempSync(tmpdir() + '/gpuix-p3-reveal-')
  const f = await launchFixture(import.meta.dir + '/reveal.fixture.tsx', { GPUIX_BACKGROUND: '1', KYBERN_REDUCED_MOTION: reduced, KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch, KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_URL: '', KYBERN_TOKEN: '' })
  try {
    await f.app.getByTestId('burst').waitFor()
    await f.app.getByTestId('burst').click()
    await Bun.sleep(150)
    const prefix = await f.app.getByTestId('shown').textContent()
    assert.ok(source.startsWith(prefix))
    if (reduced === '1') assert.equal(prefix, source)
    // A covered background window intentionally settles immediately, so no
    // speed assertion is made from an occluded native fixture.
    await f.app.getByTestId('finish').click()
    for (let i=0;i<50 && await f.app.getByTestId('shown').textContent() !== source;i++) await Bun.sleep(20)
    assert.equal(await f.app.getByTestId('shown').textContent(), source)
    console.log(`PASS reduced=${reduced}: valid received prefix and exact final Unicode text`)
  } finally { await f.close(); rmSync(scratch, { recursive: true, force: true }) }
}
process.exit(0)
