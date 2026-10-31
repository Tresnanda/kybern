/**
 * ADE-97 Actions fixtures for `verify.fixture.ts`: kybern's own CI graph (`changes` → six checks → `CI`) on a default branch
 * with release tags and four branches with pull requests; a failed run (#685, `clippy + test (ubuntu-24.04)`), a running
 * second attempt (#700) and a GPUIX platforms dispatch whose workflow file can't be read (run order). `big`: 100 runs over
 * 24 branches and a 40-job run (#900), for the performance check. Deterministic apart from times relative to now.
 */
import type { ActionsRunResult, WorkflowJob, WorkflowJobSpec, WorkflowRun, WorkflowStep } from '../../../../packages/kybern-client/src/types.ts'

const NOW = Date.now()
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const MIN = 60_000

export const CI_SPECS: WorkflowJobSpec[] = [
  { id: 'changes', name: 'changes' },
  { id: 'fmt', name: 'rustfmt', needs: ['changes'], conditional: true },
  { id: 'check', name: 'clippy + test (${{ matrix.os }})', needs: ['changes'], matrix: ['os'], conditional: true },
  { id: 'windows-check', name: 'cargo check (windows-latest)', needs: ['changes'], conditional: true },
  { id: 'gpuix', name: 'gpuix (typecheck + test)', needs: ['changes'], conditional: true },
  { id: 'release', name: 'release checks', needs: ['changes'], conditional: true },
  { id: 'ci', name: 'CI', needs: ['changes', 'fmt', 'check', 'windows-check', 'release', 'gpuix'], conditional: true },
]

const SHA = '6fb63cd31f2a0e7d5c4b3a291807f6e5d4c3b2a1'
function run(id: number, over: Partial<WorkflowRun>): WorkflowRun {
  return {
    id, number: id, attempt: 1, workflow_name: 'CI', workflow_id: 1, workflow_path: '.github/workflows/ci.yml', title: 'Fix the importer',
    head_branch: 'main', head_sha: SHA, event: 'push', status: 'completed', conclusion: 'success', url: `https://example.com/runs/${id}`,
    created_at: at(30 * MIN), started_at: at(30 * MIN), updated_at: at(30 * MIN - 501_000), actor: 'Tresnanda', ...over,
  }
}

/** The runs, newest first, as GitHub lists them. */
export function actionRuns(big = false): WorkflowRun[] {
  const runs: WorkflowRun[] = [
    // A pull request's second attempt, running.
    run(3, { number: 700, attempt: 2, title: 'Preserve reading position while streaming', head_branch: 'fix/reading-position', head_sha: '4c2e9d1a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e', event: 'pull_request', status: 'in_progress', conclusion: '', created_at: at(4.3 * MIN), started_at: at(4.2 * MIN), updated_at: at(10_000) }),
    run(60, { number: 699, title: 'docs: redesign README with modern layout and quick install matrix (#169)', created_at: at(22 * MIN), started_at: at(22 * MIN), updated_at: at(22 * MIN - 521_000) }),
    run(61, { number: 698, title: 'Speed up machine port forwarding with direct connections', head_branch: 'feat/ade-104-direct-ports', event: 'pull_request', created_at: at(24 * MIN), started_at: at(24 * MIN), updated_at: at(24 * MIN - 480_000) }),
    run(62, { number: 697, title: 'docs: redesign README with modern layout', head_branch: 'docs/redesign-readme', event: 'pull_request', created_at: at(29 * MIN), started_at: at(29 * MIN), updated_at: at(29 * MIN - 490_000) }),
    run(70, { number: 566, workflow_name: 'Release', workflow_id: 3, workflow_path: '.github/workflows/release.yml', title: 'Speed up machine port forwarding with direct connections', head_branch: 'feat/ade-104-direct-ports', event: 'pull_request', created_at: at(24 * MIN), started_at: at(24 * MIN), updated_at: at(23 * MIN) }),
    run(71, { number: 564, workflow_name: 'Release', workflow_id: 3, workflow_path: '.github/workflows/release.yml', title: 'docs: redesign README with modern layout', head_branch: 'docs/redesign-readme', event: 'pull_request', conclusion: 'failure', created_at: at(29 * MIN), started_at: at(29 * MIN), updated_at: at(28 * MIN) }),
    run(63, { number: 692, title: 'Fix Cursor long-context model selections', head_branch: 'fix/ade-106-cursor-models', event: 'pull_request', created_at: at(62 * MIN), started_at: at(62 * MIN), updated_at: at(54 * MIN) }),
    run(2, { number: 685, title: 'Read thinking-only answers in thread history (#161)', head_sha: '81fbeab0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6', conclusion: 'failure', created_at: at(2 * 60 * MIN), started_at: at(2 * 60 * MIN), updated_at: at(2 * 60 * MIN - 503_000) }),
    run(1, { number: 41, workflow_name: 'GPUIX platforms', workflow_id: 2, workflow_path: '.github/workflows/gpuix-platforms.yml', title: 'GPUIX platforms', event: 'workflow_dispatch', created_at: at(3 * 60 * MIN), started_at: at(3 * 60 * MIN), updated_at: at(3 * 60 * MIN - 900_000) }),
    run(72, { number: 560, workflow_name: 'Release', workflow_id: 3, workflow_path: '.github/workflows/release.yml', title: 'Release 0.20.4', head_branch: 'v0.20.4', created_at: at(5 * 60 * MIN), started_at: at(5 * 60 * MIN), updated_at: at(4 * 60 * MIN) }),
    run(80, { number: 60, workflow_name: 'Dist cache', workflow_id: 4, workflow_path: '.github/workflows/dist-cache.yml', title: 'Dist cache', status: 'queued', conclusion: '', created_at: at(5 * 60 * MIN), started_at: at(5 * 60 * MIN), updated_at: at(5 * 60 * MIN) }),
  ]
  // The default branch's history and the branches' earlier runs.
  const mainHistory = ['success', 'success', 'failure', 'success', 'failure', 'success', 'success', 'success', 'success', 'success', 'success']
  mainHistory.forEach((conclusion, i) => runs.push(run(100 + i, { number: 684 - i, conclusion, created_at: at((3 + i) * 60 * MIN), started_at: at((3 + i) * 60 * MIN), updated_at: at((3 + i) * 60 * MIN - 500_000 - i * 3000) })))
  for (let i = 0; i < 4; i++) runs.push(run(120 + i, { number: 559 - i, workflow_name: 'Release', workflow_id: 3, workflow_path: '.github/workflows/release.yml', title: `Release 0.20.${3 - i}`, head_branch: `v0.20.${3 - i}`, created_at: at((15 + i) * 60 * MIN), started_at: at((15 + i) * 60 * MIN), updated_at: at((14 + i) * 60 * MIN) }))
  for (let i = 0; i < 4; i++) runs.push(run(130 + i, { number: 59 - i, workflow_name: 'Dist cache', workflow_id: 4, workflow_path: '.github/workflows/dist-cache.yml', title: 'Dist cache', created_at: at((20 + i) * 60 * MIN), started_at: at((20 + i) * 60 * MIN), updated_at: at((20 + i) * 60 * MIN - 60_000) }))
  runs.push(run(140, { number: 690, attempt: 1, title: 'Preserve reading position while streaming', head_branch: 'fix/reading-position', event: 'pull_request', conclusion: 'failure', created_at: at(70 * MIN), started_at: at(70 * MIN), updated_at: at(62 * MIN) }))
  for (const [i, c] of ['failure', 'success', 'success'].entries()) runs.push(run(141 + i, { number: 680 - i, title: 'Speed up machine port forwarding with direct connections', head_branch: 'feat/ade-104-direct-ports', event: 'pull_request', conclusion: c, created_at: at((26 + i) * 60 * MIN), started_at: at((26 + i) * 60 * MIN), updated_at: at((26 + i) * 60 * MIN - 400_000) }))
  runs.push(run(150, { number: 670, title: 'docs: redesign README', head_branch: 'docs/redesign-readme', event: 'pull_request', conclusion: 'failure', created_at: at(30 * 60 * MIN), started_at: at(30 * 60 * MIN), updated_at: at(30 * 60 * MIN - 400_000) }))
  runs.push(run(151, { number: 563, workflow_name: 'Release', workflow_id: 3, workflow_path: '.github/workflows/release.yml', title: 'docs: redesign README', head_branch: 'docs/redesign-readme', event: 'pull_request', conclusion: 'failure', created_at: at(30 * 60 * MIN), started_at: at(30 * 60 * MIN), updated_at: at(30 * 60 * MIN - 400_000) }))
  for (const [i, c] of ['failure', 'failure'].entries()) runs.push(run(160 + i, { number: 660 - i, title: 'Fix Cursor long-context model selections', head_branch: 'fix/ade-106-cursor-models', event: 'pull_request', conclusion: c, created_at: at((32 + i) * 60 * MIN), started_at: at((32 + i) * 60 * MIN), updated_at: at((32 + i) * 60 * MIN - 400_000) }))
  if (big) {
    // 24 branches with three runs each; one of them the 40-job run.
    runs.unshift(run(900, { number: 900, workflow_name: 'Matrix', workflow_id: 5, workflow_path: '.github/workflows/matrix.yml', title: 'A wide matrix (40 jobs)', head_branch: 'perf/wide-matrix', status: 'in_progress', conclusion: '', created_at: at(3 * MIN), started_at: at(3 * MIN), updated_at: at(5000) }))
    for (let b = 0; b < 24; b++) for (let k = 0; k < 3; k++) {
      const id = 1000 + b * 10 + k
      runs.push(run(id, { number: 400 + id, title: `Branch ${b} change ${k}`, head_branch: `perf/branch-${String(b).padStart(2, '0')}`, event: 'pull_request', conclusion: (b + k) % 4 === 0 ? 'failure' : 'success', created_at: at((40 + b * 3 + k) * 60 * MIN), started_at: at((40 + b * 3 + k) * 60 * MIN), updated_at: at((40 + b * 3 + k) * 60 * MIN - 300_000) }))
    }
  }
  return runs.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, big ? 100 : undefined)
}

export const ACTION_PULLS = [
  { branch: 'fix/reading-position', number: 170, state: 'OPEN' },
  { branch: 'feat/ade-104-direct-ports', number: 171, state: 'OPEN' },
  { branch: 'docs/redesign-readme', number: 169, state: 'MERGED' },
  { branch: 'fix/ade-106-cursor-models', number: 168, state: 'MERGED' },
]

const step = (number: number, name: string, start: number, secs: number, conclusion = 'success', status = 'completed'): WorkflowStep => ({
  number, name, status, conclusion: status === 'completed' ? conclusion : '',
  ...(status !== 'queued' ? { started_at: new Date(start).toISOString() } : {}),
  ...(status === 'completed' ? { completed_at: new Date(start + secs * 1000).toISOString() } : {}),
})
/** A Rust check job's steps, `failing` the test step, or running from `runningFrom` on. */
function checkSteps(start: number, mode: 'passed' | 'failed' | 'running'): WorkflowStep[] {
  const plan: [string, number][] = [['Set up job', 1], ['Run actions/checkout@v5', 2], ['Run dtolnay/rust-toolchain@stable', 8], ['Run Swatinem/rust-cache@v2', 11], ['Linux credential-store deps', 9], ['clippy', 70], ['test', mode === 'failed' ? 288 : 402], ['Post Run Swatinem/rust-cache@v2', 0], ['Post Run actions/checkout@v5', 1], ['Complete job', 0]]
  let t = start
  return plan.map(([name, secs], i) => {
    const s = mode === 'failed' && i === 6 ? step(i + 1, name, t, secs, 'failure')
      : mode === 'failed' && i === 7 ? step(i + 1, name, t, 0, 'skipped')
      : mode === 'running' && i === 6 ? step(i + 1, name, t, 0, '', 'in_progress')
      : mode === 'running' && i > 6 ? step(i + 1, name, t, 0, '', 'queued')
      : step(i + 1, name, t, secs)
    t += secs * 1000
    return s
  })
}

type JobState = 'passed' | 'failed' | 'skipped' | 'running' | 'queued'
function job(id: number, name: string, state: JobState, startMs: number, secs: number, withSteps = false): WorkflowJob {
  const completed = state !== 'running' && state !== 'queued'
  const steps = withSteps ? checkSteps(startMs, state === 'failed' ? 'failed' : state === 'running' ? 'running' : 'passed') : [step(1, 'Set up job', startMs, 1), step(2, `Run ${name}`, startMs + 1000, Math.max(0, secs - 2)), step(3, 'Complete job', startMs + secs * 1000, 0)]
  return {
    id, name, url: `https://example.com/jobs/${id}`,
    status: completed ? 'completed' : state === 'running' ? 'in_progress' : 'queued',
    conclusion: state === 'passed' ? 'success' : state === 'failed' ? 'failure' : state === 'skipped' ? 'skipped' : '',
    ...(state !== 'queued' ? { started_at: new Date(startMs).toISOString() } : {}),
    ...(completed ? { completed_at: new Date(startMs + (state === 'skipped' ? 0 : secs) * 1000).toISOString() } : {}),
    steps: state === 'skipped' || state === 'queued' ? [] : steps,
  }
}

/** One CI run's eight jobs, in GitHub's order. */
function ciJobs(r: WorkflowRun, states: Partial<Record<string, JobState>>): WorkflowJob[] {
  const start = Date.parse(r.started_at ?? r.created_at)
  const base = r.id * 100
  const s = (name: string, fallback: JobState) => states[name] ?? fallback
  return [
    job(base + 1, 'changes', s('changes', 'passed'), start, 7),
    job(base + 2, 'rustfmt', s('rustfmt', 'passed'), start + 9000, 17),
    job(base + 3, 'clippy + test (ubuntu-24.04)', s('ubuntu', 'passed'), start + 9000, s('ubuntu', 'passed') === 'failed' ? 394 : 401, true),
    job(base + 4, 'cargo check (windows-latest)', s('windows', 'passed'), start + 9000, 155),
    job(base + 5, 'clippy + test (macos-15)', s('macos', 'passed'), start + 10_000, 485, true),
    job(base + 6, 'gpuix (typecheck + test)', s('gpuix', 'skipped'), start + 9000, 112),
    job(base + 7, 'release checks', s('release', 'skipped'), start + 9000, 41),
    job(base + 8, 'CI', s('ci', 'passed'), start + 496_000, 3),
  ]
}

/** `github.actions.run` for a run of `actionRuns`. */
export function actionRun(runs: readonly WorkflowRun[], runId: number, attempt?: number): ActionsRunResult {
  const r = runs.find(x => x.id === runId) ?? actionRuns(true).find(x => x.id === runId)!
  if (r.workflow_id === 1) {
    if (r.id === 3 && attempt === 1) {
      const first = { ...r, attempt: 1, status: 'completed', conclusion: 'failure', started_at: at(70 * MIN), updated_at: at(62 * MIN) }
      return { run: first, jobs: ciJobs(first, { ubuntu: 'failed', ci: 'failed', gpuix: 'passed', release: 'passed' }), workflow_jobs: CI_SPECS, attempts: [{ attempt: 1, status: 'completed', conclusion: 'failure' }, { attempt: 2, status: 'in_progress' }] }
    }
    const states: Partial<Record<string, JobState>> = r.id === 3 ? { macos: 'running', ubuntu: 'running', ci: 'queued', gpuix: 'passed', release: 'passed' }
      : r.conclusion === 'failure' ? { ubuntu: 'failed', ci: 'failed' } : {}
    return { run: r, jobs: ciJobs(r, states), workflow_jobs: CI_SPECS, ...(r.id === 3 ? { attempts: [{ attempt: 1, status: 'completed', conclusion: 'failure' }, { attempt: 2, status: 'in_progress' }] } : {}) }
  }
  if (r.workflow_id === 5) return wideRun(r)
  // No readable workflow file: the jobs stand in run order.
  const start = Date.parse(r.started_at ?? r.created_at)
  return { run: r, jobs: ['plan', 'wpe / WPE WebKit (ubuntu-22.04)', 'windows', 'linux', 'linux-wayland', 'linux-noble'].map((n, i) => job(r.id * 100 + i, n, 'passed', start + i * 2000, 60 + i * 40)) }
}

/** 40 jobs: setup and lint, 19 builds, 18 tests, a gate; some running. */
function wideRun(r: WorkflowRun): ActionsRunResult {
  const start = Date.parse(r.started_at ?? r.created_at)
  const specs: WorkflowJobSpec[] = [
    { id: 'setup', name: 'setup' },
    { id: 'build', name: 'build (${{ matrix.target }})', needs: ['setup'], matrix: ['target'] },
    { id: 'test', name: 'test (${{ matrix.target }})', needs: ['build'], matrix: ['target'] },
    { id: 'lint', name: 'lint', needs: ['setup'] },
    { id: 'gate', name: 'gate', needs: ['test', 'lint'] },
  ]
  const jobs: WorkflowJob[] = [job(r.id * 100, 'setup', 'passed', start, 12), job(r.id * 100 + 1, 'lint', 'passed', start + 13_000, 40)]
  for (let i = 0; i < 19; i++) jobs.push(job(r.id * 100 + 10 + i, `build (target-${i})`, i < 12 ? 'passed' : 'running', start + 13_000, 60 + i))
  for (let i = 0; i < 18; i++) jobs.push(job(r.id * 100 + 40 + i, `test (target-${i})`, i < 6 ? 'running' : 'queued', start + 80_000, 0))
  jobs.push(job(r.id * 100 + 99, 'gate', 'queued', start, 0))
  return { run: r, jobs: jobs.slice(0, 40), workflow_jobs: specs }
}
