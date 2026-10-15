// Explicit scratch thread only: never creates or sends a turn. With `decline`,
// answers its pending secret request; otherwise reads and measures the thread.
import { launchFixture, waitForPainted } from './harness.ts'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const exec = promisify(execFile)
const thread = process.argv[2]
if (!thread) throw new Error('Pass the scratch thread id, optionally followed by decline.')
const decline = process.argv[3] === 'decline'
const out = '/Users/mymac/projects/ade/previews/gpuix/requests'
mkdirSync(out, { recursive: true })
const fixture = await launchFixture(path.join(import.meta.dir, '../main.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: 'dark', KYBERN_URL: '', KYBERN_TOKEN: '', KYBERN_DATA_DIR: '/Users/mymac/projects/ade-gpuix-scratch/data', KYBERN_GPUIX_THREAD: thread, NAPI_RS_NATIVE_LIBRARY_PATH: '/Users/mymac/projects/ade-gpuix/apps/gpuix/native/build/gpuix-native.darwin-arm64.node' })
const app = fixture.app
try {
  if (decline) {
    await app.getByTestId('secret-request-panel').waitFor({ timeoutMs: 60000 })
    await waitForPainted(app, 'Enter value securely')
    await app.screenshot({ path: `${out}/live-secret-dark.png` })
    await app.getByTestId('secret-decline').click()
    await app.getByTestId('composer').waitFor({ timeoutMs: 15000 })
    await waitForPainted(app, 'Ask')
    await app.screenshot({ path: `${out}/live-secret-declined-dark.png` })
    console.log('Verified real scratch approval decline; composer restored.')
  } else {
    await app.getByTestId('user-bubble').waitFor({ timeoutMs: 60000 })
    await waitForPainted(app, 'Worked for')
    await app.screenshot({ path: `${out}/live-thread-dark.png` })
    const sample = await exec('bun', ['perf/sample.ts', '15', `GPUIX=${fixture.pid}`])
    writeFileSync(`${out}/live-thread-perf.txt`, sample.stdout)
    console.log(sample.stdout)
  }
} finally { console.log(fixture.diagnostics()); await fixture.close() }
