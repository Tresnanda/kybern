import { expect, test } from 'bun:test'
import path from 'node:path'

test('latest same-thread selection wins and old events cannot enter a later selection', async () => {
  // Isolate module singletons and transport stubs from every other test file.
  const child = Bun.spawn(['bun', path.join(import.meta.dir, 'verify.selection.ts')], {
    env: { ...process.env, KYBERN_URL: 'ws://127.0.0.1:1/ws', KYBERN_TOKEN: 'fixture-only', KYBERN_GPUIX_ENVIRONMENT: 'local' }, stdout: 'pipe', stderr: 'pipe',
  })
  const code = await child.exited
  const errors = await new Response(child.stderr).text()
  expect({ code, errors }).toEqual({ code: 0, errors: '' })
})
