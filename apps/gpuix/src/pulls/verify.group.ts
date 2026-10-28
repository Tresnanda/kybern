/** Group projects (ADE-79): every member's pull requests, tagged with their repository, opened in it. Mock RPC only. */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../requests/harness.ts'
import { captureWindow } from '../transcript/live.ts'
import { actionFixture } from './verify.fixture.ts'

const mode = process.argv.includes('--light') ? 'light' : 'dark'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/Users/mymac/projects/ade/.kybern-artifacts/ade-79'
mkdirSync(out, { recursive: true })
const fixture = actionFixture({ group: true })
const f = await launchFixture(path.join(import.meta.dir, '../main.tsx'), { ...fixture.env, KYBERN_APPEARANCE: mode })
const a = f.app
const shot = async (name: string) => { const file = `${out}/${name}-${mode}.png`; try { captureWindow(f.pid, file) } catch { await a.screenshot({ path: file }) } }
const click = async (id: string) => { await a.getByTestId(id).waitFor({ timeoutMs: 10000 }); await a.getByTestId(id).click(); await Bun.sleep(400) }
try {
  await a.getByTestId('app-ready').waitFor({ timeoutMs: 60000 })
  await click('rail-pulls')
  // The same number in two repositories is two rows.
  await a.getByTestId('pr-row-api-108').waitFor({ timeoutMs: 10000 })
  assert.equal(await a.getByTestId('pr-row-docs-108').count(), 1, 'docs #108 is its own row')
  assert.equal(await a.getByTestId('pr-row-api-109').count(), 1)
  assert.equal(await a.getByTestId('pr-badge-repo').count(), 3, 'every row names its repository')
  const painted = (await a.call('getPaintedText', {})).text.join('\n')
  assert.match(painted, /web: HTTP 401/, 'the failing member is reported')
  assert.doesNotMatch(painted, /infra/, 'a member not on GitHub is skipped quietly')
  await shot('1-list')
  // Opening a member's pull request names its repository; findings can't be sent from it.
  await click('pr-row-docs-108')
  await a.getByTestId('pr-summary').waitFor({ timeoutMs: 10000 })
  const detail = fixture.params.filter(p => p.method === 'github.pr.detail').at(-1)
  assert.equal(detail?.params.repo, 'docs', 'detail runs in the member')
  await shot('2-detail')
  console.log(`PASS ${mode}: member rows with badges, same number in two repos, failing member reported, skipped member quiet, detail by member`)
} catch (error) {
  await shot('failure').catch(() => {})
  console.log(f.diagnostics())
  throw error
} finally { await f.close(); fixture.close() }
process.exit(0)
