import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../requests/harness.ts'
const out = path.resolve(process.env.KYBERN_VERIFY_OUTPUT ?? '../../shots')
mkdirSync(out, { recursive: true })
for (const theme of ['dark', 'light']) for (const state of ['mid', 'done']) {
 const scratch = path.join(out, 'scratch', `${theme}-${state}`)
 const f = await launchFixture(path.join(import.meta.dir, 'updates.fixture.tsx'), {
  GPUIX_BACKGROUND: '1', KYBERN_NO_ACTIVATE: '1', KYBERN_APPEARANCE: theme, KYBERN_OPAQUE: '1',
  KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch,
  KYBERN_URL: '', KYBERN_TOKEN: '', UPDATE_SHOT: state,
 })
 try {
  await f.app.getByTestId('fixture-ready').waitFor({ timeoutMs: 60000 })
  await Bun.sleep(600)
  const text = await f.app.getByTestId('machines-update-results').textContent()
  assert.ok(text.includes(state === 'mid' ? 'Downloading' : 'Updated'))
  assert.ok(!text.includes('64%'))
  assert.ok(!text.includes('Updated to'))
  await f.app.screenshot({ path: path.join(out, `${theme}-${state}.png`) })
  console.log(`PASS ${theme} ${state}`)
 } catch(e) { console.error(f.diagnostics()); throw e }
 finally { await f.close() }
}
