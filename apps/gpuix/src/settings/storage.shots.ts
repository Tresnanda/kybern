// Evidence captures of Settings › Storage: `bun src/settings/storage.shots.ts`. Writes `<SHOT_OUT>/<state>-<light|dark>.png`.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../requests/harness.ts'

const out = process.env.SHOT_OUT ?? path.resolve('storage-shots')
const scratchRoot = process.env.SHOT_SCRATCH ?? out
mkdirSync(out, { recursive: true })
const states = (process.env.SHOT_STATES ?? 'idle,moving,reclaiming,done,low-disk,nothing,failed').split(',')
for (const appearance of ['light', 'dark']) for (const state of states) {
  const scratch = mkdtempSync(path.join(scratchRoot, 'gpuix-storage-'))
  const fixture = await launchFixture(path.join(import.meta.dir, 'storage.fixture.tsx'), {
    GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: appearance, KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch,
    KYBERN_URL: '', KYBERN_TOKEN: '', KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_OPAQUE: '1', STORAGE_FIXTURE: state, KYBERN_NO_ACTIVATE: '1',
  })
  try {
    await fixture.app.getByTestId('fixture-ready').waitFor({ timeoutMs: 60000 })
    await new Promise((r) => setTimeout(r, 1200))
    await fixture.app.screenshot({ path: path.join(out, `${state}-${appearance}.png`) })
    console.log('shot', state, appearance)
  } finally { await fixture.close(); rmSync(scratch, { recursive: true, force: true }) }
}
