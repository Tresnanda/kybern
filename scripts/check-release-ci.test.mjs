import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assessCI, requiredJobs, verifyJobs } from './check-release-ci.mjs'
const sha = 'a'.repeat(40)
const run = { id: 1, head_sha: sha, head_branch: 'main', event: 'push', run_number: 1, run_attempt: 1, status: 'completed', conclusion: 'success' }
test('only an exact main push qualifies', () => {
  for (const change of [{ head_sha: 'b'.repeat(40) }, { event: 'pull_request' }, { head_branch: 'feature' }]) assert.equal(assessCI([{ ...run, ...change }], sha).state, 'waiting')
  assert.equal(assessCI([run], sha).state, 'success')
})
test('pending or unsuccessful CI cannot publish', () => {
  assert.equal(assessCI([{ ...run, status: 'in_progress' }], sha).state, 'waiting')
  for (const conclusion of ['failure', 'cancelled', 'skipped', 'neutral', 'timed_out', null]) assert.equal(assessCI([{ ...run, conclusion }], sha).state, 'failed')
})
test('latest run and attempt take precedence over prior success', () => {
  assert.equal(assessCI([run, { ...run, run_attempt: 2, conclusion: 'failure' }], sha).state, 'failed')
  assert.equal(assessCI([run, { ...run, run_number: 2, status: 'queued' }], sha).state, 'waiting')
})
test('every required job must complete successfully', () => {
  const jobs = requiredJobs.map(name => ({ name, status: 'completed', conclusion: 'success' }))
  assert.equal(verifyJobs(jobs), true)
  assert.equal(verifyJobs(jobs.slice(1)), false)
  assert.equal(verifyJobs(jobs.map((job, i) => i ? job : { ...job, conclusion: 'skipped' })), false)
})

async function releaseJobs() {
  const { readFileSync } = await import('node:fs')
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  const host = workflow.split('\n  host:\n')[1].split('\n  announce:')[0]
  const expression = host.match(/if: \$\{\{ (.*) \}\}/)[1]
  // Whether host runs when `job` ends with `result` and every other job succeeds.
  const allowed = (job, result) => {
    const js = expression.replaceAll('always()', 'true')
      .replaceAll("needs.plan.outputs.publishing", "'true'")
      .replace(/needs\.([\w-]+)\.result/g, (_, name) => JSON.stringify(name === job ? result : 'success'))
    return Function(`return (${js})`)()
  }
  return { workflow, host, allowed }
}

test('generated release host blocks a failed or cancelled gate', async () => {
  const { host, allowed } = await releaseJobs()
  assert.match(host, /needs:[\s\S]*- custom-release-ci/)
  assert.equal(allowed('custom-release-ci', 'success'), true)
  for (const result of ['failure', 'cancelled']) assert.equal(allowed('custom-release-ci', result), false)
})

test('desktop bundles start with the daemon archives, and host waits for them and for the gate', async () => {
  const { workflow, host, allowed } = await releaseJobs()
  const desktop = workflow.split('\n  custom-desktop:\n')[1].split('\n  # Determines if we should publish')[0]
  const needs = desktop.match(/    needs:\n((?:      - [\w-]+\n)+)/)[1].split('\n').map(line => line.replace('      - ', '')).filter(Boolean)
  // The bundles are the longest phase and need only the archives; the gate waits for CI.
  assert.deepEqual(needs, ['plan', 'build-local-artifacts'])
  assert.match(desktop, /uses: \.\/\.github\/workflows\/desktop\.yml/)
  assert.match(host, /needs:[\s\S]*- custom-release-ci[\s\S]*- custom-desktop/)
  for (const result of ['failure', 'cancelled']) assert.equal(allowed('custom-desktop', result), false)
})

test('every required job is a job of ci.yml, and main runs all of them', async () => {
  const { readFileSync } = await import('node:fs')
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const jobs = workflow.split('\njobs:\n')[1].split(/\n  (?=[\w-]+:\n)/)
  const names = jobs.flatMap(job => {
    const template = job.match(/^    name: (.*)$/m)?.[1]
    if (!template) return []
    // Expand `${{ matrix.key }}` over the `key: [a, b]` lists of the job's matrix.
    const lists = Object.fromEntries([...job.matchAll(/^        (\w+): \[(.*)\]$/gm)].map(([, key, values]) => [key, values.split(',').map(value => value.trim())]))
    const keys = Object.keys(lists)
    if (!keys.length) return [template]
    return keys.flatMap(key => lists[key].map(value => template.replace(`\${{ matrix.${key} }}`, value)))
  })
  for (const name of requiredJobs) assert.ok(names.includes(name), `ci.yml has no job named "${name}"`)
  // A pull request may skip a job through the `changes` job; a push must not.
  const changes = jobs.find(job => job.trimStart().startsWith('changes:'))
  assert.match(changes, /if \[ "\$EVENT" != pull_request \]; then\n\s+files=ALL/)
})

test('GPUIX bundles both macOS targets from dist binaries without compiling the daemon', async () => {
  const { readFileSync } = await import('node:fs')
  const workflow = readFileSync(new URL('../.github/workflows/desktop.yml', import.meta.url), 'utf8')
  const gpuix = workflow.split('\n  gpuix:\n')[1].split('\n  gpuix-linux:')[0]
  assert.match(gpuix, /- target: aarch64-apple-darwin\n\s+os: macos-15/)
  assert.match(gpuix, /- target: x86_64-apple-darwin\n\s+os: macos-15/)
  // Linux and Windows are jobs of their own; nothing about them lives in the macOS matrix.
  assert.doesNotMatch(gpuix, /windows-2022|msvc|ubuntu|unknown-linux|bundle-gpuix-linux|continue-on-error|matrix\.beta/)
  assert.match(gpuix, /dist-binaries\.mjs --target "\$KYBERN_GPUIX_TARGET"/)
  assert.match(gpuix, /--pattern "kybern-\$KYBERN_GPUIX_TARGET\.\*"/)
  assert.doesNotMatch(gpuix, /cargo build/)
  assert.match(gpuix, /name: desktop-gpuix-\$\{\{ matrix\.target \}\}/)
})

test('the Linux GPUIX beta is its own job: dist\'s musl binaries on the ubuntu-22.04 glibc floor, and its failure cannot skip the manifest', async () => {
  const { readFileSync } = await import('node:fs')
  const workflow = readFileSync(new URL('../.github/workflows/desktop.yml', import.meta.url), 'utf8')
  const linux = workflow.split('\n  gpuix-linux:\n')[1].split('\n  gpuix-windows:')[0]
  assert.match(linux, /runs-on: ubuntu-22\.04/)
  assert.doesNotMatch(linux, /matrix\./)
  assert.match(linux, /KYBERN_DIST_TARGET: x86_64-unknown-linux-musl/)
  assert.match(linux, /dist-binaries\.mjs --target "\$KYBERN_DIST_TARGET"/)
  assert.match(linux, /--pattern "kybern-\$KYBERN_DIST_TARGET\.\*"/)
  assert.match(linux, /scripts\/bundle-gpuix-linux\.sh/)
  assert.doesNotMatch(linux, /cargo build|continue-on-error/)
  assert.match(linux, /name: desktop-gpuix-x86_64-unknown-linux-gnu/)
  const manifest = workflow.split('\n  manifest:\n')[1]
  assert.match(manifest, /\(needs\.gpuix-linux\.result == 'success' \|\| needs\.gpuix-linux\.result == 'failure'\)/)
})

test('the Windows GPUIX beta is its own job: its failure cannot skip the manifest, and its installer is checked before upload', async () => {
  const { readFileSync } = await import('node:fs')
  const workflow = readFileSync(new URL('../.github/workflows/desktop.yml', import.meta.url), 'utf8')
  const windows = workflow.split('\n  gpuix-windows:\n')[1].split('\n  manifest:')[0]
  assert.match(windows, /runs-on: windows-2022/)
  assert.doesNotMatch(windows, /matrix\./)
  assert.match(windows, /scripts\/bundle-gpuix-windows\.sh/)
  assert.match(windows, /dist-binaries\.mjs --target "\$KYBERN_GPUIX_TARGET"/)
  assert.doesNotMatch(windows, /cargo build/)
  assert.match(windows, /name: desktop-gpuix-x86_64-pc-windows-msvc/)
  // The blocking installer check (smoke run included) precedes the upload; only the real-launch step is informational.
  const check = windows.indexOf('verify-install.ps1 \\\n'), upload = windows.indexOf('actions/upload-artifact')
  assert.ok(check > 0 && check < upload, 'verify-install.ps1 must run before the upload')
  const checkStep = windows.slice(windows.lastIndexOf('      - name:', check), upload)
  assert.doesNotMatch(checkStep, /continue-on-error/)
  assert.match(windows.slice(upload), /name: Launch the installed app\n\s+continue-on-error: true/)
  assert.doesNotMatch(windows.slice(0, upload), /continue-on-error/)
  // The manifest needs the macOS job to succeed and takes the Linux and Windows jobs either way.
  const manifest = workflow.split('\n  manifest:\n')[1]
  assert.match(manifest, /needs: \[bundle, gpuix, gpuix-linux, gpuix-windows\]/)
  assert.match(manifest, /needs\.gpuix\.result == 'success'/)
  assert.match(manifest, /\(needs\.gpuix-windows\.result == 'success' \|\| needs\.gpuix-windows\.result == 'failure'\)/)
})

test('actions in the GPUIX workflows are pinned to a commit, setup-python included', async () => {
  const { readFileSync } = await import('node:fs')
  for (const file of ['desktop.yml', 'gpuix-addon.yml', 'gpuix-platforms.yml']) {
    const workflow = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8')
    for (const [, action] of workflow.matchAll(/uses: (actions\/setup-python@\S+)/g)) assert.match(action, /@[0-9a-f]{40}$/, `${file}: ${action}`)
  }
})
