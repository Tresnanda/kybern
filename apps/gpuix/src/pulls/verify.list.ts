/** ADE-85 list and Timeline: readiness groups, the project filter with member repositories, repo chips and the Timeline tab. Mock RPC only. */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../requests/harness.ts'
import { captureWindow } from '../transcript/live.ts'
import { actionFixture } from './verify.fixture.ts'

const mode = process.argv.includes('--light') ? 'light' : 'dark'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/.kybern-artifacts/ade-85/l3'
mkdirSync(out, { recursive: true })
const fixture = actionFixture({ readiness: true })
const f = await launchFixture(path.join(import.meta.dir, '../main.tsx'), { ...fixture.env, KYBERN_APPEARANCE: mode })
const a = f.app
const shot = async (name: string) => { const file = `${out}/${name}-${mode}.png`; try { captureWindow(f.pid, file) } catch { await a.screenshot({ path: file }) } }
const click = async (id: string) => { await a.getByTestId(id).waitFor({ timeoutMs: 10000 }); await a.getByTestId(id).click(); await Bun.sleep(450) }
const painted = async () => (await a.call('getPaintedText', {})).text.join('\n')
try {
  await a.getByTestId('app-ready').waitFor({ timeoutMs: 60000 })
  await click('rail-pulls')
  await a.getByTestId('pr-row-core-2860').waitFor({ timeoutMs: 10000 })
  // Every readiness group, in order, with counts.
  for (const g of ['needs_attention', 'awaiting_review', 'approved', 'draft']) assert.equal(await a.getByTestId(`pr-group-${g}`).count(), 1, `${g} group`)
  const text = await painted()
  assert.ok(text.indexOf('Needs attention') < text.indexOf('Awaiting review') && text.indexOf('Awaiting review') < text.indexOf('Approved'), 'groups in order')
  assert.match(text, /2 failing/); assert.match(text, /Changes requested/); assert.match(text, /Conflicts/); assert.match(text, /6 running/); assert.match(text, /Needs review/); assert.match(text, /Ready/)
  await shot('1-list-all')
  // Project filter: group project with member repositories indented.
  await click('pr-project-filter')
  await a.getByTestId('pr-filter-pages-fixture-core').waitFor({ timeoutMs: 5000 })
  await shot('2-filter-menu')
  await click('pr-filter-pages-fixture-tele')
  await shot('3-filter-menu-repo')
  await a.getByTestId('pr-filter-pages-fixture-tele').press('escape'); await Bun.sleep(300)
  await a.getByTestId('pr-repo-chips').waitFor({ timeoutMs: 5000 })
  assert.equal(await a.getByTestId('pr-row-core-2860').count(), 0, 'only tele is shown')
  assert.equal(await a.getByTestId('pr-row-tele-1190').count(), 1)
  await click('pr-repo-all')
  await a.getByTestId('pr-row-core-2860').waitFor({ timeoutMs: 5000 })
  await click('pr-repo-core')
  assert.equal(await a.getByTestId('pr-row-tele-1190').count(), 0, 'a chip filters to one repository')
  await click('pr-repo-all')
  await shot('4-list-chips')
  // Timeline.
  await click('pr-row-core-2860')
  await a.getByTestId('pr-summary').waitFor({ timeoutMs: 10000 })
  await click('pr-tab-timeline')
  await a.getByTestId('pr-timeline-entries').waitFor({ timeoutMs: 10000 })
  await Bun.sleep(800)
  const calls = fixture.params.filter(p => p.method === 'github.pr.page' && p.params.kind === 'timeline')
  assert.equal(calls.length, 1, 'first timeline page')
  assert.equal(calls[0]!.params.repo, 'core')
  const tl = await painted()
  assert.match(tl, /pushed 3 commits/, 'consecutive commits collapse'); assert.match(tl, /requested changes/); assert.doesNotMatch(tl, /Address feedback/, 'a member pull request cannot be sent to an agent'); assert.match(tl, /opened this pull request/)
  await shot('5-timeline')
  await click('pr-timeline-more')
  await Bun.sleep(600)
  assert.equal(fixture.params.filter(p => p.method === 'github.pr.page' && p.params.kind === 'timeline').at(-1)?.params.cursor, 'page-2', 'next page uses the cursor')
  assert.match(await painted(), /force-pushed/)
  await shot('6-timeline-more')
  console.log(`PASS ${mode}: readiness groups, project filter with repos, chips, timeline collapse and cursor paging`)
} catch (error) {
  await shot('failure').catch(() => {})
  console.log(f.diagnostics())
  throw error
} finally { await f.close(); fixture.close() }
process.exit(0)
