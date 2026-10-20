import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { launchFixture } from '../requests/harness.ts'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)
for (let i = 1; i <= 2; i++) {
  const scratch = mkdtempSync(tmpdir() + '/gpuix-p3-stream-')
  const f = await launchFixture(import.meta.dir + (process.argv[2] === 'two' ? '/stream.fixture.tsx' : '/../transcript/stream.fixture.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch, KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_URL: '', KYBERN_TOKEN: '', KYBERN_APPEARANCE: process.env.KYBERN_APPEARANCE ?? 'dark' })
  try {
    await f.app.getByTestId('stream-ready').waitFor()
    await new Promise(r => setTimeout(r, 10000))
    const result = await exec('bun', ['perf/sample.ts', '15', `stream-${process.argv[2]}-${i}=${f.pid}`])
    console.log(result.stdout)
  } finally { await f.close(); rmSync(scratch, { recursive: true, force: true }) }
}
process.exit(0)
