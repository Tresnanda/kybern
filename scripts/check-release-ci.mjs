import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

// Every job of ci.yml that a release candidate must pass. Ordinary main pushes
// are filtered; version bumps and manual full runs execute all jobs. A skipped
// job cannot qualify a commit for release. The `changes` and `CI`
// bookkeeping jobs are not listed; the run's own conclusion already covers them.
export const requiredJobs = ['rustfmt', 'clippy + test (ubuntu-24.04)', 'clippy + test (macos-15)', 'cargo check (windows-latest)', 'release checks', 'gpuix (typecheck + test)']

export function assessCI(runs, sha) {
  // PR checks may test a merge ref. Require this exact commit from main.
  const run = runs.filter(run => run.head_sha === sha && ['push', 'workflow_dispatch'].includes(run.event) && run.head_branch === 'main')
    .sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt)[0]
  if (!run) return { state: 'waiting', reason: 'No main CI run exists for the release commit yet.' }
  if (run.status !== 'completed') return { state: 'waiting', reason: `CI is ${run.status}.`, run }
  return { state: run.conclusion === 'success' ? 'success' : 'failed', reason: `CI concluded ${run.conclusion}.`, run }
}

export function verifyJobs(jobs) {
  return requiredJobs.every(name => jobs.some(job => job.name === name && job.status === 'completed' && job.conclusion === 'success'))
}

const api = (endpoint) => JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }))

async function main() {
  const sha = process.argv[2] ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const repo = process.env.GITHUB_REPOSITORY ?? 'Tresnanda/kybern'
  if (!/^[0-9a-f]{40}$/.test(sha) || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Invalid release commit or repository.')
  const deadline = Date.now() + 90 * 60_000
  for (;;) {
    const result = assessCI(api(`repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&branch=main&per_page=100`).workflow_runs, sha)
    console.log(`${sha}: ${result.reason}${result.run ? ` ${result.run.html_url}` : ''}`)
    if (result.state === 'failed') throw new Error('Release blocked: exact-commit CI did not pass.')
    if (result.state === 'success') {
      const jobs = api(`repos/${repo}/actions/runs/${result.run.id}/attempts/${result.run.run_attempt}/jobs?per_page=100`).jobs
      if (!verifyJobs(jobs)) throw new Error('Release blocked: required CI jobs are missing, skipped, or unsuccessful. Run CI manually on main at the release commit (gh workflow run ci.yml --ref main), wait for it to pass, then retry the release gate.')
      console.log('Release CI gate passed.')
      return
    }
    if (Date.now() >= deadline) throw new Error('Release blocked: timed out waiting for exact-commit CI.')
    await new Promise(resolve => setTimeout(resolve, 15_000))
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
