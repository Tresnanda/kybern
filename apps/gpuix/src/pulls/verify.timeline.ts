/** ADE-85 Timeline on a single project: filters, selecting findings and "Address feedback" feed Send to agent. Mock RPC only. */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../requests/harness.ts'
import { captureWindow } from '../transcript/live.ts'
import { actionFixture } from './verify.fixture.ts'

const mode = process.argv.includes('--light') ? 'light' : 'dark'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/.kybern-artifacts/ade-85/l3'
mkdirSync(out, { recursive: true })
const fixture = actionFixture()
const f = await launchFixture(path.join(import.meta.dir, '../main.tsx'), { ...fixture.env, KYBERN_APPEARANCE: mode })
const a = f.app
const shot = async (name: string) => { const file = `${out}/${name}-${mode}.png`; try { captureWindow(f.pid, file) } catch { await a.screenshot({ path: file }) } }
const click = async (id: string) => { await a.getByTestId(id).waitFor({ timeoutMs: 10000 }); await a.getByTestId(id).click(); await Bun.sleep(450) }
const painted = async () => (await a.call('getPaintedText', {})).text.join('\n')
try {
  await a.getByTestId('app-ready').waitFor({ timeoutMs: 60000 })
  await click('rail-pulls')
  await click('pr-row-108')
  await a.getByTestId('pr-summary').waitFor({ timeoutMs: 10000 })
  await click('pr-tab-timeline')
  await a.getByTestId('pr-timeline-entries').waitFor({ timeoutMs: 10000 })
  await Bun.sleep(800)
  assert.equal(await a.getByTestId('pr-address-feedback').count(), 1, 'a changes-requested review offers Address feedback')
  // Filters keep their kinds.
  await click('pr-timeline-filter-commits')
  let text = await painted()
  assert.match(text, /pushed 3 commits/); assert.doesNotMatch(text, /requested changes/)
  await click('pr-timeline-filter-reviews')
  text = await painted()
  assert.match(text, /requested changes/); assert.doesNotMatch(text, /pushed 3 commits/)
  await click('pr-timeline-filter-all')
  // Selecting by checkbox, then Address feedback selects the review and its inline comments.
  await click('pr-select-r1')
  assert.match(await painted(), /1 selected/)
  await click('pr-address-feedback')
  await Bun.sleep(400)
  assert.match(await painted(), /3 selected/, 'review summary plus two inline comments')
  await shot('7-timeline-selected')
  console.log(`PASS ${mode}: timeline filters, selection and Address feedback`)
} catch (error) {
  await shot('failure-timeline').catch(() => {})
  console.log(f.diagnostics())
  throw error
} finally { await f.close(); fixture.close() }
process.exit(0)
