// Copy image through the native patch, read back from the system pasteboard.
// The user's clipboard is saved first and restored afterwards.
//   bun src/platform/verify.clipboard.ts <scratch backup dir>
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import path from 'node:path'
import { launch } from '@gpuix/react/automation'

const backup = process.argv[2]!
const pb = path.join(backup, '../pb.swift')
const swift = (...args: string[]) => execFileSync('xcrun', ['swift', pb, ...args], { encoding: 'utf8' }).trim()
console.log(swift('save', backup))
const app = await launch({ command: 'bun', args: [path.join(import.meta.dir, 'clipboard.fixture.tsx')], env: { GPUIX_BACKGROUND: '1' } })
try {
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  await app.getByTestId('copy').click()
  await app.getByTestId('state-copied').waitFor({ timeoutMs: 5000 })
  const read = swift('read')
  console.log(read)
  const expected = statSync(path.join(import.meta.dir, '../../../../assets/release-background.png')).size
  assert.ok(read.includes(`png bytes: ${expected}`), `pasteboard PNG is the copied image (${expected} bytes)`)
  console.log('ok  copy image put the PNG on the system pasteboard')
} finally {
  await app.close()
  console.log(swift('restore', backup))
}
process.exit(0)
