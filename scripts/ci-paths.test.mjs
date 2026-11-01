import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { affectedJobs, selectJobs, withoutWorkspaceVersion, workspaceVersion } from './ci-paths.mjs'

const all = { rust: true, release: true, gpuix: true }
const none = { rust: false, release: false, gpuix: false }
const manifest = version => `[workspace]\nmembers = []\n[workspace.package]\nversion = "${version}"\nedition = "2024"\n[workspace.dependencies]\n`

test('ordinary changes run only affected jobs, including cache inputs', () => {
  assert.deepEqual(affectedJobs(['README.md', 'docs/architecture.md']), none)
  assert.deepEqual(affectedJobs(['crates/kybern-daemon/src/lib.rs']), { ...none, rust: true })
  assert.deepEqual(affectedJobs(['apps/gpuix/src/App.tsx']), { ...none, gpuix: true })
  assert.deepEqual(affectedJobs(['packages/kybern-client/src/types.ts']), { ...none, gpuix: true })
  assert.deepEqual(affectedJobs(['Cargo.lock', '.cargo/config.toml']), { ...none, rust: true })
  // The test jobs read nextest's profiles and run the flaky-test reporter.
  assert.deepEqual(affectedJobs(['.config/nextest.toml']), { ...none, rust: true })
  assert.deepEqual(affectedJobs(['scripts/report-flaky-tests.mjs']), { ...none, rust: true, release: true })
  assert.deepEqual(affectedJobs(['apps/gpuix/pnpm-lock.yaml']), { ...none, gpuix: true })
  assert.deepEqual(affectedJobs(['scripts/release.sh']), { ...none, release: true })
  assert.deepEqual(affectedJobs(['crates/kybern-daemon/src/visuals/test.ts']), { ...none, rust: true, gpuix: true })
  for (const file of ['.github/workflows/ci.yml', '.github/actions/setup-pnpm-apps/action.yml', 'scripts/ci-paths.mjs', 'scripts/ci-paths.test.mjs']) {
    assert.deepEqual(affectedJobs([file]), all, file)
  }
})

test('workspace version ignores versions in other TOML tables', () => {
  assert.equal(workspaceVersion('[package]\nversion = "9"\n' + manifest('1.2.3')), '1.2.3')
  assert.throws(() => workspaceVersion('[package]\nversion = "9"\n'))
})

test('PR pagination retains deleted and previous filenames', () => {
  const jobs = selectJobs('pull_request', { number: 7 }, 'owner/repo', (bin, args) => {
    assert.equal(bin, 'gh')
    assert.deepEqual(args, ['api', '--paginate', '--slurp', 'repos/owner/repo/pulls/7/files?per_page=100'])
    return JSON.stringify([
      [{ filename: 'docs/moved.md', previous_filename: 'crates/old.rs', status: 'renamed' }],
      [{ filename: 'apps/gpuix/deleted.ts', status: 'removed' }],
    ])
  })
  assert.deepEqual(jobs, { ...none, rust: true, gpuix: true })
})

const lock = version => `version = 4\n\n[[package]]\nname = "kybern"\nversion = "${version}"\ndependencies = [\n "serde",\n]\n\n[[package]]\nname = "serde"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "ab"\n`

test('a workspace version bump is recognised in Cargo.toml and Cargo.lock, and nothing else is', () => {
  const same = (file, a, b) => withoutWorkspaceVersion(file, a) === withoutWorkspaceVersion(file, b)
  assert.equal(same('Cargo.toml', manifest('1.0.0'), manifest('1.1.0')), true)
  assert.equal(same('Cargo.toml', manifest('1.0.0'), manifest('1.1.0') + 'serde = "1"\n'), false)
  // A dependency declared as a table has a `version` line of its own.
  const table = version => manifest('1.0.0') + `[workspace.dependencies.serde]\nversion = "${version}"\n`
  assert.equal(same('Cargo.toml', table('1.0.0'), table('1.0.1')), false)
  assert.equal(same('Cargo.lock', lock('1.0.0'), lock('1.1.0')), true)
  assert.equal(same('Cargo.lock', lock('1.0.0'), lock('1.0.0').replace('version = "1.0.0"\nsource', 'version = "1.0.1"\nsource')), false)
  assert.equal(same('Cargo.lock', lock('1.0.0'), lock('1.0.0').replace(' "serde",\n', ' "serde",\n "tokio",\n')), false)
  assert.throws(() => withoutWorkspaceVersion('crates/a/Cargo.toml', ''))
})

test('a pull request that only bumps the version runs no test jobs; main runs the full suite for it', () => {
  const event = { number: 9, pull_request: { base: { sha: 'b'.repeat(40) }, head: { sha: 'c'.repeat(40) } } }
  const contents = {
    [`Cargo.toml@${'b'.repeat(40)}`]: manifest('1.0.0'), [`Cargo.toml@${'c'.repeat(40)}`]: manifest('1.1.0'),
    [`Cargo.lock@${'b'.repeat(40)}`]: lock('1.0.0'), [`Cargo.lock@${'c'.repeat(40)}`]: lock('1.1.0'),
  }
  const pr = (files, overrides = {}) => selectJobs('pull_request', event, 'owner/repo', (bin, args) => {
    assert.equal(bin, 'gh')
    if (args[1] === '--paginate') return JSON.stringify([files.map(filename => ({ filename }))])
    assert.deepEqual(args.slice(0, 3), ['api', '-H', 'Accept: application/vnd.github.raw'])
    const [, file, ref] = args[3].match(/^repos\/owner\/repo\/contents\/([\w.]+)\?ref=(\w+)$/)
    const key = `${file}@${ref}`
    if (key in overrides) return overrides[key]
    return contents[key]
  })
  assert.deepEqual(pr(['Cargo.toml', 'Cargo.lock', 'CHANGELOG.md']), none)
  // Other files in the same pull request are filtered as usual.
  assert.deepEqual(pr(['Cargo.toml', 'Cargo.lock', 'CHANGELOG.md', 'crates/kybern-drivers/src/lib.rs']), { ...none, rust: true })
  // A dependency change in the lock file, or a manifest that cannot be read, is a real change.
  assert.deepEqual(pr(['Cargo.toml', 'Cargo.lock'], { [`Cargo.lock@${'c'.repeat(40)}`]: lock('1.1.0') + '\n[[package]]\nname = "x"\nversion = "1.0.0"\nsource = "registry+x"\n' }), { ...none, rust: true })
  assert.deepEqual(pr(['Cargo.toml'], { [`Cargo.toml@${'c'.repeat(40)}`]: '[package]\nname = "x"\n' }), { ...none, rust: true, release: true })
  assert.deepEqual(pr(['Cargo.lock'], { [`Cargo.lock@${'c'.repeat(40)}`]: lock('1.0.0') }), { ...none, rust: true })
  assert.deepEqual(selectJobs('pull_request', { number: 9 }, 'owner/repo', () => JSON.stringify([[{ filename: 'Cargo.toml' }]])), { ...none, rust: true, release: true })
})

test('unknown or incomplete comparisons fall back to full checks', () => {
  const fail = () => { throw new Error('unavailable') }
  assert.deepEqual(selectJobs('pull_request', { number: 7 }, 'owner/repo', fail), all)
  assert.deepEqual(selectJobs('pull_request', { number: 7 }, 'owner/repo', () => JSON.stringify([Array.from({ length: 3000 }, () => ({ filename: 'README.md' }))])), all)
  assert.deepEqual(selectJobs('push', { ref: 'refs/heads/main', before: '0'.repeat(40), after: 'a'.repeat(40) }, '', fail), all)
  assert.deepEqual(selectJobs('push', { ref: 'refs/heads/main', before: 'b'.repeat(40), after: 'a'.repeat(40) }, '', fail), all)
  assert.deepEqual(selectJobs('workflow_dispatch', {}, '', fail), all)
})

test('main compares the entire push, fetches a shallow base, and runs full checks for a release version', t => {
  const root = mkdtempSync(join(tmpdir(), 'kybern-ci-paths-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  mkdirSync(repo)
  const run = (bin, args, cwd = repo) => execFileSync(bin, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const git = (...args) => run('git', args)
  const write = (file, content) => writeFileSync(join(repo, file), content)
  const commit = message => {
    git('add', '.')
    git('-c', 'user.name=CI test', '-c', 'user.email=ci@example.test', '-c', 'commit.gpgsign=false', 'commit', '-m', message)
    return git('rev-parse', 'HEAD').trim()
  }
  const jobs = (before, after, executor = run) => selectJobs('push', { ref: 'refs/heads/main', before, after }, '', executor)
  git('init', '-b', 'main')
  write('Cargo.toml', manifest('1.0.0'))
  mkdirSync(join(repo, 'crates'))
  write('crates/old.rs', '// old')
  const base = commit('base')
  write('README.md', 'docs')
  const docs = commit('docs')
  assert.deepEqual(jobs(base, docs), none)
  write('crates/old.rs', '// updated')
  commit('code')
  write('README.md', 'more docs')
  const head = commit('docs after code')
  assert.deepEqual(jobs(docs, head), { ...none, rust: true })

  // A depth-one Actions checkout does not have the pre-push commit.
  const clone = join(root, 'shallow')
  git('clone', '--depth=1', `file://${repo}`, clone)
  let fetched = false
  assert.deepEqual(jobs(docs, head, (bin, args) => {
    if (args[0] === 'fetch') fetched = true
    return run(bin, args, clone)
  }), { ...none, rust: true })
  assert.equal(fetched, true)

  renameSync(join(repo, 'crates/old.rs'), join(repo, 'archived.txt'))
  const renamed = commit('move code out of crates')
  assert.deepEqual(jobs(head, renamed), { ...none, rust: true })
  write('Cargo.toml', manifest('1.0.1-dev.1'))
  const dev = commit('dev release')
  // A dev release needs only main's latest CI on its commit to pass, so its bump runs the affected jobs.
  assert.deepEqual(jobs(renamed, dev), { ...none, rust: true, release: true })
  write('Cargo.toml', manifest('1.0.1'))
  const release = commit('release')
  assert.deepEqual(jobs(dev, release), all)
})
