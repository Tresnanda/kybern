/** Scratch-only Settings smoke check. Always restores the changed setting and closes its window. */
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { launch } from '@gpuix/react/automation'
import { appearance, setAppearance } from '../src/settings/appearance.ts'
import { KybernClient } from '../../../packages/kybern-client/src/client.ts'

const dir = process.env.KYBERN_DATA_DIR
if (!dir || !dir.includes('gpuix-scratch')) throw new Error('Set KYBERN_DATA_DIR to the GPUIX scratch daemon')
const out = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? '/Users/mymac/projects/ade/previews/gpuix/settings'
const liveTheme = process.argv.includes('--live-theme')
const originalAppearance = { ...appearance() }
const mode = process.argv.includes('--light') ? 'light' : 'dark'
mkdirSync(out, { recursive: true })
const endpoint = { url: `ws://127.0.0.1:${readFileSync(path.join(dir, 'daemon.port'), 'utf8').trim()}/ws`, token: readFileSync(path.join(dir, 'daemon.token'), 'utf8').trim() }
const client = new KybernClient(endpoint, { createSocket: (url, token) => new WebSocket(url, { headers: { origin: 'tauri://localhost', Authorization: `Bearer ${token}` } } as unknown as string[]) })
client.connect()
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
for (let i = 0; client.status !== 'open' && i < 100; i++) await wait(100)
const before = await client.call('settings.get', {})
const app = await launch({ command: 'bun', args: [path.join(import.meta.dir, '../src/main.tsx')], env: { ...process.env, GPUIX_BACKGROUND: '1', KYBERN_APPEARANCE: liveTheme ? '' : mode } })
try {
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60000 })
  await wait(1500)
  await app.getByTestId('rail-settings').click()
  await app.getByTestId('settings-worktrees').waitFor()
  await wait(2000)
  await app.screenshot({ path: path.join(out, `general-${mode}.png`) })
  await app.getByTestId('settings-worktrees').click()
  await wait(400)
  await app.screenshot({ path: path.join(out, `after-toggle-${mode}.png`) });
  const changed = await client.call('settings.get', {})
  if (changed.worktrees_default === before.worktrees_default) throw new Error('Switch did not round-trip through settings.update')
  console.log('PASS: switch round-trip')
  await client.call('settings.update', { settings: { ...changed, worktrees_default: before.worktrees_default } })
  await wait(400)
  // If the notification was adopted, clicking again must invert the restored value.
  await app.getByTestId('settings-worktrees').click()
  await wait(400)
  const afterEvent = await client.call('settings.get', {})
  if (afterEvent.worktrees_default === before.worktrees_default) throw new Error('UI did not adopt settings.changed')
  console.log('PASS: settings.changed updates the UI')
  for (const tab of ['appearance', 'agents', 'accounts', 'integrations', 'computer', 'background', 'notifications', 'about']) {
    await app.getByTestId(`settings-tab-${tab}`).click()
    await wait(650)
    await app.screenshot({ path: path.join(out, `${tab}-${mode}.png`) })
  }
  await app.getByTestId('settings-tab-agents').click()
  await wait(300)
  await app.call('scrollTo', { elementId: (await app.getByTestId('settings-content').element()).id, x: 0, y: 500 })
  await app.getByTestId('settings-max-agents').fill('0')
  await app.getByTestId('settings-max-agents').press('enter')
  await wait(300)
  const bounded = await client.call('settings.get', {})
  if (bounded.orchestration.max_active_children !== 1) throw new Error('Number field did not clamp and save on Enter')
  await client.call('settings.update', { settings: { ...bounded, orchestration: { ...bounded.orchestration, max_active_children: before.orchestration.max_active_children } } })
  console.log('PASS: number field clamps and saves on Enter')
  if (liveTheme) {
    await app.getByTestId('settings-tab-appearance').click()
    await wait(400)
    await app.getByTestId('settings-theme-light').click()
    await wait(300)
    await app.screenshot({ path: path.join(out, 'live-light.png') })
    const prefsFile = path.join(homedir(), 'Library/Application Support/kybern-gpuix', `appearance-${createHash('sha1').update(process.env.KYBERN_URL ?? dir).digest('hex').slice(0, 12)}.json`)
    if (JSON.parse(readFileSync(prefsFile, 'utf8')).theme !== 'light') throw new Error('Light theme was not saved')
    await app.getByTestId('settings-theme-dark').click()
    await wait(300)
    await app.screenshot({ path: path.join(out, 'live-dark.png') })
    if (JSON.parse(readFileSync(prefsFile, 'utf8')).theme !== 'dark') throw new Error('Dark theme was not saved')
    console.log('PASS: live appearance switches native content colors')
  }
  await app.getByTestId('settings-search').fill('worktree')
  await wait(150)
  await app.screenshot({ path: path.join(out, `search-${mode}.png`) }); await app.getByTestId('settings-search').press('enter'); await wait(300); await app.screenshot({ path: path.join(out, `searched-${mode}.png`) })
  await app.getByTestId('settings-worktrees').waitFor()
  await app.getByTestId('settings-back').press('escape')
  await wait(300)
  if (await app.getByTestId('page-settings').count()) throw new Error('Escape did not close Settings')
  await app.getByTestId('composer').press('cmd-,')
  await app.getByTestId('settings-back').waitFor()
  await app.getByTestId('settings-back').click()
  await wait(300)
  console.log('PASS: all sections, search, Escape, shortcut and Back')
} finally {
  const fresh = await client.call('settings.get', {})
  await client.call('settings.update', { settings: { ...fresh, worktrees_default: before.worktrees_default, orchestration: { ...fresh.orchestration, max_active_children: before.orchestration.max_active_children } } })
  await app.close()
  client.close()
  if (liveTheme) setAppearance(originalAppearance)
}
