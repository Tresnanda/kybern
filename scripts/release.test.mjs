import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// A scratch repository on `main` with release.sh, a workspace manifest and a stub `cargo` (the lockfile refresh is not under test).
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kybern-release-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const repo = join(dir, 'repo'), bin = join(dir, 'bin')
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  mkdirSync(bin)
  writeFileSync(join(bin, 'cargo'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(bin, 'cargo'), 0o755)
  copyFileSync(join(root, 'scripts/release.sh'), join(repo, 'scripts/release.sh'))
  writeFileSync(join(repo, 'Cargo.toml'), '[workspace.package]\nversion = "0.20.0"\n')
  writeFileSync(join(repo, 'Cargo.lock'), '[[package]]\nname = "kybern"\nversion = "0.20.0"\n')
  writeFileSync(join(repo, 'app.txt'), 'one')
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test' }
  const git = (...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd: repo, env, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('add', '.')
  git('commit', '-qm', 'base')
  const release = (...args) => spawnSync('bash', ['scripts/release.sh', ...args, '--no-push'], { cwd: repo, env, encoding: 'utf8' })
  const change = (file, body) => { writeFileSync(join(repo, file), body); git('add', file); git('commit', '-qm', `change ${file}`) }
  return { repo, git, release, change }
}

test('a dev release bumps the version and tags vX.Y.Z-dev.N', t => {
  const { repo, git, release } = scratch(t)
  const result = release('0.21.0-dev.1')
  assert.equal(result.status, 0, result.stderr)
  assert.match(readFileSync(join(repo, 'Cargo.toml'), 'utf8'), /^version = "0.21.0-dev.1"$/m)
  assert.equal(git('tag', '--list').trim(), 'v0.21.0-dev.1')
})

test('a stable release promotes only what shipped on Dev', t => {
  const { git, release, change } = scratch(t)
  assert.match(release('0.21.0').stderr, /no dev release to promote/)
  assert.equal(release('0.21.0-dev.1').status, 0)
  change('app.txt', 'two')
  const refused = release('0.21.0')
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, /did not ship in v0\.21\.0-dev\.1:\napp\.txt/)
  // A dependency change in the lockfile did not ship either; its version lines alone do not count.
  assert.equal(release('0.21.0-dev.2').status, 0)
  change('Cargo.lock', '[[package]]\nname = "kybern"\nversion = "0.21.0-dev.2"\nchecksum = "abc"\n')
  assert.match(release('0.21.0').stderr, /checksum = "abc"/)
  assert.equal(release('0.21.0-dev.3').status, 0)
  const promoted = release('0.21.0')
  assert.equal(promoted.status, 0, promoted.stderr)
  assert.match(promoted.stdout, /promoting v0\.21\.0-dev\.3 to the stable track/)
  assert.match(git('tag', '--list', 'v0.21.0'), /v0\.21\.0/)
})

test('--allow-unshipped releases a stable version without a dev build', t => {
  const { release } = scratch(t)
  const result = release('0.20.1', '--allow-unshipped')
  assert.equal(result.status, 0, result.stderr)
})
