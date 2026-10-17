// A local, signed update feed for checks: a throwaway minisign key in Tauri's
// format, `.app.tar.gz` archives signed the way `tauri signer sign` does (`ED`,
// BLAKE2b-512 prehash, trusted comment), and a loopback server that streams the
// archive slowly enough for the download progress to be seen.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

export function testKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const keyId = randomBytes(8)
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url')
  const pubkey = Buffer.from(`untrusted comment: minisign public key: ${keyId.toString('hex').toUpperCase()}\n${Buffer.concat([Buffer.from('Ed'), keyId, raw]).toString('base64')}\n`).toString('base64')
  const signFile = (data: Uint8Array, file: string) => {
    const sig = sign(null, createHash('blake2b512').update(data).digest(), privateKey)
    const trusted = `timestamp:${Math.floor(Date.now() / 1000)}\tfile:${file}`
    const global = sign(null, Buffer.concat([sig, Buffer.from(trusted)]), privateKey)
    return Buffer.from(`untrusted comment: signature from tauri secret key\n${Buffer.concat([Buffer.from('ED'), keyId, sig]).toString('base64')}\ntrusted comment: ${trusted}\n${global.toString('base64')}\n`).toString('base64')
  }
  return { pubkey, signFile }
}

/** A minimal stand-in bundle with this app's identity, a version file and optional padding. */
export function fakeBundle(dir: string, version: string, padBytes = 0) {
  const app = path.join(dir, 'Kybern GPUIX.app')
  mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true })
  mkdirSync(path.join(app, 'Contents/Resources'), { recursive: true })
  writeFileSync(path.join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.kybern.gpuix</string><key>CFBundleExecutable</key><string>Kybern GPUIX</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>\n`)
  writeFileSync(path.join(app, 'Contents/MacOS/Kybern GPUIX'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  writeFileSync(path.join(app, 'Contents/Resources/version'), version)
  if (padBytes) writeFileSync(path.join(app, 'Contents/Resources/padding.bin'), randomBytes(padBytes))
  return app
}

/** `tar -czf` of one `.app`, the archive Tauri's macOS bundler uploads. */
export function archive(app: string, out: string) {
  execFileSync('/usr/bin/tar', ['-czf', out, '-C', path.dirname(app), path.basename(app)])
  return readFileSync(out)
}

export const RELEASE_NOTES = `## Release Notes

<!-- kybern-release-title: Faster threads and a calmer sidebar -->
<!-- kybern-release-summary: Threads open instantly, the sidebar keeps its place, and updates install in the background. -->

- Open long threads instantly, keeping your reading position.
- Keep the sidebar where you left it across windows.
- Install updates with progress in the app rail.`

/** Serve `latest.json` and the archive; the archive streams in 32 chunks over `ms`, with its length. */
export async function serveFeed(entries: { version: string; archive: Uint8Array; signature: string; notes?: string; ms?: number }) {
  let current = entries
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
    if (url.pathname === '/latest.json') {
      response.writeHead(200, { 'content-type': 'application/json' })
      return response.end(JSON.stringify({
        version: current.version, notes: current.notes ?? RELEASE_NOTES, pub_date: new Date().toISOString(),
        platforms: {
          // The desktop's own artifact must never be picked by GPUIX.
          'darwin-aarch64': { url: `${url.origin}/desktop.app.tar.gz`, signature: 'not-for-gpuix' },
          'darwin-aarch64-gpuix': { url: `${url.origin}/gpuix.app.tar.gz`, signature: current.signature },
        },
      }))
    }
    if (url.pathname === '/gpuix.app.tar.gz') {
      const data = current.archive, chunks = 32, step = Math.ceil(data.length / chunks), wait = (current.ms ?? 2400) / chunks
      response.writeHead(200, { 'content-length': String(data.length), 'content-type': 'application/gzip' })
      for (let i = 0; i < chunks; i++) { await new Promise(r => setTimeout(r, wait)); response.write(data.subarray(i * step, (i + 1) * step)) }
      return response.end()
    }
    response.writeHead(404); response.end('not found')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return { url: `http://127.0.0.1:${port}/latest.json`, set: (next: typeof entries) => { current = next }, stop: () => server.close() }
}
