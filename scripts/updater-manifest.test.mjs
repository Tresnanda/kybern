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

test('a Windows GPUIX installer and signature add the windows-x86_64-gpuix entry', () => {
  const asset = `kybern-gpuix_${version}_x64-setup.exe`
  const latest = manifest({ [asset]: 'x', [`${asset}.sig`]: 'win-sig\n' })
  assert.deepEqual(Object.keys(latest.platforms), ['darwin-aarch64', 'windows-x86_64-gpuix'])
  assert.deepEqual(latest.platforms['windows-x86_64-gpuix'], { signature: 'win-sig', url: `https://github.com/o/r/releases/download/v${version}/${asset}` })
})

test('a Windows GPUIX installer without its signature is not advertised, and Tauri\'s own Windows entry is separate', () => {
  const asset = `kybern-gpuix_${version}_x64-setup.exe`
  assert.equal(manifest({ [asset]: 'x' }).platforms['windows-x86_64-gpuix'], undefined)
  const dist = mkdtempSync(join(tmpdir(), 'kybern-manifest-'))
  writeFileSync(join(dist, 'updater-windows-x86_64.json'), JSON.stringify({ platform: 'windows-x86_64', url: 'https://example/kybern-setup.exe', signature: 'tauri-win' }))
  writeFileSync(join(dist, asset), 'x')
  writeFileSync(join(dist, `${asset}.sig`), 'gpuix-win')
  execFileSync('node', [join(root, 'scripts/updater-manifest.mjs'), '--dist', dist, '--tag', `v${version}`, '--repo', 'o/r'], { stdio: 'pipe' })
  const { platforms } = JSON.parse(readFileSync(join(dist, 'latest.json'), 'utf8'))
  assert.equal(platforms['windows-x86_64'].signature, 'tauri-win')
  assert.equal(platforms['windows-x86_64-gpuix'].signature, 'gpuix-win')
})

test('a failed Windows job leaves no Windows GPUIX entry and does not hold back the macOS ones', () => {
  // desktop.yml's manifest job runs when `gpuix-windows` fails; its artifact is then simply absent.
  const asset = `kybern-gpuix_${version}_aarch64.app.tar.gz`
  const latest = manifest({ [asset]: 'x', [`${asset}.sig`]: 'gpuix-sig' })
  assert.equal(latest.platforms['windows-x86_64-gpuix'], undefined)
  assert.deepEqual(Object.keys(latest.platforms), ['darwin-aarch64', 'darwin-aarch64-gpuix'])
})

test('a Linux GPUIX AppImage and signature add linux-x86_64-gpuix; its deb and rpm stay out of the feed', () => {
  const image = `kybern-gpuix_${version}_x86_64.AppImage`
  const latest = manifest({
    [image]: 'x', [`${image}.sig`]: 'linux-sig\n',
    [`kybern-gpuix_${version}_x86_64.deb`]: 'x', [`kybern-gpuix_${version}_x86_64.rpm`]: 'x',
  })
  assert.deepEqual(Object.keys(latest.platforms), ['darwin-aarch64', 'linux-x86_64-gpuix'])
  assert.deepEqual(latest.platforms['linux-x86_64-gpuix'], { signature: 'linux-sig', url: `https://github.com/o/r/releases/download/v${version}/${image}` })
})

test('a Linux GPUIX AppImage without its signature is not advertised', () => {
  assert.equal(manifest({ [`kybern-gpuix_${version}_x86_64.AppImage`]: 'x' }).platforms['linux-x86_64-gpuix'], undefined)
})

test('a failed Linux job leaves no Linux GPUIX entry and does not hold back the others', () => {
  const mac = `kybern-gpuix_${version}_aarch64.app.tar.gz`, win = `kybern-gpuix_${version}_x64-setup.exe`
  const latest = manifest({ [mac]: 'x', [`${mac}.sig`]: 'gpuix-sig', [win]: 'x', [`${win}.sig`]: 'win-sig' })
  assert.equal(latest.platforms['linux-x86_64-gpuix'], undefined)
  assert.deepEqual(Object.keys(latest.platforms), ['darwin-aarch64', 'darwin-aarch64-gpuix', 'windows-x86_64-gpuix'])
})
