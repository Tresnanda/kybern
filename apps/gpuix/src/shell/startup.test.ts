import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
test('saved-thread hydration starts alongside list loading', async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'gpuix-startup-test-'))
  try {
    const child = Bun.spawn(['bun', path.join(import.meta.dir, 'verify.startup.ts')], {
      env: { ...process.env, KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_URL: 'ws://127.0.0.1:1/ws', KYBERN_TOKEN: 'fixture', KYBERN_GPUIX_ENVIRONMENT: 'local' }, stdout: 'pipe', stderr: 'pipe',
    })
    const code = await child.exited, errors = await new Response(child.stderr).text()
    expect({ code, errors }).toEqual({ code: 0, errors: '' })
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})

test('prepared history, 100 live prepends, and stale snapshot invalidation preserve data and row identity', async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'gpuix-history-test-'))
  try {
    const child = Bun.spawn(['bun', path.join(import.meta.dir, 'verify.history-paging.ts')], {
      env: { ...process.env, KYBERN_DATA_DIR: scratch, KYBERN_CLIENT_CONFIG_DIR: scratch, KYBERN_URL: 'ws://127.0.0.1:1/ws', KYBERN_TOKEN: 'fixture', KYBERN_GPUIX_ENVIRONMENT: 'local', KYBERN_HISTORY_PREFETCH: '1', KYBERN_STARTUP_TRACE: '0' }, stdout: 'pipe', stderr: 'pipe',
    })
    const code = await child.exited, errors = await new Response(child.stderr).text()
    expect({ code, errors }).toEqual({ code: 0, errors: '' })
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
