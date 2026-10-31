import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = readFileSync(join(root, 'Cargo.toml'), 'utf8').match(/^version = "([^"]+)"/m)[1]
const mac = `kybern-gpuix_${version}_aarch64.app.tar.gz`
const macFiles = { [mac]: 'x', [`${mac}.sig`]: 'mac-sig' }

function manifest(files) {
  const dist = mkdtempSync(join(tmpdir(), 'kybern-manifest-'))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dist, name), body)
  execFileSync('node', [join(root, 'scripts/updater-manifest.mjs'), '--dist', dist, '--tag', `v${version}`, '--repo', 'o/r'], { stdio: 'pipe' })
  return JSON.parse(readFileSync(join(dist, 'latest.json'), 'utf8'))
}

test('without any signed GPUIX asset there is no manifest', () => {
  assert.throws(() => manifest({}))
  assert.throws(() => manifest({ [mac]: 'x' }))
})

test('a GPUIX tarball and signature add the darwin-aarch64-gpuix entry, and only -gpuix keys are written', () => {
  const latest = manifest({ [mac]: 'x', [`${mac}.sig`]: 'gpuix-sig\n' })
  assert.equal(latest.version, version)
  assert.deepEqual(Object.keys(latest.platforms), ['darwin-aarch64-gpuix'])
  assert.deepEqual(latest.platforms['darwin-aarch64-gpuix'], { signature: 'gpuix-sig', url: `https://github.com/o/r/releases/download/v${version}/${mac}` })
})

test('a GPUIX tarball without its signature is not advertised', () => {
  const intel = `kybern-gpuix_${version}_x86_64.app.tar.gz`
  assert.equal(manifest({ ...macFiles, [intel]: 'x' }).platforms['darwin-x86_64-gpuix'], undefined)
})

test('an Intel GPUIX tarball adds the darwin-x86_64-gpuix entry beside Apple Silicon', () => {
  const intel = `kybern-gpuix_${version}_x86_64.app.tar.gz`
  const latest = manifest({ ...macFiles, [intel]: 'x', [`${intel}.sig`]: 'intel-sig\n' })
  assert.deepEqual(Object.keys(latest.platforms), ['darwin-aarch64-gpuix', 'darwin-x86_64-gpuix'])
  assert.deepEqual(latest.platforms['darwin-x86_64-gpuix'], { signature: 'intel-sig', url: `https://github.com/o/r/releases/download/v${version}/${intel}` })
})

test('a Windows GPUIX installer and signature add the windows-x86_64-gpuix entry', () => {
  const asset = `kybern-gpuix_${version}_x64-setup.exe`
  const latest = manifest({ ...macFiles, [asset]: 'x', [`${asset}.sig`]: 'win-sig\n' })
  assert.deepEqual(Object.keys(latest.platforms), ['darwin-aarch64-gpuix', 'windows-x86_64-gpuix'])
  assert.deepEqual(latest.platforms['windows-x86_64-gpuix'], { signature: 'win-sig', url: `https://github.com/o/r/releases/download/v${version}/${asset}` })
})

test('a Windows GPUIX installer without its signature is not advertised', () => {
  const asset = `kybern-gpuix_${version}_x64-setup.exe`
  assert.equal(manifest({ ...macFiles, [asset]: 'x' }).platforms['windows-x86_64-gpuix'], undefined)
})

test('a failed Windows job leaves no Windows GPUIX entry and does not hold back the macOS ones', () => {
  // desktop.yml's manifest job runs when `gpuix-windows` fails; its artifact is then simply absent.
  const latest = manifest(macFiles)
  assert.equal(latest.platforms['windows-x86_64-gpuix'], undefined)
  assert.deepEqual(Object.keys(latest.platforms), ['darwin-aarch64-gpuix'])
})

test('a Linux GPUIX AppImage and signature add linux-x86_64-gpuix; its deb and rpm stay out of the feed', () => {
  const image = `kybern-gpuix_${version}_x86_64.AppImage`
  const latest = manifest({
    ...macFiles, [image]: 'x', [`${image}.sig`]: 'linux-sig\n',
    [`kybern-gpuix_${version}_x86_64.deb`]: 'x', [`kybern-gpuix_${version}_x86_64.rpm`]: 'x',
  })
  assert.deepEqual(Object.keys(latest.platforms), ['darwin-aarch64-gpuix', 'linux-x86_64-gpuix'])
  assert.deepEqual(latest.platforms['linux-x86_64-gpuix'], { signature: 'linux-sig', url: `https://github.com/o/r/releases/download/v${version}/${image}` })
})

test('a Linux GPUIX AppImage without its signature is not advertised', () => {
  assert.equal(manifest({ ...macFiles, [`kybern-gpuix_${version}_x86_64.AppImage`]: 'x' }).platforms['linux-x86_64-gpuix'], undefined)
})

test('a failed Linux job leaves no Linux GPUIX entry and does not hold back the others', () => {
  const win = `kybern-gpuix_${version}_x64-setup.exe`
  const latest = manifest({ ...macFiles, [win]: 'x', [`${win}.sig`]: 'win-sig' })
  assert.equal(latest.platforms['linux-x86_64-gpuix'], undefined)
  assert.deepEqual(Object.keys(latest.platforms), ['darwin-aarch64-gpuix', 'windows-x86_64-gpuix'])
})

// A copy of the script in a scratch root whose Cargo.toml carries `version`: the script reads the version beside it.
function manifestAt(version, files) {
  const scratch = mkdtempSync(join(tmpdir(), 'kybern-manifest-root-'))
  mkdirSync(join(scratch, 'scripts'))
  copyFileSync(join(root, 'scripts/updater-manifest.mjs'), join(scratch, 'scripts/updater-manifest.mjs'))
  writeFileSync(join(scratch, 'Cargo.toml'), `[workspace.package]\nversion = "${version}"\n`)
  const dist = join(scratch, 'dist')
  mkdirSync(dist)
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dist, name), body)
  execFileSync('node', [join(scratch, 'scripts/updater-manifest.mjs'), '--dist', dist, '--tag', `v${version}`, '--repo', 'o/r'], { stdio: 'pipe' })
  return { dist, files: readdirSync(dist) }
}

test('a dev release writes latest-dev.json, never latest.json, pointing at its own prerelease', () => {
  const version = '0.21.0-dev.2'
  const asset = `kybern-gpuix_${version}_aarch64.app.tar.gz`
  const { dist, files } = manifestAt(version, { [asset]: 'x', [`${asset}.sig`]: 'dev-sig\n' })
  assert.ok(files.includes('latest-dev.json'))
  assert.ok(!files.includes('latest.json'), 'a dev build must not become the stable feed')
  const feed = JSON.parse(readFileSync(join(dist, 'latest-dev.json'), 'utf8'))
  assert.equal(feed.version, version)
  assert.deepEqual(feed.platforms['darwin-aarch64-gpuix'], { signature: 'dev-sig', url: `https://github.com/o/r/releases/download/v${version}/${asset}` })
})

test('a stable release writes latest.json only', () => {
  const asset = 'kybern-gpuix_0.21.0_aarch64.app.tar.gz'
  const { files } = manifestAt('0.21.0', { [asset]: 'x', [`${asset}.sig`]: 's' })
  assert.ok(files.includes('latest.json'))
  assert.ok(!files.includes('latest-dev.json'))
})
