import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
test('pane transport isolation and selection races in an isolated process', async () => {
  const scratch = mkdtempSync(tmpdir() + '/gpuix-scratch-panes-')
  try {
    const child = Bun.spawn(['bun', import.meta.dir + '/verify.state.ts'], { env: { ...process.env, KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch, KYBERN_URL: '', KYBERN_TOKEN: '', KYBERN_GPUIX_ENVIRONMENT: 'local' }, stdout: 'pipe', stderr: 'pipe' })
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect({ code, errors }).toEqual({ code: 0, errors: '' })
    expect(output).toContain('PASS different threads')
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
