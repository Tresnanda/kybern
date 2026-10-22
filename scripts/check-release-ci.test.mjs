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
  const gpuix = workflow.split('\n  gpuix:\n')[1].split('\n  manifest:')[0]
  assert.match(gpuix, /target: \[aarch64-apple-darwin, x86_64-apple-darwin\]/)
  assert.match(gpuix, /dist-binaries\.mjs --target "\$KYBERN_GPUIX_TARGET"/)
  assert.match(gpuix, /--pattern "kybern-\$KYBERN_GPUIX_TARGET\.\*"/)
  assert.doesNotMatch(gpuix, /cargo build/)
  assert.match(gpuix, /name: desktop-gpuix-\$\{\{ matrix\.target \}\}/)
})
