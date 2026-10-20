// The release job signs `Kybern GPUIX.app.tar.gz` with `tauri signer sign`;
// this signs a scratch file with the real Tauri CLI and a throwaway key, then
// checks `minisign.ts` accepts the result. Skipped where the desktop
// dependencies are not installed.
import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { verifyMinisign } from './minisign.ts'

const cli = path.resolve(import.meta.dir, '../../../desktop/node_modules/@tauri-apps/cli/tauri.js')
let dir = ''
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

test.skipIf(!existsSync(cli))('accepts what `tauri signer sign` writes for a release archive', () => {
  dir = mkdtempSync(path.join(tmpdir(), 'kybern-sign-'))
  const key = path.join(dir, 'updater.key'), archive = path.join(dir, 'Kybern GPUIX.app.tar.gz')
  const env = { ...process.env }
  // The app's native loader override must not select GPUIX as Tauri's addon.
  delete env.NAPI_RS_NATIVE_LIBRARY_PATH
  execFileSync('node', [cli, 'signer', 'generate', '--ci', '-p', '', '-w', key], { stdio: 'pipe', env })
  writeFileSync(archive, 'kybern gpuix release archive')
  execFileSync('node', [cli, 'signer', 'sign', '-f', key, '-p', '', archive], { stdio: 'pipe', env })
  // The updater feed carries the .sig file's text as-is; the public key is the base64 of the .pub file.
  const signature = readFileSync(`${archive}.sig`, 'utf8').trim()
  const pubkey = readFileSync(`${key}.pub`, 'utf8').trim()
  const { trustedComment } = verifyMinisign(readFileSync(archive), signature, pubkey)
  expect(trustedComment).toContain('Kybern GPUIX.app.tar.gz')
  expect(() => verifyMinisign(Buffer.from('tampered'), signature, pubkey)).toThrow('does not match the download')
})
