// Audit-only relocation of src/requests/perf.verify.ts; assertions and UI steps unchanged.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchFixture, waitForPainted } from '../src/requests/harness.ts'
const exec = promisify(execFile)
const out = '/Users/mymac/projects/ade/previews/gpuix/audit-2026-10-16/adapted'
const fixture = await launchFixture(path.join(import.meta.dir, '../src/requests', 'parity.fixture.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: 'dark', KYBERN_DATA_DIR: process.env.KYBERN_DATA_DIR!, NAPI_RS_NATIVE_LIBRARY_PATH: process.env.NAPI_RS_NATIVE_LIBRARY_PATH ?? path.join(import.meta.dir, '../native/build/gpuix-native.darwin-arm64.node') })
try {
  await waitForPainted(fixture.app, 'Save securely')
  const idle = await exec('bun', ['perf/sample.ts', '15', `GPUIX=${fixture.pid}`])
  writeFileSync(`${out}/request-idle-perf.txt`, idle.stdout)
  console.log(`Static secret request, idle:\n${idle.stdout}`)
  await fixture.app.getByTestId('fixture-native-live').click()
  await waitForPainted(fixture.app, 'Messages arrive at')
  await fixture.app.getByTestId('composer').fill('Please check cancellation as well.')
  await fixture.app.getByTestId('send').click()
  await waitForPainted(fixture.app, 'Waiting for next tool call')
  const active = await exec('bun', ['perf/sample.ts', '15', `GPUIX=${fixture.pid}`])
  writeFileSync(`${out}/native-active-perf.txt`, active.stdout)
  console.log(`Native subagent pending message + visible shared elapsed clock:\n${active.stdout}`)
} finally { console.log(fixture.diagnostics()); await fixture.close() }
