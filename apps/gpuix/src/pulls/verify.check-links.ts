/**
 * #247: a check on the pull request page that is a GitHub Actions job opens that run, on that job's log, in Kybern's Actions
 * view; another app's check (Vercel here) still opens in the browser. Mock RPC only: nothing reaches GitHub.
 *   KYBERN_VERIFY_OUTPUT=<dir> bun src/pulls/verify.check-links.ts [--light]
 */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../requests/harness.ts'
import { actionFixture } from './verify.fixture.ts'

const mode = process.argv.includes('--light') ? 'light' : 'dark'
const out = process.env.KYBERN_VERIFY_OUTPUT
if (out) mkdirSync(out, { recursive: true })
const fixture = actionFixture({ checkLinks: true })
const f = await launchFixture(path.join(import.meta.dir, '../main.tsx'), { KYBERN_WINDOW_SIZE: '1280x820', ...fixture.env, KYBERN_APPEARANCE: mode })
const a = f.app
const shot = async (name: string) => { if (out) await a.screenshot({ path: `${out}/${name}-${mode}.png` }) }
const painted = async () => (await a.call('getPaintedText', {})).text.join('\n')
const until = async (re: RegExp) => { const end = Date.now() + 10000; while (Date.now() < end) { if (re.test(await painted())) return; await Bun.sleep(200) } assert.fail(`never painted ${re}\n${(await painted()).slice(0, 2000)}`) }
try {
  await a.getByTestId('app-ready').waitFor({ timeoutMs: 60000 })
  await a.getByTestId('rail-pulls').click(); await Bun.sleep(400)
  await a.getByTestId('pr-row-108').click()
  await a.getByTestId('pr-checks').waitFor({ timeoutMs: 10000 })
  await Bun.sleep(1200)
  // The passed checks are folded: Typecheck links to a job of run #60, Tests to another app's page.
  await a.getByTestId('pr-checks-fold').click(); await Bun.sleep(500)
  await shot('pr-checks')
  const rows = (await a.getByTestId('pr-check-row').all()).filter(node => node.bounds).sort((x, y) => x.bounds!.y - y.bounds!.y)
  assert.equal(rows.length, 3, 'the PR page lists its checks')
  await a.mouse.click({ x: rows[1]!.bounds!.x + 40, y: rows[1]!.bounds!.y + 12 })
  await a.getByTestId('actions-graph').waitFor({ timeoutMs: 10000 })
  await until(/CI #699/)
  assert.ok(fixture.params.some(p => p.method === 'github.actions.run' && p.params.run_id === 60), 'the run was read through the daemon')
  await Bun.sleep(1000)
  await shot('run-from-check')
  console.log('ok  the Actions job check opens its run in Kybern')
} catch (error) { console.log(f.diagnostics()); throw error } finally { await f.close(); fixture.close() }
