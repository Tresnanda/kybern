/**
 * settings9a rail usage card: plan limits come from the settings proxy (mocked `usage.limits` and account list, so the rings
 * exist without reading real provider accounts), everything else is the REAL scratch daemon. Hover a ring, pick a default
 * account, sign a needs-sign-in account in again, follow Manage accounts / Usage details / Add account, and assert the
 * daemon's settings after each write.
 *
 *   bun src/usage/verify9a-rail.ts [--light] [--reduced]
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { launchFixture } from '../requests/harness.ts'

const ROOT = '/Users/mymac/projects/ade-gpuix-scratch'
const DIR = `${ROOT}/phase2-settings9-a2`
const CLIENT_DIR = `${ROOT}/phase2-settings9-a2-client`
const PORT = 4296
const EVIDENCE = '/Users/mymac/projects/ade/previews/gpuix/phase2/settings9/partA/verify'
const light = process.argv.includes('--light')
const reduced = process.argv.includes('--reduced')
const tag = `rail-${light ? 'light' : 'dark'}-${reduced ? 'reduced' : 'motion'}`
mkdirSync(EVIDENCE, { recursive: true })
for (const d of [DIR, CLIENT_DIR]) { if (!d.includes('gpuix-scratch')) throw Error('Use scratch data'); rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }) }
for (const d of ['codex-work', 'codex-side']) mkdirSync(path.join(DIR, d), { recursive: true })
const OPEN_LOG = `${DIR}-open.log`; rmSync(OPEN_LOG, { force: true })

const daemon: ChildProcess = spawn('/Applications/kybern.app/Contents/MacOS/kybernd', ['--data-dir', DIR, '--port', String(PORT)], { stdio: 'ignore' })
const token = async () => { for (let i = 0; i < 200; i++) { try { return readFileSync(path.join(DIR, 'daemon.token'), 'utf8').trim() } catch { await Bun.sleep(100) } } throw Error('daemon did not start') }
const secret = await token()
const client = new KybernClient({ url: `ws://127.0.0.1:${PORT}/ws`, token: secret })
client.connect()
for (let i = 0; client.status !== 'open' && i < 200; i++) await Bun.sleep(50)
const folder = path.join(DIR, 'project'); mkdirSync(folder, { recursive: true })
const project = await client.call('projects.add', { path: folder, name: 'Scratch project' })
const settings0 = await client.call('settings.get', {})
await client.call('settings.update', { settings: { ...settings0, providers: { ...settings0.providers, codex: { ...(settings0.providers.codex ?? { env: {} }), default_account: 'work', accounts: { work: { name: 'Work', color: 'blue', directory: path.join(DIR, 'codex-work') }, side: { name: 'Side projects', color: 'amber', directory: path.join(DIR, 'codex-side') } } } } } })

// The settings proxy answers the usage and account reads in `s9-rich` mode and forwards writes to the daemon.
const ready = `${DIR}-proxy.json`; rmSync(ready, { force: true })
const proxy = spawn('bun', [path.resolve(import.meta.dir, '../../visual/fixture.settings.ts'), '--proxy', JSON.stringify({ port: PORT, token: secret, ready, projectId: project.id, threadId: 'none' })], { stdio: 'ignore' })
for (let i = 0; i < 200 && !existsSync(ready); i++) await Bun.sleep(50)
const proxyPort = (JSON.parse(readFileSync(ready, 'utf8')) as { port: number }).port
await fetch(`http://127.0.0.1:${proxyPort}/mode?value=s9-rich`)

const launch = () => launchFixture(path.join(import.meta.dir, '../main.tsx'), {
  GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_URL: `ws://127.0.0.1:${proxyPort}/ws`, KYBERN_TOKEN: secret, KYBERN_DATA_DIR: DIR, KYBERN_CLIENT_CONFIG_DIR: CLIENT_DIR, KYBERN_GPUIX_CREDENTIALS_DIR: `${CLIENT_DIR}/credentials`,
  KYBERN_APPEARANCE: light ? 'light' : 'dark', KYBERN_REDUCED_MOTION: reduced ? '1' : '0', KYBERN_OPEN_URL_LOG: OPEN_LOG,
})
let f = await launch()
const app = new Proxy({} as typeof f.app, { get: (_t, key) => (f.app as never)[key] })
const settle = (ms = 500) => Bun.sleep(ms)
const until = async (what: string, fn: () => Promise<boolean> | boolean, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return } catch { /* not yet */ } await Bun.sleep(80) } throw Error(`Timed out: ${what}`) }
const has = async (id: string) => (await app.getByTestId(id).count()) > 0
const painted = async () => (await app.call('getPaintedText', {})).text.join('\n')
const hasText = async (t: string) => (await painted()).includes(t) || (await app.getByText(t).count()) > 0
const shot = async (name: string) => { await app.mouse.move({ x: 700, y: 400 }); await settle(150); await app.screenshot({ path: `${EVIDENCE}/${name}-${tag}.png` }) }
const still = (name: string) => app.screenshot({ path: `${EVIDENCE}/${name}-${tag}.png` })
const hover = async (kind: string) => { await app.mouse.move({ x: 700, y: 400 }); await settle(300); await app.getByTestId(`rail-usage-${kind}`).hover(); await until('card', () => has(`rail-accounts-${kind}`), 8000); await settle(700) }
const results: { name: string; ok: boolean; note?: string }[] = []
async function check(name: string, fn: () => Promise<void>) {
  for (let attempt = 0; ; attempt++) {
    try { await fn(); results.push({ name, ok: true }); console.log(`PASS ${name}`); return }
    catch (error) {
      const message = String(error).split('\n')[0]!
      if (attempt === 0 && /Fixture exited/.test(message)) { console.log(`relaunch: ${message}`); await f.close().catch(() => {}); f = await launch(); await app.getByTestId('app-ready').waitFor({ timeoutMs: 60000 }); await settle(1500); continue }
      results.push({ name, ok: false, note: message }); console.log(`FAIL ${name}: ${message}`); await shot(`FAIL-${name.replace(/\W+/g, '-')}`).catch(() => {}); return
    }
  }
}
const settingsNow = () => client.call('settings.get', {})
try {
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60000 }); await settle(2000)
  await check('rail: one ring per provider with limits, ring dot for the default account', async () => {
    await until('rings', async () => (await has('rail-usage-codex')) && (await has('rail-usage-claude-code')))
    await shot('rail-rings')
  })
  await check('rail: hovering a ring opens the card with accounts, limits, pace and the footer actions', async () => {
    await hover('codex'); await still('rail-card-codex')
    for (const text of ['Usage details', '5-hour', 'Weekly', 'Manage accounts…', 'Add account', '% left', 'Needs sign-in']) assert.ok(await hasText(text), text)
    assert.ok(await has('rail-account-default') && await has('rail-account-work') && await has('rail-account-side'))
  })
  await check('rail: choosing an account writes default_account on the daemon and says "Default changed"', async () => {
    // The proxy's account list is static and marks Work as the default, so the daemon starts on Work and the CLI row is the one to choose.
    assert.equal((await settingsNow()).providers.codex?.default_account, 'work')
    await app.getByTestId('rail-account-default').click()
    await until('daemon cli', async () => !(await settingsNow()).providers.codex?.default_account)
    await until('note', () => hasText('Default changed'), 5000)
    await still('rail-default-changed')
  })
  await check('rail: Sign in on a needs-sign-in account opens the sheet signing that account in again (real daemon login)', async () => {
    await hover('codex'); await app.getByTestId('rail-account-signin-side').click()
    await until('sheet', async () => (await has('add-account')) && ((await hasText('Enter this code in your browser')) || (await hasText('Continue in browser'))), 20000); await shot('rail-signin-again')
    // The sheet went straight to the sign-in step (no agent picker), so the daemon started a login for that account.
    assert.ok(!(await has('account-provider-codex')), 'no agent picker')
    await app.getByTestId('account-cancel').click(); await until('closed', async () => !(await has('add-account')))
  })
  await check('rail: Add account opens the sheet with the card\'s agent selected', async () => {
    await hover('codex'); await app.getByText('Add account').click()
    await until('sheet', () => has('add-account')); await settle(600)
    assert.ok(await has('account-provider-codex') && await has('account-start'), 'agent picker with Continue'); await shot('rail-add-account')
    // Continue is enabled only with an agent chosen: pressing it starts the Codex sign-in (a device code, the proxy marks this environment remote).
    await app.getByTestId('account-start').click()
    await until('codex step', async () => (await hasText('Enter this code in your browser')) || (await hasText('Continue in browser')) || (await hasText('Sign in to Codex')), 20000)
    await app.getByTestId('account-cancel').click(); await until('closed', async () => !(await has('add-account')))
  })
  await check('rail: Manage accounts… opens Settings › Accounts', async () => {
    await hover('codex'); await app.getByText('Manage accounts…').click()
    await until('settings accounts', async () => (await has('page-settings')) && (await has('account-add')))
    await app.getByTestId('settings-back').click(); await until('closed', async () => !(await has('page-settings')))
  })
  await check('rail: Usage details opens the Usage page', async () => {
    await hover('claude-code'); await app.getByText('Usage details').click()
    await until('usage page', () => has('page-usage'))
  })
} finally {
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed (${tag})`)
  await f.close().catch(() => {})
  client.close(); daemon.kill(); proxy.kill()
  if (failed.length) process.exitCode = 1
}
