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

test('desktop bundles wait for the gate and dist binaries, and host waits for them', async () => {
  const { workflow, host, allowed } = await releaseJobs()
  const desktop = workflow.split('\n  custom-desktop:\n')[1].split('\n  # Determines if we should publish')[0]
  assert.match(desktop, /needs:[\s\S]*- build-local-artifacts[\s\S]*- custom-release-ci/)
  assert.match(desktop, /uses: \.\/\.github\/workflows\/desktop\.yml/)
  assert.match(host, /needs:[\s\S]*- custom-desktop/)
  for (const result of ['failure', 'cancelled']) assert.equal(allowed('custom-desktop', result), false)
})
