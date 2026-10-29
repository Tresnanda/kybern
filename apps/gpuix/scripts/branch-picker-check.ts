/**
 * New-chat branch picker: remote branches are listed, a fetch brings in ones made after the clone, search filters,
 * and picking a remote branch selects it.
 *
 *   KYBERN_DATA_DIR=<scratch> bun scripts/branch-picker-check.ts --project <id> [--fresh <branch>] [--out dir]
 * The project is a clone whose origin has local branches feat/login and fix/crash, and `--fresh`, made after the clone.
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../src/requests/harness.ts'

const args = process.argv.slice(2)
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const out = arg('--out') ?? '/tmp/kybern-branch-picker'
const project = arg('--project')
if (!project) throw new Error('pass --project <id>')
const fresh = arg('--fresh') ?? 'feat/only-on-remote-after-clone'
mkdirSync(out, { recursive: true })
const fixture = await launchFixture(path.resolve(import.meta.dir, '../src/main.tsx'), { GPUIX_BACKGROUND: '1', KYBERN_URL: '', KYBERN_DATA_DIR: process.env.KYBERN_DATA_DIR! })
const app = fixture.app
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const has = async (text: string) => (await app.getByText(text).count()) > 0
const until = async (check: () => Promise<boolean>, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await check()) return true } catch {} await wait(100) } return false }
const fail: string[] = []
const expect = (name: string, ok: boolean) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) fail.push(name) }
try {
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60_000 })
  await wait(1500)
  await app.getByTestId(`project-new-${project}`).click()
  await app.getByTestId('tray-branch').waitFor({ timeoutMs: 15_000 })
  await wait(600)
  await app.getByTestId('tray-branch').click()
  expect('menu opens', await until(() => has('Search branches'), 5000))
  expect('remote branch listed', await until(() => has('origin/feat/login'), 5000))
  await app.screenshot({ path: path.join(out, 'open.png') })
  expect('fetch brings in a new remote branch', await until(() => has(`origin/${fresh}`), 25_000))
  expect('fetching note clears', await until(async () => !(await has('Fetching…')), 25_000))
  await app.getByTestId('tray-branch-search').fill('crash')
  await wait(400)
  expect('search keeps the match', await has('origin/fix/crash'))
  expect('search hides the rest', !(await has('origin/feat/login')))
  await app.screenshot({ path: path.join(out, 'search.png') })
  await app.getByText('origin/fix/crash').click()
  await wait(400)
  expect('pick closes the menu', !(await has('Search branches')))
  expect('chip shows the remote branch', await has('origin/fix/crash'))
  await app.screenshot({ path: path.join(out, 'picked.png') })
} catch (error) {
  await app.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {})
  throw error
} finally {
  await fixture.close()
}
if (fail.length) { console.error(`branch picker check failed: ${fail.join(', ')}`); process.exit(1) }
