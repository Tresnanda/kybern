import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = readFileSync(join(root, 'Cargo.toml'), 'utf8').match(/^version = "([^"]+)"/m)[1]
const fragment = { platform: 'darwin-aarch64', url: 'https://example/kybern.app.tar.gz', signature: 'tauri-sig' }

function manifest(files) {
  const dist = mkdtempSync(join(tmpdir(), 'kybern-manifest-'))
  writeFileSync(join(dist, 'updater-darwin-aarch64.json'), JSON.stringify(fragment))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dist, name), body)
  execFileSync('node', [join(root, 'scripts/updater-manifest.mjs'), '--dist', dist, '--tag', `v${version}`, '--repo', 'o/r'], { stdio: 'pipe' })
  return JSON.parse(readFileSync(join(dist, 'latest.json'), 'utf8'))
}

test('without a GPUIX build the manifest keeps only the Tauri entries', () => {
  const latest = manifest({})
  assert.deepEqual(latest.platforms, { 'darwin-aarch64': { signature: 'tauri-sig', url: fragment.url } })
})

test('a GPUIX tarball and signature add the darwin-aarch64-gpuix entry', () => {
  const asset = `kybern-gpuix_${version}_aarch64.app.tar.gz`
  const latest = manifest({ [asset]: 'x', [`${asset}.sig`]: 'gpuix-sig\n' })
  assert.deepEqual(Object.keys(latest.platforms), ['darwin-aarch64', 'darwin-aarch64-gpuix'])
  assert.deepEqual(latest.platforms['darwin-aarch64-gpuix'], { signature: 'gpuix-sig', url: `https://github.com/o/r/releases/download/v${version}/${asset}` })
  assert.deepEqual(latest.platforms['darwin-aarch64'], { signature: 'tauri-sig', url: fragment.url })
})

test('a GPUIX tarball without its signature is not advertised', () => {
  assert.equal(manifest({ [`kybern-gpuix_${version}_aarch64.app.tar.gz`]: 'x' }).platforms['darwin-aarch64-gpuix'], undefined)
})

test('an Intel GPUIX tarball adds the darwin-x86_64-gpuix entry beside Apple Silicon', () => {
  const arm = `kybern-gpuix_${version}_aarch64.app.tar.gz`
  const intel = `kybern-gpuix_${version}_x86_64.app.tar.gz`
  const latest = manifest({ [arm]: 'x', [`${arm}.sig`]: 'arm-sig', [intel]: 'x', [`${intel}.sig`]: 'intel-sig\n' })
  assert.deepEqual(Object.keys(latest.platforms), ['darwin-aarch64', 'darwin-aarch64-gpuix', 'darwin-x86_64-gpuix'])
  assert.deepEqual(latest.platforms['darwin-x86_64-gpuix'], { signature: 'intel-sig', url: `https://github.com/o/r/releases/download/v${version}/${intel}` })
})
