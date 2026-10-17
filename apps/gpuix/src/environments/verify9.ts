/**
 * settings9: the environment flows against two real scratch daemons (A 4294 = this window, B 4295).
 * Add by pairing invitation, address validation, switch, manage (edit, forget), pair a device with
 * Revoke, per-environment storage, and the "Open in a new window" request. Asserts the daemons' state.
 *
 *   bun src/environments/verify9.ts [dark|light]      (KYBERN_REDUCED_MOTION=1 for the reduced-motion pass)
 */
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { CLIENT, DATA_A, DATA_B, cli, mode, pairingInvitation, reset, start, wait } from './verify9.lib.ts'

const registry = () => JSON.parse(readFileSync(path.join(CLIENT, 'environments.json'), 'utf8')) as { selected_id: string; environments: { id: string; name: string; url?: string; environment_id?: string }[] }
const tokenList = (data: string) => (JSON.parse(cli(data, 'call', 'access.tokens.list', '{}')) as { tokens: { id: string; label: string; revoked: boolean }[] }).tokens
const assert = (ok: unknown, message: string) => { if (!ok) throw Error(`FAIL: ${message}`); console.log(`ok  ${message}`) }

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
  assert(saved.selected_id === saved.environments[0]?.id && saved.environments[0]?.url === 'ws://127.0.0.1:4295/ws', 'registry has B and selects it')
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
  // --- Pair a device: a device paired by invitation has no access_write scope, like the desktop ----
  await until('B reconnected after the edit', () => text('proj9b'), 30000); await wait(800)
  await click('environment-switcher'); await click('environment-pair'); await wait(600)
  assert(!(await present('pairing-create')), 'Pair a device stays disabled on an environment this device only holds a device token for')
  await click('environment-switcher'); await wait(300); await click('environment-choice-local'); await until('back on A', () => text('proj9a'), 30000); await wait(800)
  // A real paired device on daemon A, to list and revoke.
  const code = (JSON.parse(cli(DATA_A, '--json', 'pair')) as { code: string }).code
  const paired = await fetch('http://127.0.0.1:4294/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, device_name: 'Scratch phone' }) })
  assert(paired.ok, 'a scratch phone paired with daemon A over /pair')
  await click('environment-switcher'); await click('environment-pair'); await click('pairing-create')
  await app.getByTestId('pairing-address').waitFor({ timeoutMs: 15000 })
  await app.getByTestId('pairing-address').fill('https://studio.tailnet.ts.net')
  await app.getByTestId('pairing-qr').waitFor({ timeoutMs: 15000 })
  const phone = () => tokenList(DATA_A).find(t => t.label === 'Scratch phone')!
  await until('paired device listed', () => text('Scratch phone'), 10000)
  await shot('v-10-pair-invitation')
  await click(`revoke-${phone().id}`)
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
  assert(!existsSync(path.join(process.env.KYBERN_GPUIX_CREDENTIALS_DIR ?? '/Users/mymac/projects/ade-gpuix-scratch/phase2-settings9-creds', `${encodeURIComponent(bId)}.token`)), 'forget removed the stored credential')
  await shot('v-12-after-forget')
  console.log(`PASS environment flows (${mode}${process.env.KYBERN_REDUCED_MOTION === '1' ? ', reduced motion' : ''}); data dirs ${DATA_A}`)
} catch (e) { await shot('v-failure'); throw e } finally { await app.close() }
void painted
