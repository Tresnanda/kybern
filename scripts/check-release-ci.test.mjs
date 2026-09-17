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

test('generated release host blocks a failed or cancelled gate', async () => {
  const { readFileSync } = await import('node:fs')
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  const host = workflow.split('\n  host:\n')[1].split('\n  announce:')[0]
  assert.match(host, /needs:[\s\S]*- custom-release-ci/)
  const expression = host.match(/if: \$\{\{ (.*) \}\}/)[1]
  const allowed = (gate) => {
    const js = expression.replaceAll('always()', 'true')
      .replaceAll("needs.plan.outputs.publishing", "'true'")
      .replace(/needs\.([\w-]+)\.result/g, (_, job) => JSON.stringify(job === 'custom-release-ci' ? gate : 'success'))
    return Function(`return (${js})`)()
  }
  assert.equal(allowed('success'), true)
  for (const result of ['failure', 'cancelled']) assert.equal(allowed(result), false)
})
