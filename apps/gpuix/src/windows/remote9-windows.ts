/**
 * remote9: "Open in a new window" — one window per environment, credentials from the Keychain.
 * Main window on A (this Mac); environment B (scratch daemon 4306) saved by invitation with its token in the real
 * Keychain under the scratch service. Asserts processes, window claims, titles, daemon connections and focus requests.
 *
 *   bun src/windows/remote9-windows.ts [dark|light]
 */
import { CLIENT, DATA_A, DATA_B, KEYCHAIN, OUT, PORT_A, PORT_B, SSH_ENV, cli, ensureProject, keychainHas, resetClient, startDaemon, until, wait } from '../environments/remote9.lib.ts'
import { mode, start, toHome } from '../environments/verify9.lib.ts'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const assert = (ok: unknown, message: string) => { if (!ok) throw Error(`FAIL: ${message}`); console.log(`ok  ${message}`) }
await startDaemon(DATA_A, PORT_A); await startDaemon(DATA_B, PORT_B)
ensureProject(DATA_A, 'remote9-local'); ensureProject(DATA_B, 'remote9-over-ssh')
resetClient()
// This process saves B like the app does, into the same scratch registry and Keychain service.
Object.assign(process.env, { KYBERN_GPUIX_KEYCHAIN_SERVICE: KEYCHAIN, KYBERN_GPUIX_CREDENTIALS_DIR: '' })
const { saveEnvironment } = await import('../environments/actions.ts')
const { askWindow, windowClaims } = await import('./registry.ts')
const invitation = (JSON.parse(cli(DATA_B, '--json', 'pair', '--address', `http://127.0.0.1:${PORT_B}`)) as { addresses: { invitation: string }[] }).addresses[0]!.invitation
const b = await saveEnvironment({ name: 'Second machine', address: invitation })
assert(keychainHas(b.id) && !readFileSync(path.join(CLIENT, 'environments.json'), 'utf8').includes('token'), 'B is saved with its device token in the Keychain, not in environments.json')

const connections = (data: string) => Number(/connections\s+(\d+)/.exec(cli(data, 'activity'))?.[1] ?? 0)
const windows = (...pids: number[]) => execFileSync('xcrun', ['swift', path.join(import.meta.dir, 'window-info.swift'), ...pids.map(String)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { pid: number; id: number; title: string })
const spawned = new Set<number>()
const h = await start(SSH_ENV)
const menuPick = async (id: string, done: () => Promise<boolean>) => {
  await toHome(h)
  for (let attempt = 0; attempt < 5; attempt++) {
    if (!(await h.present(id))) await h.click('environment-switcher')
    await h.until(`menu row ${id}`, () => h.present(id)); await wait(250)
    await h.click(id)
    try { await until(`after ${id}`, done, 6000); return } catch { /* retry */ }
  }
  throw Error(`Could not pick ${id}`)
}
const claimFor = (id: string) => windowClaims().filter(claim => claim.environment === id)
try {
  await until('main window claimed', () => claimFor('local').length === 1, 15000)
  const main = claimFor('local')[0]!.pid
  await until('main window title', () => windows(main).some(w => w.title === 'This Mac — Kybern'), 15000)
  assert(true, 'the main window is titled "This Mac — Kybern" (desktop selectEnvironment)')
  const before = connections(DATA_B)

  // --- Open B in a new window -----------------------------------------------------------------------------------
  await menuPick(`environment-window-${b.id}`, async () => claimFor(b.id).length > 0)
  await until('B window up', () => claimFor(b.id).some(claim => !claim.pending), 60000)
  const child = claimFor(b.id)[0]!.pid; spawned.add(child)
  assert(execFileSync('ps', ['eww', '-p', String(child)], { encoding: 'utf8' }).includes(`KYBERN_GPUIX_ENVIRONMENT=${b.id}`), 'Open in a new window started a window process pinned to B')
  await until('B window connected', () => connections(DATA_B) > before, 30000)
  assert(true, `the new window connected to B with the credential it read from the Keychain (B connections ${before} → ${connections(DATA_B)})`)
  await until('B window title', () => windows(child).some(w => w.title === 'Second machine — Kybern'), 15000)
  const childWindow = windows(child).find(w => w.title === 'Second machine — Kybern')!
  assert(childWindow, 'its window is titled "Second machine — Kybern"')
  await wait(2500)
  execFileSync('screencapture', ['-l', String(childWindow.id), '-x', '-o', path.join(OUT, `r9-w-01-second-window-${mode}.png`)])

  // --- Again: focus that window, no second process ------------------------------------------------------------
  const processesBefore = windowClaims().length
  await menuPick(`environment-window-${b.id}`, async () => ((await askWindow(claimFor(b.id)[0]!, { type: 'ping' }))?.focused ?? 0) >= 1)
  await wait(1500)
  assert(windowClaims().length === processesBefore && claimFor(b.id).length === 1 && claimFor(b.id)[0]!.pid === child, 'choosing it again focused the existing B window instead of opening another')
  const front = windows(main, child)
  console.log(`    window order front→back: ${front.map(w => w.title).join(' | ')}`)

  // --- The current environment's own row focuses this window --------------------------------------------------
  await menuPick('environment-window-local', async () => !(await h.present('environment-window-local')))
  await wait(1000)
  assert(windowClaims().length === processesBefore, '"Open This Mac in a new window" from the window that shows it opens nothing new')

  // --- Closing the B window frees the environment; the next request opens a fresh one ----------------------------
  process.kill(child, 'SIGTERM'); await until('B window gone', () => claimFor(b.id).length === 0, 15000)
  await menuPick(`environment-window-${b.id}`, async () => claimFor(b.id).length > 0)
  await until('new B window up', () => claimFor(b.id).some(claim => !claim.pending && claim.pid !== child), 60000)
  const reopened = claimFor(b.id)[0]!.pid; spawned.add(reopened)
  assert(reopened !== child, 'after its window closed, the next request opened a new B window')
  console.log(`PASS remote9 windows (${mode})`)
} catch (e) { await h.shot('r9-w-failure'); throw e } finally {
  for (const pid of spawned) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
  await h.app.close()
}
