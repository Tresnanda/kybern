import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

test('tab groups: migration, openers, split and move, close and reopen, retarget, persistence, close pane keys', async () => {
  const scratch = mkdtempSync(tmpdir() + '/gpuix-scratch-tabs-')
  try {
    // The fixture never connects: selection and tabs are local state, written to the scratch UI file.
    const child = Bun.spawn(['bun', import.meta.dir + '/verify.store.ts'], { env: { ...process.env, KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_GPUIX_CREDENTIALS_DIR: scratch, KYBERN_URL: 'ws://127.0.0.1:1/ws', KYBERN_TOKEN: 'fixture', KYBERN_GPUIX_ENVIRONMENT: 'local' }, stdout: 'pipe', stderr: 'pipe' })
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect({ code, errors: errors.split('\n').filter((line) => line && !line.startsWith('gpuix persist')).join('\n') }).toEqual({ code: 0, errors: '' })
    expect(output).toContain('PASS ⌘⇧W closes the focused pane')
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
