/**
 * ADE-97 Actions tab ("C · Pipeline"): the branch-grouped run list with bead strings, a passed, a failed and a running run's
 * job graph, steps and log, attempts, rerun/cancel, dispatch and the PR checks link. Mock RPC only: nothing reaches GitHub.
 * `--light` for the light theme; `KYBERN_VERIFY_OUTPUT=<dir>` saves screenshots.
 */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../requests/harness.ts'
import { actionFixture } from './verify.fixture.ts'

const mode = process.argv.includes('--light') ? 'light' : 'dark'
const out = process.env.KYBERN_VERIFY_OUTPUT
if (out) mkdirSync(out, { recursive: true })
const fixture = actionFixture({})
const f = await launchFixture(path.join(import.meta.dir, '../main.tsx'), { KYBERN_WINDOW_SIZE: '1280x820', ...fixture.env, KYBERN_APPEARANCE: mode })
const a = f.app
const shot = async (name: string) => { if (out) await a.screenshot({ path: `${out}/${name}-${mode}.png` }) }
const click = async (id: string) => { await a.getByTestId(id).waitFor({ timeoutMs: 10000 }); await a.getByTestId(id).click(); await Bun.sleep(450) }
const painted = async () => (await a.call('getPaintedText', {})).text.join('\n')
const until = async (re: RegExp) => { const end = Date.now() + 10000; while (Date.now() < end) { if (re.test(await painted())) return; await Bun.sleep(200) } assert.fail(`never painted ${re}\n${(await painted()).slice(0, 3000)}`) }
const exists = async (id: string) => { try { await a.getByTestId(id).waitFor({ timeoutMs: 3000 }); return true } catch { return false } }
const last = (method: string) => fixture.actions.filter(x => x.method === method).at(-1)
try {
  await a.getByTestId('app-ready').waitFor({ timeoutMs: 60000 })
  await click('rail-pulls')
  await click('pulls-tab-actions')

  // The list: the default branch with a bead string per workflow (a release tag's run with it), then branches with their PRs.
  await a.getByTestId('actions-default-branch').waitFor({ timeoutMs: 10000 })
  await until(/default branch/)
  await until(/Branches/)
  const list = await painted()
  for (const text of ['Latest push first', 'fix/reading-position', '#170', 'feat/ade-104-direct-ports', '#171', 'Preserve reading position while streaming', 'v0.20.4', '#699', 'Dist cache']) assert.ok(list.includes(text), `the list shows ${text}`)
  assert.doesNotMatch(list, /\u001b/)
  assert.ok(await exists('actions-bead-60') && await exists('actions-bead-72'), 'main CI and the v0.20.4 release run are beads')
  assert.ok(fixture.params.some(p => p.method === 'github.actions.runs' && p.params.pulls === true && p.params.per_page === 100), 'one paged read with pull requests')

  // A passed run: the graph in three columns, its summary.
  await click('actions-bead-60')
  await until(/6 jobs passed, 2 skipped/)
  await until(/CI #699/)
  assert.ok(await exists('actions-graph'))
  await a.getByTestId('actions-node-6005').click(); await Bun.sleep(500)
  await until(/clippy \+ test \(macos-15\)/)
  await shot('list')

  // A failed run: where the failure runs, the red path, the failed step and its log at the error.
  await click('actions-bead-2')
  await until(/The failure runs through clippy \+ test \(ubuntu-24\.04\)/)
  await until(/Error: Process completed with exit code 101/)
  assert.ok(await exists('actions-graph-edges-failure'), 'the failure path has its own layer')
  const failed = await painted()
  assert.doesNotMatch(failed, /\u001b|\[3\dm/, 'no raw escape codes')
  assert.match(failed, /failed after 4m 48s/)
  assert.match(failed, /Skipped/)
  assert.ok(fixture.params.some(p => p.method === 'github.actions.log' && Number(p.params.offset) > 1000), 'the failed log opens near its error')
  await shot('failed')
  await click('actions-log-earlier')
  await until(/Lines 704–1,212 of 1,212/)
  await click('actions-rerun-failed')
  assert.equal(last('github.actions.action')?.action, 'rerun_failed')
  await click('actions-rerun-job')
  assert.deepEqual([last('github.actions.action')?.action, last('github.actions.action')?.job_id], ['rerun_job', 203])
  await click('actions-fix')
  await a.getByTestId('actions-fix-popover').waitFor({ timeoutMs: 5000 })
  await a.getByTestId('actions-fix-popover').press('escape'); await Bun.sleep(300)

  // Branch filter, as you type.
  await a.getByTestId('actions-branch').fill('ports'); await Bun.sleep(400)
  assert.ok(await exists('actions-branch-feat/ade-104-direct-ports'))
  assert.ok(!(await exists('actions-branch-fix/reading-position')), 'other branches are filtered out')
  await a.getByTestId('actions-branch').fill(''); await Bun.sleep(400)

  // A running second attempt: amber jobs with progress, the gate waiting, the log promised, and the first attempt a click away.
  await click('actions-branch-fix/reading-position')
  await until(/5 of 8 jobs done · usually/)
  await until(/Waits for 2 jobs/)
  await until(/The log arrives when this job finishes/)
  assert.ok(await exists('actions-node-progress-303'), 'a running job measures itself against a passing run')
  assert.ok(fixture.params.some(p => p.method === 'github.actions.run' && p.params.run_id === 60), 'the reference run is read for job times')
  if (process.env.KYBERN_REDUCED_MOTION !== '1') assert.ok(await exists('actions-graph-flow'), 'edges into running jobs flow')
  await Bun.sleep(600)
  await shot('running')
  await click('actions-attempt-1')
  await until(/The failure runs through clippy \+ test \(ubuntu-24\.04\)/)
  assert.ok(fixture.params.some(p => p.method === 'github.actions.run' && p.params.run_id === 3 && p.params.attempt === 1))
  await click('actions-attempt-2')
  await until(/5 of 8 jobs done/)
  await click('actions-cancel')
  assert.deepEqual({ ...last('github.actions.action'), project_id: undefined }, { method: 'github.actions.action', project_id: undefined, action: 'cancel', run_id: 3 })

  // A run whose workflow file can't be read stands in run order.
  await click('actions-bead-1')
  await until(/wpe \/ WPE WebKit/)

  // Run workflow with its inputs.
  await click('actions-dispatch-open')
  await click('actions-dispatch-workflow-trigger')
  await click('actions-dispatch-workflow-option-2')
  await a.getByTestId('actions-dispatch-input-checks').waitFor({ timeoutMs: 10000 })
  await shot('dispatch')
  await click('actions-dispatch-run')
  const dispatched = last('github.actions.dispatch')
  assert.equal(dispatched?.workflow, '2')
  assert.equal(dispatched?.ref, 'main')
  assert.deepEqual(dispatched?.inputs, { checks: 'all', platform: 'all', verbose: 'false' })

  // The PR page's checks link opens this branch's runs.
  await click('pulls-tab-pulls')
  await a.getByTestId('pr-row-108').waitFor({ timeoutMs: 10000 })
  await click('pr-row-108')
  await click('pr-checks-actions')
  await a.getByTestId('page-actions').waitFor({ timeoutMs: 10000 })
  await Bun.sleep(600)
  assert.ok(await exists('actions-branch-fix/reading-position'), 'the PR branch is listed')
  assert.ok(!(await exists('actions-branch-feat/ade-104-direct-ports')), 'filtered to the PR branch')
  console.log(`[actions-tab] ${mode} ok`)
} finally {
  await f.close()
  fixture.close()
}
