// CPU / footprint / GPU of a streaming answer (caret + fade), as `perf/sample.ts` reports them.
// 10 s warm-up, then 15 s. Window in the background; no screenshots.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { launchFixture } from '../requests/harness.ts'
const exec = promisify(execFile)
for (const reduced of ['0', '1']) {
  const scratch = mkdtempSync(tmpdir() + '/gpuix-stream9perf-')
  const f = await launchFixture(import.meta.dir + '/stream.fixture.tsx', { GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_APPEARANCE: 'dark', KYBERN_REDUCED_MOTION: reduced, KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch, KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_URL: '', KYBERN_TOKEN: '', ...(process.env.KYBERN_FULL_RATE ? { KYBERN_FULL_RATE: '1' } : {}) })
  try {
    await f.app.getByTestId('stream-ready').waitFor({ timeoutMs: 30000 })
    await Bun.sleep(10000)
    const result = await exec('bun', ['perf/sample.ts', '15', `stream-reduced${reduced}=${f.pid}`])
    console.log(`reduced motion ${reduced}; KYBERN_FULL_RATE=${process.env.KYBERN_FULL_RATE ?? 'unset'}\n${result.stdout}`)
  } finally { await f.close(); rmSync(scratch, { recursive: true, force: true }) }
}
process.exit(0)
