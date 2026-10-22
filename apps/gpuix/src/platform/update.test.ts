// The updater's pure parts: signature checks (Tauri's minisign format), feed
// parsing (GPUIX's own platform key), and the bundle swap, on scratch folders.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { verifyMinisign } from './minisign.ts'
import { PLATFORM_KEY, readFeed, replaceBundle } from './update.ts'
import { archive, fakeBundle, testKey } from './verify.feed.ts'

let root = ''
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }) })

test('accepts a tauri-signed file and rejects tampering or another key', () => {
  const key = testKey(), other = testKey()
  const data = Buffer.from('kybern update payload')
  const signature = key.signFile(data, 'update.app.tar.gz')
  expect(verifyMinisign(data, signature, key.pubkey).trustedComment).toContain('file:update.app.tar.gz')
  expect(() => verifyMinisign(Buffer.from('kybern update payloaD'), signature, key.pubkey)).toThrow('does not match the download')
  expect(() => verifyMinisign(data, signature, other.pubkey)).toThrow('signed with a different key')
  // An edited trusted comment breaks the global signature.
  const lines = Buffer.from(signature, 'base64').toString().split('\n')
  lines[2] = 'trusted comment: timestamp:0\tfile:evil'
  expect(() => verifyMinisign(data, Buffer.from(lines.join('\n')).toString('base64'), key.pubkey)).toThrow('trusted comment was altered')
})

test('reads only the GPUIX platform entry and ignores older versions', async () => {
  const feed = (body: unknown) => (async () => Response.json(body)) as unknown as typeof fetch
  const platforms = { 'darwin-aarch64': { url: 'https://example/desktop.tar.gz', signature: 's' } }
  expect(await readFeed('0.9.1', ['x'], feed({ version: '0.9.1', platforms }))).toBeNull()
  expect(await readFeed('0.9.1', ['x'], feed({ version: '0.9.2', platforms }))).toMatchObject({ version: '0.9.2', entry: null })
  const ours = await readFeed('0.9.1', ['x'], feed({ version: 'v0.9.2', notes: 'n', platforms: { ...platforms, [PLATFORM_KEY]: { url: 'https://example/gpuix.tar.gz', signature: 'g' } } }))
  expect(ours).toEqual({ version: '0.9.2', notes: 'n', entry: { url: 'https://example/gpuix.tar.gz', signature: 'g' } })
})

// The swap reads the new bundle's identifier with macOS's PlistBuddy, so this runs on macOS only.
test.skipIf(process.platform !== 'darwin')('swaps the bundle in place and refuses another app’s archive', async () => {
  root = mkdtempSync(path.join(tmpdir(), 'kybern-update-'))
  const installed = fakeBundle(path.join(root, 'Applications'), '0.9.1')
  const next = fakeBundle(path.join(root, 'next'), '0.9.2')
  await replaceBundle(installed, archive(next, path.join(root, 'next.tar.gz')))
  expect(readFileSync(path.join(installed, 'Contents/Resources/version'), 'utf8')).toBe('0.9.2')
  // Nothing staged is left beside the app.
  expect(readdirSync(path.join(root, 'Applications'))).toEqual(['Kybern GPUIX.app'])
  const foreign = fakeBundle(path.join(root, 'foreign'), '9.9.9')
  writeFileSync(path.join(foreign, 'Contents/Info.plist'), readFileSync(path.join(foreign, 'Contents/Info.plist'), 'utf8').replace('dev.kybern.gpuix', 'dev.kybern.desktop'))
  await expect(replaceBundle(installed, archive(foreign, path.join(root, 'foreign.tar.gz')))).rejects.toThrow('The update is for dev.kybern.desktop, not this one')
  expect(readFileSync(path.join(installed, 'Contents/Resources/version'), 'utf8')).toBe('0.9.2')
})
