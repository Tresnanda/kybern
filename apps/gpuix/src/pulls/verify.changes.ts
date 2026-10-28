/** The Changes tab against the in-memory PR fixture (65 files in three pages): full-height tree, paging, tree and flat list. */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { launchFixture } from '../requests/harness.ts'
import { captureWindow } from '../transcript/live.ts'
import { actionFixture } from './verify.fixture.ts'

const compact = process.argv.includes('--compact')
const mode = process.argv.includes('--light') ? 'light' : 'dark'
const out = process.env.KYBERN_VERIFY_OUTPUT ?? '/tmp/gpuix-changes'
mkdirSync(out, { recursive: true })
const fixture = actionFixture({ changes: true })
const f = await launchFixture(path.join(import.meta.dir, '../main.tsx'), { ...fixture.env, KYBERN_APPEARANCE: mode, KYBERN_WINDOW_SIZE: compact ? '980x760' : '1360x860' })
const a = f.app
const tag = `${compact ? 'compact' : 'wide'}-${mode}`
const shot = async (name: string) => { const file = `${out}/${name}-${tag}.png`; try { captureWindow(f.pid, file) } catch { await a.screenshot({ path: file }) } }
const click = async (id: string) => { await a.getByTestId(id).waitFor({ timeoutMs: 10000 }); await a.getByTestId(id).click(); await Bun.sleep(350) }
const painted = async () => (await a.call('getPaintedText', {})).text.join('\n')
try {
  await a.getByTestId('app-ready').waitFor({ timeoutMs: 60000 })
  await click('rail-pulls')
  await click('pr-row-108')
  await a.getByTestId('pr-summary').waitFor({ timeoutMs: 10000 })
  await click('pr-tab-changes')
  await a.getByTestId('pr-files').waitFor({ timeoutMs: 10000 })
  await Bun.sleep(1200)
  const pageCalls = fixture.params.filter(p => p.method === 'github.pr.page' && p.params.kind === 'files').map(p => p.params.page)
  assert.deepEqual(pageCalls.slice(0, 3), [1, 2, 3], 'every page of files loads in turn')
  const col = await a.getByTestId('pr-files-column').bounds()
  const list = await a.getByTestId('pr-files').bounds()
  const tab = await a.getByTestId('pr-changes').bounds()
  console.log(`column ${JSON.stringify(col)} list ${JSON.stringify(list)} tab ${JSON.stringify(tab)}`)
  if (!compact) assert.ok(list.y + list.height > tab.y + tab.height - 40, `the list reaches the bottom of the tab: ${list.y + list.height} vs ${tab.y + tab.height}`)
  assert.match(await painted(), /65 files/)
  await shot('1-tree')
  // Closing a folder hides its rows; the flat list shows every file.
  await click('pr-mode-list')
  await shot('3-list')
  await click('pr-mode-tree')
  console.log(`PASS ${tag}`)
} catch (error) {
  await shot('failure').catch(() => {})
  console.log(f.diagnostics())
  throw error
} finally { await f.close(); fixture.close() }
