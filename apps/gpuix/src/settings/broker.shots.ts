// Evidence captures of the login broker rows: `bun src/settings/broker.shots.ts`. Writes `<out>/<mode>-dark.png`.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchFixture } from '../requests/harness.ts'

const out = process.env.SHOT_OUT ?? '/Users/mymac/projects/ade/.kybern-artifacts/ade-86/broker-fixes'
mkdirSync(out, { recursive: true })
for (const mode of ['broker', 'borrower']) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'gpuix-broker-shots-'))
  const fixture = await launchFixture(path.join(import.meta.dir, 'broker.fixture.tsx'), {
    GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: 'dark', KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch,
    KYBERN_URL: '', KYBERN_TOKEN: '', KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_OPAQUE: '1', BROKER_FIXTURE: mode,
    KYBERN_NO_ACTIVATE: '1', NAPI_RS_NATIVE_LIBRARY_PATH: '/Applications/Kybern GPUIX.app/Contents/Resources/gpuix-native.darwin-arm64.node',
  })
  try {
    await fixture.app.getByTestId('fixture-ready').waitFor({ timeoutMs: 60000 })
    await new Promise((r) => setTimeout(r, 1200))
    await fixture.app.screenshot({ path: `${out}/${mode}-dark.png` })
    console.log('shot', mode)
  } finally { await fixture.close(); rmSync(scratch, { recursive: true, force: true }) }
}
