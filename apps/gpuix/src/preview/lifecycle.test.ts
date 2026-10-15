import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
test('browser fallback owns and releases bounded preview sessions', async () => {
 const dir = mkdtempSync(path.join(tmpdir(), 'gpuix-scratch-preview-'))
 try {
  const child = Bun.spawn(['bun', path.join(import.meta.dir, 'lifecycle.verify.ts')], { env: { ...process.env, KYBERN_DATA_DIR: dir, KYBERN_CLIENT_CONFIG_DIR: path.join(dir, 'config') }, stdout: 'pipe', stderr: 'pipe' })
  const output = await new Response(child.stderr).text()
  expect(await child.exited, output).toBe(0)
 } finally { rmSync(dir, { recursive: true, force: true }) }
})
