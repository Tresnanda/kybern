/** ADE-97 Actions tab: list, run detail, log, rerun/cancel, dispatch and the PR checks link. Mock RPC only: nothing reaches GitHub. */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../requests/harness.ts'
import { actionFixture } from './verify.fixture.ts'

const mode = process.argv.includes('--light') ? 'light' : 'dark'
const out = process.env.KYBERN_VERIFY_OUTPUT
if (out) mkdirSync(out, { recursive: true })
const fixture = actionFixture({})
const f = await launchFixture(path.join(import.meta.dir, '../main.tsx'), { ...fixture.env, KYBERN_APPEARANCE: mode })
const a = f.app
const shot = async (name: string) => { if (out) await a.screenshot({ path: `${out}/${name}-${mode}.png` }) }
const click = async (id: string) => { await a.getByTestId(id).waitFor({ timeoutMs: 10000 }); await a.getByTestId(id).click(); await Bun.sleep(450) }
const painted = async () => (await a.call('getPaintedText', {})).text.join('\n')
const until = async (re: RegExp) => { const end = Date.now() + 10000; while (Date.now() < end) { if (re.test(await painted())) return; await Bun.sleep(200) } assert.fail(`never painted ${re}`) }
const last = (method: string) => fixture.actions.filter(x => x.method === method).at(-1)
try {
  await a.getByTestId('app-ready').waitFor({ timeoutMs: 60000 })
  await click('rail-pulls')
  await click('pulls-tab-actions')
  await a.getByTestId('actions-run-3').waitFor({ timeoutMs: 10000 })
  await until(/CI #697/)
  assert.doesNotMatch(await painted(), /\u001b/)
  await shot('list')

  // A running run can be cancelled; its jobs say why there's no log yet.
  await click('actions-run-3')
  await until(/This job is running/)
  await click('actions-cancel')
  assert.deepEqual({ ...last('github.actions.action'), project_id: undefined }, { method: 'github.actions.action', project_id: undefined, action: 'cancel', run_id: 3 })

  // A failed run opens its failed job's log at the error, with escapes mapped.
  await click('actions-run-2')
  await until(/Error: Process completed with exit code 101/)
  const log = await painted()
  assert.doesNotMatch(log, /\u001b|\[3\dm/, 'no raw escape codes')
  assert.match(log, /Failed at test/)
  assert.ok(fixture.params.some(p => p.method === 'github.actions.log' && Number(p.params.offset) > 1000), 'the failed log opens near its error')
  await shot('failed')
  await click('actions-log-earlier')
  await until(/Lines 692–1,212 of 1,212/)
  await click('actions-rerun-failed')
  assert.equal(last('github.actions.action')?.action, 'rerun_failed')
  await click('actions-rerun-job')
  assert.deepEqual([last('github.actions.action')?.action, last('github.actions.action')?.job_id], ['rerun_job', 12])
  await click('actions-fix')
  await a.getByTestId('actions-fix-popover').waitFor({ timeoutMs: 5000 })
  await a.getByTestId('actions-fix-popover').press('escape'); await Bun.sleep(300)

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
  await shot('pull-requests-tab')
  await click('pr-row-108')
  const before = fixture.params.length
  await click('pr-checks-actions')
  await a.getByTestId('page-actions').waitFor({ timeoutMs: 10000 })
  await Bun.sleep(600)
  // The dispatch's run lookup (branch main, event workflow_dispatch) may still be polling: look for the list read itself.
  assert.ok(fixture.params.slice(before).some(p => p.method === 'github.actions.runs' && p.params.branch === 'fix/reading-position' && !p.params.event), 'the branch list is read')
  console.log(`[actions-tab] ${mode} ok`)
} finally {
  await f.close()
  fixture.close()
}
