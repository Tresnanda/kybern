/**
 * settings9: the environment flows against two real scratch daemons (A 4294 = this window, B 4295).
 * Add by pairing invitation, address validation, switch, manage (edit, forget), pair a device with
 * Revoke, per-environment storage, and the "Open in a new window" request. Asserts the daemons' state.
 *
 *   bun src/environments/verify9.ts [dark|light]      (KYBERN_REDUCED_MOTION=1 for the reduced-motion pass)
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { CLIENT, CREDS, DATA_A, DATA_B, PORT_A, PORT_B, cli, mode, pairingInvitation, reset, start, wait } from './verify9.lib.ts'

const registry = () => JSON.parse(readFileSync(path.join(CLIENT, 'environments.json'), 'utf8')) as { selected_id: string; environments: { id: string; name: string; url?: string; environment_id?: string }[] }
const tokenList = (data: string) => (JSON.parse(cli(data, 'call', 'access.tokens.list', '{}')) as { tokens: { id: string; label: string; revoked: boolean }[] }).tokens
const assert = (ok: unknown, message: string) => { if (!ok) throw Error(`FAIL: ${message}`); console.log(`ok  ${message}`) }

// Earlier runs leave scratch devices behind; revoke them so the device list stays short.
for (const [data, prefix] of [[DATA_A, 'Scratch phone'], [DATA_B, 'Kybern desktop']] as const) for (const t of tokenList(data)) if (!t.revoked && t.label.startsWith(prefix)) cli(data, 'call', 'access.tokens.revoke', JSON.stringify({ token_id: t.id }))
reset()
const { app, until, click, present, text, shot } = await start()
const painted = async () => (await app.getByTestId('environment-dialog').count()) ? 'dialog' : ''
const closeDialog = async () => { await click('dialog-close'); await until('dialog closed', async () => !(await present('environment-dialog'))) }
try {
  await wait(1200)
  await shot('v-01-start')
  // --- Add by pairing invitation (address tab) -------------------------------------------------
  await click('environment-switcher'); await shot('v-02-menu-single')
  await click('environment-add'); await app.getByTestId('environment-machine').waitFor()
  await shot('v-03-add-ssh')
  await click('environment-tab-address'); await app.getByTestId('environment-address').waitFor()
  await app.getByTestId('environment-name').fill('Second machine')
  await app.getByTestId('environment-address').fill('not a url')
  await app.getByTestId('environment-code').fill('123456')
  await click('environment-save')           // blur is not delivered to a background window: submit validates the same way
  await until('invalid address error', () => present('environment-address-error'), 5000)
  await shot('v-04-address-invalid')
  assert(await text('Enter a machine address, such as https://machine.example.ts.net.'), 'invalid address shows the desktop error')
  assert(!existsSync(path.join(CLIENT, 'environments.json')), 'an invalid address saved nothing')
  const invitation = pairingInvitation()
  const before = tokenList(DATA_B).length
  await app.getByTestId('environment-address').fill(invitation)
  await shot('v-05-address-invitation')
  await click('environment-save')
  await until('connected to B', () => text('proj9b'), 30000)
  await shot('v-06-connected-b')
  const saved = registry()
  assert(saved.selected_id === saved.environments[0]?.id && saved.environments[0]?.url === `ws://127.0.0.1:${PORT_B}/ws`, 'registry has B and selects it')
  assert(tokenList(DATA_B).length === before + 1 && tokenList(DATA_B).some(t => t.label.includes('Second machine') && !t.revoked), 'daemon B recorded a new paired device for this app')
  const bId = saved.environments[0]!.id
  // --- Switch back and forth, with the environment menu showing both --------------------------
  await click('environment-switcher'); await until('menu rows', () => present(`environment-choice-${bId}`)); await shot('v-07-menu-two')
  await click('environment-choice-local'); await until('back on A', () => text('proj9a'), 30000)
  assert(await text('proj9a') && !(await text('proj9b')), 'switching back shows only A projects')
  await click('environment-switcher'); await click(`environment-choice-${bId}`); await until('on B again', () => text('proj9b'), 30000)
  assert(!(await text('proj9a')), 'B shows none of A')
  // --- Manage: edit and forget -----------------------------------------------------------------
  await click('environment-switcher'); await click('environment-manage'); await app.getByTestId('environment-manage-list').waitFor()
  await shot('v-08-manage')
  await click(`environment-edit-${bId}`); await app.getByTestId('environment-address').waitFor()
  await shot('v-09-edit')
  await app.getByTestId('environment-name').fill('Studio B')
  await click('environment-save')
  await until('edited name shown', async () => registry().environments[0]?.name === 'Studio B', 20000)
  assert(registry().environments[0]?.name === 'Studio B' && registry().environments[0]?.id === bId, 'edit renamed the saved environment and kept its identity')
  // --- Open in a new window: the menu button starts a second process pinned to that environment ---
  const windows = () => { try { return execFileSync('pgrep', ['-f', 'src/main.tsx'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean) } catch { return [] as string[] } }
  const running = new Set(windows())
  await click('environment-switcher'); await click(`environment-window-${bId}`)
  await until('a second window process', async () => windows().some(pid => !running.has(pid)), 20000)
  const spawned = windows().filter(pid => !running.has(pid))
  const env = execFileSync('ps', ['eww', '-p', spawned.join(',')], { encoding: 'utf8' })
  assert(env.includes(`KYBERN_GPUIX_ENVIRONMENT=${bId}`), 'Open in a new window started a process pinned to that environment')
  for (const pid of spawned) { try { process.kill(Number(pid), 'SIGTERM') } catch { /* already gone */ } }
  // --- Pair a device: a device paired by invitation has no access_write scope, like the desktop ----
  await until('B reconnected after the edit', () => text('proj9b'), 30000); await wait(800)
  await click('environment-switcher'); await click('environment-pair'); await wait(600)
  assert(!(await present('pairing-create')), 'Pair a device stays disabled on an environment this device only holds a device token for')
  // The disabled row leaves the menu open; clicking the trigger again would close it, like the desktop.
  if (!(await present('environment-choice-local'))) await click('environment-switcher')
  await click('environment-choice-local'); await until('back on A', () => text('proj9a'), 30000); await wait(800)
  // A real paired device on daemon A, to list and revoke.
  const phoneName = `Scratch phone ${Date.now() % 100000}`
  const code = (JSON.parse(cli(DATA_A, '--json', 'pair')) as { code: string }).code
  const paired = await fetch(`http://127.0.0.1:${PORT_A}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, device_name: phoneName }) })
  assert(paired.ok, 'a scratch phone paired with daemon A over /pair')
  await click('environment-switcher'); await click('environment-pair'); await app.getByTestId('pairing-create').waitFor()
  await until('invitation created', async () => { if (await present('pairing-address')) return true; await app.getByTestId('pairing-create').click().catch(() => {}); await wait(500); return false }, 20000)
  const exposure = () => JSON.parse(cli(DATA_A, 'call', 'access.exposure.get', '{}')) as { tailscale: boolean; tailscale_ip: string | null }
  assert(!exposure().tailscale, 'the scratch daemon starts without a Tailscale listener')
  await click('environment-tailscale')
  await until('Tailscale listener on', async () => exposure().tailscale, 15000)
  await until('invitation follows the Tailscale address', () => text(exposure().tailscale_ip!), 15000)
  await shot('v-09b-tailscale-on')
  assert(exposure().tailscale && await text(`Devices on your tailnet connect to ${exposure().tailscale_ip} directly.`), 'the Tailscale switch turned the listener on and the invitation uses the tailnet address')
  await click('environment-tailscale')
  await until('Tailscale listener off', async () => !exposure().tailscale, 15000)
  assert(!exposure().tailscale, 'the Tailscale switch turned the listener off again')
  await app.getByTestId('pairing-address').fill('https://studio.tailnet.ts.net')
  await app.getByTestId('pairing-qr').waitFor({ timeoutMs: 15000 })
  const phone = () => tokenList(DATA_A).find(t => t.label === phoneName)!
  await until('paired device listed', () => text(phoneName), 10000)
  await shot('v-10-pair-invitation')
  // The device list is below the fold (earlier runs left revoked rows above the new one): scroll the dialog
  // body to its end like a user, where the newest device sits.
  const target = `revoke-${phone().id}`
  for (let step = 0; step < 12; step++) await app.getByTestId('environment-access-body').wheel(0, -900)
  await wait(400)
  await shot('v-10b-pair-scrolled')
  await app.getByTestId(target).click()
  await until('revoked in daemon', async () => phone().revoked, 10000)
  await until('Revoked label', () => text('Revoked'), 5000)
  assert(phone().revoked, 'Revoke access revoked the device token on daemon A')
  await shot('v-11-pair-revoked')
  await closeDialog()
  // --- Forget -----------------------------------------------------------------------------------
  await click('environment-switcher'); await click(`environment-choice-${bId}`); await until('on B to forget it', () => text('proj9b'), 30000)
  await click('environment-switcher'); await click('environment-manage'); await click(`environment-forget-${bId}`)
  await until('back on A after forgetting the active environment', () => text('proj9a'), 30000)
  assert(registry().environments.length === 0 && registry().selected_id === 'local', 'forget removed B and fell back to the local environment')
  assert(!existsSync(path.join(CREDS, `${encodeURIComponent(bId)}.token`)), 'forget removed the stored credential')
  await shot('v-12-after-forget')
  console.log(`PASS environment flows (${mode}${process.env.KYBERN_REDUCED_MOTION === '1' ? ', reduced motion' : ''}); data dirs ${DATA_A}`)
} catch (e) { await shot('v-failure'); throw e } finally { await app.close() }
void painted
