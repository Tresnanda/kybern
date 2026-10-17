/**
 * settings9a behaviour check against a REAL scratch daemon (never ~/.kybern): Settings › General, Computer use,
 * Integrations and Accounts, the Add account sheet's sign-in steps and the rail usage card are driven with
 * pointer and key input in the running app, and every write is asserted on the daemon through a second client.
 *
 *   bun src/settings/verify9a.ts [--light] [--reduced]
 *
 * Nothing signs in to a real account (sign-ins start and are canceled), nothing installs CuaDriver and
 * no plugin changes: URLs the app would open are recorded in KYBERN_OPEN_URL_LOG instead.
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { launchFixture } from '../requests/harness.ts'

const ROOT = '/Users/mymac/projects/ade-gpuix-scratch'
const DIR = process.env.VERIFY9A_DIR ?? `${ROOT}/phase2-settings9-a`
const CLIENT_DIR = `${DIR}-client`
const PORT = Number(process.env.VERIFY9A_PORT ?? 4296)
const EVIDENCE = process.env.VERIFY9A_EVIDENCE ?? '/Users/mymac/projects/ade/previews/gpuix/phase2/settings9/partA/verify'
const light = process.argv.includes('--light')
const reduced = process.argv.includes('--reduced')
const tag = `${light ? 'light' : 'dark'}-${reduced ? 'reduced' : 'motion'}`
if (!DIR.includes('gpuix-scratch') || !CLIENT_DIR.includes('gpuix-scratch')) throw Error('Use scratch data')
mkdirSync(EVIDENCE, { recursive: true })
const OPEN_LOG = `${DIR}-open.log`

// ── daemon ────────────────────────────────────────────────────────────────────
rmSync(DIR, { recursive: true, force: true }); rmSync(CLIENT_DIR, { recursive: true, force: true }); rmSync(OPEN_LOG, { force: true })
mkdirSync(DIR, { recursive: true }); mkdirSync(CLIENT_DIR, { recursive: true })
for (const d of ['codex-work', 'codex-side']) mkdirSync(path.join(DIR, d), { recursive: true })
const daemon: ChildProcess = spawn('/Applications/kybern.app/Contents/MacOS/kybernd', ['--data-dir', DIR, '--port', String(PORT)], { stdio: 'ignore' })
const token = async () => { for (let i = 0; i < 200; i++) { try { return readFileSync(path.join(DIR, 'daemon.token'), 'utf8').trim() } catch { await Bun.sleep(100) } } throw Error('daemon did not start') }
const client = new KybernClient({ url: `ws://127.0.0.1:${PORT}/ws`, token: await token() })
client.connect()
for (let i = 0; client.status !== 'open' && i < 200; i++) await Bun.sleep(50)
assert.equal(client.status, 'open')

const folder = path.join(DIR, 'project'); mkdirSync(folder, { recursive: true })
const project = await client.call('projects.add', { path: folder, name: 'Scratch project' })
const settings0 = await client.call('settings.get', {})
await client.call('settings.update', {
  settings: {
    ...settings0,
    computer_use: { ...settings0.computer_use, enabled: false, foreground: 'ask', show_cursor: false, always_allowed_apps: ['Calculator', 'Notes'] },
    preview_allowed_folders: ['/tmp/s9a-folder-a', '/tmp/s9a-folder-b'],
    providers: { ...settings0.providers, codex: { ...(settings0.providers.codex ?? { env: {} }), accounts: { work: { name: 'Work', color: 'blue', directory: path.join(DIR, 'codex-work') }, side: { name: 'Side projects', color: 'amber', directory: path.join(DIR, 'codex-side') } } } },
  },
})
await client.call('computer.notes.set', { bundle_id: 'com.apple.Notes', app: 'Notes', text: 'Use the sidebar to switch folders.' })
const logins = new Map<string, { id: string; kind: string; mode: string; phase: string }>()
client.onNotification('providers.accounts.login.changed', (l) => { const x = l as { id: string; kind: string; mode: string; phase: string }; logins.set(x.id, x) })
const latest = (kind: string) => [...logins.values()].filter((l) => l.kind === kind).at(-1)
const accountsOf = async (kind: string) => (await client.call('providers.accounts.list', {})).accounts.filter((a) => a.provider.kind === kind)

// ── app ───────────────────────────────────────────────────────────────────────
const launch = () => launchFixture(path.join(import.meta.dir, '../main.tsx'), {
  GPUIX_BACKGROUND: '1', KYBERN_OPAQUE: '1', KYBERN_DATA_DIR: DIR, KYBERN_CLIENT_CONFIG_DIR: CLIENT_DIR, KYBERN_GPUIX_CREDENTIALS_DIR: `${CLIENT_DIR}/credentials`,
  KYBERN_APPEARANCE: light ? 'light' : 'dark', KYBERN_REDUCED_MOTION: reduced ? '1' : '0', KYBERN_OPEN_URL_LOG: OPEN_LOG,
})
let f = await launch()
/** Always the live window; the proxy forwards to whichever app instance is current (see `relaunch`). */
const app = new Proxy({} as typeof f.app, { get: (_t, key) => (f.app as never)[key] })
async function relaunch() { await f.close().catch(() => {}); f = await launch(); await app.getByTestId('app-ready').waitFor({ timeoutMs: 60000 }); await Bun.sleep(1500) }
const settle = (ms = 500) => Bun.sleep(ms)
const until = async (what: string, fn: () => Promise<boolean> | boolean, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return } catch { /* not yet */ } await Bun.sleep(80) } throw Error(`Timed out: ${what}`) }
const has = async (id: string) => (await app.getByTestId(id).count()) > 0
const painted = async () => (await app.call('getPaintedText', {})).text.join('\n')
const hasText = async (text: string) => (await painted()).includes(text)
/** Scroll the Settings content until the control is on screen, then click it like a pointer would. */
/** Bounds from the last paint, not the automation tree's cached ones (a virtualised row keeps its old rect after it scrolls away). */
async function freshBounds(id: string) {
  try { const node = await app.getByTestId(id).element(); return (await app.call('getBounds', { elementId: node.id })).bounds ?? null } catch { return null }
}
async function reach(id: string) {
  if (/^(rail|settings-tab)-/.test(id)) return // fixed chrome, never scrolls
  if (!(await has(id))) {
    await app.mouse.wheel({ x: 700, y: 400 }, 0, 8000); await settle(200) // top, then walk down
    await until(`${id} mounted`, async () => { if (await has(id)) return true; await app.mouse.wheel({ x: 700, y: 400 }, 0, -300); await settle(60); return false }, 20000)
  }
  let unpainted = 0
  for (let i = 0; i < 40; i++) {
    const b = await freshBounds(id)
    if (process.env.VERBOSE) console.log('reach', id, i, JSON.stringify(b))
    if (b && b.y >= 70 && b.y + b.height <= 790) return
    // A mounted row that is not painted lies off screen: look at the top once, then walk down.
    await app.mouse.wheel({ x: 700, y: 400 }, 0, !b ? (unpainted++ === 0 ? 8000 : -250) : b.y < 70 ? 250 : -250); await settle(120)
  }
}
const top = async () => { for (let i = 0; i < 3; i++) { await app.mouse.wheel({ x: 700, y: 400 }, 0, 8000); await settle(150) } }
const click = async (id: string) => { await reach(id); const b = await freshBounds(id); if (b) await app.mouse.click({ x: b.x + b.width / 2, y: b.y + b.height / 2 }); else await app.getByTestId(id).click(); await settle(250) }
// Pointer movement asks the idle background window for frames, so entrance tweens finish before the picture is taken.
const shot = async (name: string) => { await app.mouse.move({ x: 600, y: 300 }); await settle(150); await app.mouse.move({ x: 1275, y: 815 }); await settle(500); await app.mouse.move({ x: 1270, y: 810 }); await settle(300); await app.screenshot({ path: `${EVIDENCE}/${name}-${tag}.png` }) }
const results: { name: string; ok: boolean; note?: string }[] = []
/** A check opens its own Settings tab. The window can be closed from outside (another lane's cleanup): relaunch it and retry once. */
async function check(name: string, where: string | null, fn: () => Promise<void>) {
  if (process.env.ONLY && !new RegExp(process.env.ONLY).test(name)) return
  for (let attempt = 0; ; attempt++) {
    try { if (where) await tab(where); await fn(); results.push({ name, ok: true }); console.log(`PASS ${name}${attempt ? ' (after relaunch)' : ''}`); return }
    catch (error) {
      const message = String(error).split('\n')[0]!
      if (attempt === 0 && /Fixture exited|Fixture startup/.test(message)) { console.log(`relaunch: ${message}`); await relaunch(); continue }
      results.push({ name, ok: false, note: message }); console.log(`FAIL ${name}: ${message}`); await shot(`FAIL-${name.replace(/\W+/g, '-')}`).catch(() => {}); return
    }
  }
}
const settingsNow = () => client.call('settings.get', {})
const openLog = () => (existsSync(OPEN_LOG) ? readFileSync(OPEN_LOG, 'utf8').trim().split('\n').filter(Boolean) : [])
const tab = async (name: string) => { if (!(await has('page-settings'))) await click('rail-settings'); await click(`settings-tab-${name}`); await settle(900) }
/** Click a Select option by its test id (`<trigger>-<value>`). */
const choose = async (trigger: string, value: string) => { await click(trigger); await app.getByTestId(`${trigger}-${value}`).waitFor({ timeoutMs: 5000 }); await app.getByTestId(`${trigger}-${value}`).click(); await settle(500) }

try {
  await app.getByTestId('app-ready').waitFor({ timeoutMs: 60000 }); await settle(1500)

  // ── 1. General ──────────────────────────────────────────────────────────────
  await tab('general')
  await shot('general')
  for (const [id, key] of [['settings-worktrees', 'worktrees_default'], ['settings-titles', 'generate_titles'], ['settings-cleanup', 'automatic_worktree_cleanup']] as const) {
    await check(`general: ${id} flips ${key} on the daemon`, 'general', async () => {
      const before = Boolean((await settingsNow())[key]); await click(id)
      await until('daemon changed', async () => Boolean((await settingsNow())[key]) === !before)
      await click(id); await until('daemon restored', async () => Boolean((await settingsNow())[key]) === before)
    })
  }
  await check('general: default permissions select writes default_permission_mode', 'general', async () => {
    await choose('settings-permissions', 'auto')
    await until('daemon', async () => (await settingsNow()).default_permission_mode === 'auto')
    await choose('settings-permissions', 'supervised'); await until('daemon back', async () => (await settingsNow()).default_permission_mode === 'supervised')
  })
  await check('general: default agent select writes default_provider (agent mark in the menu)', 'general', async () => {
    const providers = (await client.call('providers.list', {})).providers.filter((p) => p.available)
    const other = providers.find((p) => p.kind !== (settings0.default_provider))!
    await click('settings-default-agent'); await shot('general-agent-menu');
    await app.getByTestId(`settings-default-agent-${other.kind}`).click(); await settle(500)
    await until('daemon', async () => (await settingsNow()).default_provider === other.kind)
    await choose('settings-default-agent', settings0.default_provider)
    await until('daemon back', async () => (await settingsNow()).default_provider === settings0.default_provider)
  })
  await check('general: Preview allowed folders list and Remove', 'general', async () => {
    await reach('preview-folder-0'); await shot('general-preview-folders')
    await click('preview-folder-remove-0')
    await until('daemon', async () => !(await settingsNow()).preview_allowed_folders?.includes('/tmp/s9a-folder-a'))
    assert.deepEqual((await settingsNow()).preview_allowed_folders, ['/tmp/s9a-folder-b'])
    await click('preview-folder-remove-0'); await until('empty', async () => ((await settingsNow()).preview_allowed_folders ?? []).length === 0)
    await until('empty copy', () => hasText('None yet. Kybern asks the first time a page outside your projects opens in Preview.'))
  })

  // ── 2. Computer use ─────────────────────────────────────────────────────────
  await tab('computer')
  await shot('computer-off')
  await check('computer: enabled switch writes computer_use.enabled', 'computer', async () => {
    await click('computer-enabled'); await until('daemon on', async () => (await settingsNow()).computer_use.enabled === true)
    await until('readiness copy', async () => (await hasText('Finish setup below')) || (await hasText('Ready. Ask any agent')))
    await shot('computer-on')
  })
  await check('computer: cursor and keyboard select writes foreground', 'computer', async () => {
    await choose('computer-foreground', 'never'); await until('daemon', async () => (await settingsNow()).computer_use.foreground === 'never')
    await choose('computer-foreground', 'ask'); await until('daemon back', async () => (await settingsNow()).computer_use.foreground === 'ask')
  })
  await check('computer: agent cursor switch writes show_cursor', 'computer', async () => {
    await click('computer-cursor'); await until('daemon', async () => (await settingsNow()).computer_use.show_cursor === true)
    await click('computer-cursor'); await until('daemon back', async () => !(await settingsNow()).computer_use.show_cursor)
  })
  await check('computer: allowed app chip removes the app', 'computer', async () => {
    await click('computer-allowed-Calculator')
    await until('daemon', async () => !(await settingsNow()).computer_use.always_allowed_apps?.includes('Calculator'))
    assert.deepEqual((await settingsNow()).computer_use.always_allowed_apps, ['Notes'])
  })
  await check('computer: setup rows reflect the daemon status (installed or install button)', 'computer', async () => {
    const status = await client.call('computer.status', {})
    await reach(status.installed ? 'computer-grant' : 'computer-install').catch(() => {})
    if (!status.installed) { assert.ok(await has('computer-install'), 'Install CuaDriver button'); assert.ok(await hasText('Install CuaDriver')) }
    else assert.ok(await hasText('Version'))
    await shot('computer-setup')
  })
  await check('computer: app note edit saves to the daemon, count and limit', 'computer', async () => {
    await click('computer-note-edit-com.apple.Notes'); await app.getByTestId('computer-note-text').fill('Clear before a new sum.'); await settle(300)
    assert.ok(await hasText('23 of 1500 characters'))
    await shot('computer-note-edit')
    await click('computer-note-save'); await until('daemon', async () => (await client.call('computer.notes.list', {})).notes[0]?.text === 'Clear before a new sum.')
    await click('computer-note-edit-com.apple.Notes'); await app.getByTestId('computer-note-text').fill('x'.repeat(1501)); await settle(300)
    assert.ok(await hasText('1501 of 1500 characters')); await click('computer-note-save')
    assert.equal((await client.call('computer.notes.list', {})).notes[0]?.text, 'Clear before a new sum.', 'over-limit note was not sent')
    await shot('computer-note-over-limit')
  })
  await check('computer: deleting a note removes it, Undo restores it', 'computer', async () => {
    await until('editing closed or cancel', async () => true)
    if (await has('computer-note-save')) { await app.getByText('Cancel').click(); await settle(300) }
    await click('computer-note-delete-com.apple.Notes'); await until('deleted', async () => (await client.call('computer.notes.list', {})).notes.length === 0)
    await until('undo toast', () => hasText('Deleted the notes on Notes'))
    await app.getByText('Undo').click(); await until('restored', async () => (await client.call('computer.notes.list', {})).notes[0]?.text === 'Clear before a new sum.')
  })

  // ── 3. Integrations ─────────────────────────────────────────────────────────
  await tab('integrations')
  await check('integrations: list loads from the daemon, pickers, switch and search', 'integrations', async () => {
    await until('catalog or empty state', async () => (await has('integrations-list')) || (await has('integrations-empty')))
    await shot('integrations-plugins')
    await click('integrations-kind-connector'); await until('connector hint', () => hasText('Find a connector') || has('integrations-empty'))
    await shot('integrations-connectors')
    await app.getByTestId('integrations-search').fill('zzzz-no-match'); await settle(400)
    assert.ok(await hasText('No matches')); assert.ok(await hasText('Clear search')); await shot('integrations-no-match')
    await app.getByText('Clear search').click(); await settle(300)
  })
  await check('integrations: Add connector opens the connectors page (recorded)', 'integrations', async () => {
    await click('integrations-add-connector')
    await until('url', () => openLog().includes('https://claude.ai/settings/connectors'))
  })
  await check('integrations: agent picker switches to Codex hint', 'integrations', async () => {
    await choose('integrations-agent', 'codex')
    await until('codex hint', () => hasText('Type @ in a conversation'))
    await choose('integrations-agent', 'claude-code')
  })

  // ── 4. Accounts (CLI + two named accounts, real daemon) ─────────────────────
  await tab('accounts')
  await check('accounts: lists the CLI account and named accounts with the daemon status', 'accounts', async () => {
    await until('rows', async () => (await has('account-row-codex-work')) && (await has('account-row-codex-side')) && (await has('account-row-codex-default')))
    await shot('accounts')
  })
  await check('accounts: rename (menu → Rename… → Enter) calls providers.accounts.update', 'accounts', async () => {
    await click('account-actions-codex-work'); await click('account-actions-codex-work-rename')
    await app.getByTestId('account-rename').fill('Work renamed'); await app.getByTestId('account-rename').press('enter')
    await until('daemon', async () => (await accountsOf('codex')).some((a) => a.provider.instance === 'work' && a.name === 'Work renamed'))
    await shot('accounts-renamed')
  })
  await check('accounts: color submenu writes the account color', 'accounts', async () => {
    await click('account-actions-codex-work'); await click('account-actions-codex-work-color'); await shot('accounts-color-menu')
    await click('account-actions-codex-work-color-teal')
    await until('daemon', async () => (await accountsOf('codex')).find((a) => a.provider.instance === 'work')?.color === 'teal')
  })
  await check('accounts: Make default writes default_account; CLI account clears it', 'accounts', async () => {
    await click('account-actions-codex-side'); await click('account-actions-codex-side-default')
    await until('daemon side', async () => (await settingsNow()).providers.codex?.default_account === 'side')
    // Visible result: the menu of the new default drops "Make default", the CLI account's offers it.
    await click('account-actions-codex-side'); await until('side menu', () => has('account-actions-codex-side-rename'))
    assert.ok(!(await has('account-actions-codex-side-default')), 'the default account offers no Make default')
    await app.getByTestId('account-actions-codex-side-rename').press('escape'); await until('menu closed', async () => !(await has('account-actions-codex-side-rename')))
    await settle(300); assert.ok(await has('page-settings'), 'Escape closed the menu only, not Settings')
    await shot('accounts-default-side')
    await click('account-actions-codex-default'); await click('account-actions-codex-default-default')
    await until('daemon cli', async () => !(await settingsNow()).providers.codex?.default_account)
    await click('account-actions-codex-side'); await until('side offers Make default again', () => has('account-actions-codex-side-default'))
    await app.getByTestId('account-actions-codex-side-default').press('escape'); await until('menu closed', async () => !(await has('account-actions-codex-side-default')))
  })
  await check('accounts: Use for projects… saves project_accounts', 'accounts', async () => {
    await click('account-actions-codex-work'); await click('account-actions-codex-work-projects'); await app.getByTestId('account-projects').waitFor({ timeoutMs: 5000 }); await shot('accounts-projects')
    await app.getByTestId(`account-project-${project.id}`).click(); await settle(200); await app.getByTestId('account-projects-save').click()
    await until('daemon', async () => (await settingsNow()).providers.codex?.project_accounts?.[folder] === 'work')
    await click('account-actions-codex-work'); await click('account-actions-codex-work-projects'); await app.getByTestId(`account-project-${project.id}`).click(); await settle(200); await app.getByTestId('account-projects-save').click()
    await until('cleared', async () => !(await settingsNow()).providers.codex?.project_accounts?.[folder])
  })
  await check('accounts: Remove… confirms, then the daemon drops the account', 'accounts', async () => {
    await click('account-actions-codex-side'); await click('account-actions-codex-side-remove'); await app.getByTestId('account-remove').waitFor({ timeoutMs: 5000 }); await shot('accounts-remove')
    await app.getByTestId('account-remove-confirm').click()
    await until('daemon', async () => !(await accountsOf('codex')).some((a) => a.provider.instance === 'side'))
    assert.ok(!(await settingsNow()).providers.codex?.accounts?.side)
  })

  // ── 5. Add account sheet: real daemon sign-ins up to the browser/code/terminal step, then cancel ──
  const opened0 = openLog().length
  await check('add account: pick step has no agent selected and Continue disabled', 'accounts', async () => {
    await top(); await click('account-add'); await settle(1000); await app.getByTestId('add-account').waitFor({ timeoutMs: 8000 }); await shot('add-pick')
    assert.ok(await hasText('Add an account')); assert.ok(await hasText('Your current sign-ins stay as they are.'))
    assert.equal(openLog().length, opened0, 'nothing opens before an agent is picked')
    await app.getByTestId('account-cancel').click(); await until('closed', async () => !(await has('add-account')))
  })
  await check('add account: Codex → browser step opens the sign-in page (recorded) and Cancel cancels the daemon login', 'accounts', async () => {
    await top(); await click('account-add'); await app.getByTestId('add-account').waitFor({ timeoutMs: 8000 })
    await app.getByTestId('account-provider-codex').click(); await shot('add-pick-selected')
    await app.getByTestId('account-advanced').click(); await settle(300); await shot('add-advanced'); await app.getByTestId('account-advanced').click()
    const before = openLog().length
    await app.getByTestId('account-start').click()
    await until('waiting step', () => hasText('Finish signing in in your browser'), 20000)
    await until('browser opened', () => openLog().length > before, 20000); assert.match(openLog().at(-1)!, /^https:\/\//)
    await shot('add-waiting')
    await app.getByTestId('account-cancel').click(); await until('closed', async () => !(await has('add-account')))
    await until('daemon canceled', () => latest('codex')?.phase === 'canceled', 20000)
  })
  await check('add account: device code (Codex) shows a one-time code from the daemon', 'accounts', async () => {
    await top(); await click('account-add'); await app.getByTestId('account-provider-codex').click(); await app.getByTestId('account-start').click()
    await until('waiting', () => hasText('Finish signing in in your browser'), 20000)
    await app.getByTestId('account-code-instead').click()
    await until('device step', () => hasText('Enter this code in your browser'), 20000)
    await until('code painted', async () => /[A-Z0-9]{4}-[A-Z0-9]{4,5}/.test(await painted()), 20000)
    await shot('add-device')
    await app.getByTestId('account-cancel').click(); await until('closed', async () => !(await has('add-account')))
  })
  await check('add account: Claude Code paste step sends the code and waits on the daemon (verifying)', 'accounts', async () => {
    await top(); await click('account-add'); await app.getByTestId('account-provider-claude-code').click(); await app.getByTestId('account-start').click()
    await until('waiting', () => hasText('Finish signing in in your browser'), 20000)
    await app.getByTestId('account-code-instead').click()
    await until('paste step', () => hasText('Paste the sign-in code'), 20000); await shot('add-paste')
    await app.getByTestId('account-code').fill('not-a-real-code'); await app.getByTestId('account-code-toggle').click(); await settle(300); await shot('add-paste-shown')
    await app.getByTestId('account-paste-submit').click()
    await until('daemon verifying', () => latest('claude-code')?.phase === 'verifying', 20000)
    assert.equal(latest('claude-code')?.mode, 'paste'); await shot('add-paste-verifying')
    await app.getByTestId('account-cancel').click(); await until('closed', async () => !(await has('add-account')))
    await until('daemon canceled', () => latest('claude-code')?.phase === 'canceled', 20000)
  })
  await check('add account: Show terminal runs the agent sign-in in a terminal (opencode)', 'accounts', async () => {
    await top(); await click('account-add'); await app.getByTestId('account-provider-opencode').click(); await app.getByTestId('account-start').click()
    await until('terminal step', () => hasText('Finish in the terminal'), 20000); await until('terminal output', async () => (await painted()).length > 0 && /opencode|provider|API|Select|login|▲|\\$/i.test(await painted()), 20000).catch(() => {}); await settle(1500)
    assert.ok(await has('account-terminal')); await shot('add-terminal')
    await app.getByTestId('account-cancel').click(); await until('closed', async () => !(await has('add-account')))
  })
  await check('add account: Sign in again to a named account starts straight away', 'accounts', async () => {
    await click('account-actions-codex-work'); await click('account-actions-codex-work-signin')
    await until('waiting', async () => (await hasText('Sign in again to Work renamed')), 20000); await shot('add-reauth')
    await app.getByTestId('account-cancel').click(); await until('closed', async () => !(await has('add-account')))
  })
} finally {
  const failed = results.filter((r) => !r.ok)
  writeFileSync(`${EVIDENCE}/verify-${tag}.json`, JSON.stringify({ results, openLog: openLog() }, null, 2))
  console.log(`\n${results.length - failed.length}/${results.length} passed (${tag})`)
  await f.close().catch(() => {})
  client.close(); daemon.kill()
  if (failed.length) process.exitCode = 1
}
