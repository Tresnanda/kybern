/** ADE-85 Timeline on a single project: filters, selecting findings and "Address feedback" feed Send to agent; an image in a
 * comment, and the comment box at the end (⌘↩ / Ctrl+Enter, shown at once, the draft kept across tabs). Mock RPC only. */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../requests/harness.ts'
import { captureWindow } from '../transcript/live.ts'
import { actionFixture } from './verify.fixture.ts'

const mode = process.argv.includes('--light') ? 'light' : 'dark'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/.kybern-artifacts/ade-85/l3'
mkdirSync(out, { recursive: true })
const fixture = actionFixture({ images: true })
const send = process.platform === 'darwin' ? 'cmd-enter' : 'ctrl-enter'
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
  await a.getByTestId('pr-timeline-entries').wheel(0, -100000); await Bun.sleep(400)
  await click('pr-timeline-more')
  await a.getByTestId('pr-timeline-entries').wheel(0, -100000); await Bun.sleep(800)

  // The last comment's image loads through the project's machine.
  { const end = Date.now() + 15000; while (Date.now() < end && (await a.getByTestId('response-image').count()) < 1) await Bun.sleep(250) }
  assert.equal(await a.getByTestId('response-image').count(), 1, 'the comment image is drawn')
  assert.doesNotMatch(await painted(), /<img/, 'never as HTML')

  // The comment box: no menu, ⌘↩ / Ctrl+Enter posts, and the comment shows at once.
  await a.getByTestId('pr-comment-input').click()
  await a.getByTestId('pr-comment-input').fill('Thanks, merging after the deploy.')
  await shot('8-timeline-comment-box')
  await a.getByTestId('pr-comment-input').press(send)
  await Bun.sleep(150)
  assert.match(await painted(), /Thanks, merging after the deploy/, 'shown before GitHub answers')
  await Bun.sleep(900)
  const posted = fixture.params.filter(p => p.method === 'github.issue.comment').map(p => p.params)
  assert.deepEqual(posted, [{ project_id: 'pages-fixture', number: 108, body: 'Thanks, merging after the deploy.' }])
  assert.equal(await a.getByTestId('pr-timeline-IC_posted_1').count(), 1, "GitHub's copy replaced the pending one")

  // The draft survives a tab switch.
  await a.getByTestId('pr-comment-input').fill('Draft on the timeline')
  await Bun.sleep(300)
  await click('pr-tab-summary')
  await click('pr-tab-timeline')
  await a.getByTestId('pr-timeline-entries').wheel(0, -100000); await Bun.sleep(800)
  assert.match(await painted(), /Draft on the timeline/, 'the draft is kept')
  assert.match(await painted(), /Thanks, merging after the deploy/, 'the posted comment is kept')
  await shot('9-timeline-commented')
  console.log(`PASS ${mode}: timeline filters, selection and Address feedback`)
} catch (error) {
  await shot('failure-timeline').catch(() => {})
  console.log(f.diagnostics())
  throw error
} finally { await f.close(); fixture.close() }
process.exit(0)
