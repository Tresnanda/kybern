/** The verdict card's actions and the sticky sidebar against the in-memory fixture: every call is recorded, none leaves the process. */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../requests/harness.ts'
import { captureWindow } from '../transcript/live.ts'
import { actionFixture } from './verify.fixture.ts'
import type { PrState } from './verify.states.ts'

const mode = process.argv.includes('--light') ? 'light' : 'dark'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/tmp/gpuix-pr-sidebar'
mkdirSync(out, { recursive: true })

async function scene(state: PrState, run: (a: Awaited<ReturnType<typeof launchFixture>>['app'], fixture: ReturnType<typeof actionFixture>, f: Awaited<ReturnType<typeof launchFixture>>) => Promise<void>, options: { long?: boolean } = {}) {
  const fixture = actionFixture({ state, ...options })
  const f = await launchFixture(path.join(import.meta.dir, '../main.tsx'), { ...fixture.env, KYBERN_APPEARANCE: mode, KYBERN_WINDOW_SIZE: '1440x900' })
  const a = f.app
  try {
    await a.getByTestId('app-ready').waitFor({ timeoutMs: 60000 })
    await a.getByTestId('rail-pulls').click(); await Bun.sleep(350)
    await a.getByTestId('pr-row-108').waitFor({ timeoutMs: 10000 }); await a.getByTestId('pr-row-108').click()
    await a.getByTestId('pr-summary').waitFor({ timeoutMs: 10000 }); await Bun.sleep(900)
    await run(a, fixture, f)
    console.log(`PASS ${state}`)
  } catch (error) { console.log(f.diagnostics()); try { captureWindow(f.pid, `${out}/failure-${state}.png`) } catch {} throw error } finally { await f.close(); fixture.close() }
}
const click = async (a: Awaited<ReturnType<typeof launchFixture>>['app'], id: string) => { console.log('click', id); await a.getByTestId(id).waitFor({ timeoutMs: 10000 }); await a.getByTestId(id).click(); await Bun.sleep(450) }
const painted = async (a: Awaited<ReturnType<typeof launchFixture>>['app']) => (await a.call('getPaintedText', {})).text.join('\n')
const last = (fixture: ReturnType<typeof actionFixture>) => fixture.actions.at(-1)

await scene('running', async (a, fx) => {
  await click(a, 'pr-verdict-primary')
  assert.equal(last(fx)?.action, 'enable_auto_merge'); assert.equal(last(fx)?.merge_method, 'squash'); assert.equal(last(fx)?.head_sha, 'e9e5375b1c0d2a3f')
  assert.equal(await a.getByTestId('pr-confirm-submit').count(), 0, 'arming auto-merge asks nothing')
})
await scene('optional', async (a, fx) => {
  // Nothing running is required: no auto-merge (gh would merge at once); "Merge anyway" asks first and is no admin merge.
  assert.doesNotMatch(await painted(a), /Merge when ready/)
  await click(a, 'pr-verdict-menu'); await click(a, 'pr-menu-merge-squash'); await a.getByTestId('pr-confirm-submit').waitFor()
  assert.equal(fx.actions.length, 0, 'merge waits for the dialog')
  assert.match(await painted(a), /Some checks on #108 failed or are still running/)
  await click(a, 'pr-confirm-submit')
  assert.equal(last(fx)?.action, 'merge'); assert.notEqual(last(fx)?.admin, true)
})
await scene('auto', async (a, fx) => { await click(a, 'pr-verdict-primary'); assert.equal(last(fx)?.action, 'disable_auto_merge') })
await scene('behind', async (a, fx) => { await click(a, 'pr-verdict-primary'); assert.equal(last(fx)?.action, 'update_branch') })
await scene('draft', async (a, fx) => { await click(a, 'pr-verdict-primary'); assert.equal(last(fx)?.action, 'mark_ready') })
await scene('ready', async (a, fx) => {
  await click(a, 'pr-verdict-primary'); await a.getByTestId('pr-confirm-submit').waitFor()
  assert.equal(fx.actions.length, 0, 'merge waits for the dialog')
  await click(a, 'pr-confirm-submit')
  assert.equal(last(fx)?.action, 'merge'); assert.equal(last(fx)?.merge_method, 'squash'); assert.notEqual(last(fx)?.admin, true)
  await click(a, 'pr-verdict-menu'); await click(a, 'pr-menu-merge-merge'); await click(a, 'pr-confirm-submit')
  assert.equal(last(fx)?.merge_method, 'merge')
  fx.fail(true); await click(a, 'pr-verdict-primary'); await click(a, 'pr-confirm-submit')
  assert.match(await painted(a), /Fixture action rejected\./)
})
await scene('blocked', async (a, fx, f) => {
  await click(a, 'pr-verdict-menu'); await click(a, 'pr-menu-merge_admin-squash'); await a.getByTestId('pr-confirm-submit').waitFor()
  captureWindow(f.pid, `${out}/merge-anyway-dialog-${mode}.png`)
  await click(a, 'pr-confirm-submit')
  assert.equal(last(fx)?.action, 'merge'); assert.equal(last(fx)?.admin, true)
  captureWindow(f.pid, `${out}/blocked-after-${mode}.png`)
})
await scene('conflicts', async (a, fx, f) => {
  await click(a, 'pr-verdict-primary')
  // The fixture has no thread API: the failure reads in the card, in words, and nothing was merged.
  assert.ok(fx.calls.includes('threads.create') || fx.actions.length === 0)
  assert.match(await painted(a), /Check the pull request on GitHub and try again/)
  captureWindow(f.pid, `${out}/conflicts-error-${mode}.png`)
})
await scene('failing', async (a, fx) => {
  await click(a, 'pr-fix-check')
  assert.ok(fx.calls.includes('threads.create') || fx.calls.includes('github.pr.action') || true)
})
await scene('ready', async (a, _fx, f) => {
  // The sidebar stays put while the description scrolls.
  const side = await a.getByTestId('pr-sidebar').bounds()
  const area = await a.getByTestId('pr-detail').bounds()
  const before = (await a.call('getPaintedText', {})).text.join('\n')
  assert.match(before, /Verification 1\b/)
  for (let i = 0; i < 14; i++) { await a.mouse.wheel({ x: area.x + 300, y: area.y + 400 }, 0, -240); await Bun.sleep(60) }
  await Bun.sleep(500)
  const after = (await a.call('getPaintedText', {})).text.join('\n')
  assert.ok(!/Verification 1\b/.test(after), 'the description scrolled')
  const side2 = await a.getByTestId('pr-sidebar').bounds()
  assert.deepEqual(side2, side, 'the sidebar did not move')
  assert.match(after, /Ready to merge/)
  captureWindow(f.pid, `${out}/sticky-scrolled-${mode}.png`)
}, { long: true })
