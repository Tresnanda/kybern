/**
 * remote9: connect to any environment, end to end in the real app — address + pairing code, pairing invitation and
 * SSH (host list, bootstrap, tunnel drop and reconnect, SSH down, permission and unreachable errors, starting a
 * stopped daemon). A = 4305 is this Mac; B = 4306 is reached as an address and over the scratch SSH target
 * (`remote9.lib.ts`). Credentials go to the real Keychain under the scratch service. Asserts daemon and registry state.
 *
 *   bun src/environments/remote9.ts [dark|light]        (KYBERN_REDUCED_MOTION=1 for reduced motion)
 */
import { DATA_A, DATA_B, PORT_A, PORT_B, SSH_DIR, SSH_ENV, cli, ensureProject, keychainHas, listening, registry, resetClient, startDaemon, startSshd, stopDaemon, stopMasters, stopSshd, tokens, tunnelPids, wait } from './remote9.lib.ts'
import { mode, start, toHome } from './verify9.lib.ts'
import { readFileSync } from 'node:fs'

const assert = (ok: unknown, message: string) => { if (!ok) throw Error(`FAIL: ${message}`); console.log(`ok  ${message}`) }
await startSshd(); await startDaemon(DATA_A, PORT_A); await startDaemon(DATA_B, PORT_B)
ensureProject(DATA_A, 'remote9-local'); ensureProject(DATA_B, 'remote9-over-ssh')
resetClient(); stopMasters()
const live = () => tokens(DATA_B).filter(token => !(token as { revoked?: boolean }).revoked)
const devicesBefore = live().length
const h = await start({ ...SSH_ENV, KYBERN_SSH: `${SSH_DIR}/ssh-slow` })
const fill = (id: string, value: string) => h.app.getByTestId(id).fill(value)
/** Pick a row of the environment menu; retried because a click during the menu's entrance can land before it takes input. */
const menuPick = async (id: string, done: () => Promise<boolean>) => {
  await toHome(h)
  for (let attempt = 0; attempt < 5; attempt++) {
    if (!(await h.present(id))) await h.click('environment-switcher')
    await h.until(`menu row ${id}`, () => h.present(id)); await wait(250)
    // A real pointer: move, dwell, click (menu rows take their hit boxes from hover, like `visual/screens/composer.gpuix.ts`).
    const row = h.app.getByTestId(id); await h.app.mouse.move(await row.center()); await wait(150); await h.app.mouse.click(await row.center())
    try { await h.until(`after ${id}`, done, 4000); return } catch { /* retry */ }
  }
  throw Error(`Could not pick ${id}`)
}
const openAdd = () => menuPick('environment-add', () => h.present('environment-machine'))
const closeDialog = async () => { await h.click('dialog-close'); await h.until('dialog closed', async () => !(await h.present('environment-dialog'))) }
const choose = async (id: string, marker: string) => { await menuPick(`environment-choice-${id}`, async () => !(await h.present(`environment-choice-${id}`))); await h.until(`on ${id}`, () => h.text(marker), 40000); await wait(500) }
const forget = async (id: string) => {
  await menuPick('environment-manage', () => h.present('environment-manage-list')); await h.click(`environment-forget-${id}`)
  if (await h.present('environment-forget-confirm')) await h.click('environment-forget-confirm')
  await h.until(`forgot ${id}`, async () => !registry().environments.some(p => p.id === id))
  if (await h.present('environment-dialog')) await closeDialog()
}
try {
  await wait(1200)
  // --- Address + pairing code ---------------------------------------------------------------------------------
  const code = (JSON.parse(cli(DATA_B, '--json', 'pair', '--address', `http://127.0.0.1:${PORT_B}`)) as { code: string }).code
  await openAdd(); await h.click('environment-tab-address')
  await fill('environment-name', 'Address B'); await fill('environment-address', `http://127.0.0.1:${PORT_B}`); await fill('environment-code', code)
  await h.click('environment-save'); await h.until('connected to B by address', () => h.text('remote9-over-ssh'), 30000)
  const byAddress = registry().environments.find(p => p.name === 'Address B')!
  assert(byAddress && !byAddress.ssh && keychainHas(byAddress.id), 'address + pairing code saved the environment with its credential in the Keychain')
  assert(!readFileSync(`${process.env.KYBERN_CLIENT_CONFIG_DIR}/environments.json`, 'utf8').includes('token'), 'environments.json holds no credential')
  await h.shot('r9-01-address-connected')
  await choose('local', 'remote9-local'); await choose(byAddress.id, 'remote9-over-ssh')
  assert(true, 'switching between this Mac and the address environment remounts each workspace')
  await choose('local', 'remote9-local'); await forget(byAddress.id)
  assert(!keychainHas(byAddress.id), 'forgetting removed its Keychain item')
  // --- Pairing invitation -------------------------------------------------------------------------------------
  const invitation = (JSON.parse(cli(DATA_B, '--json', 'pair', '--address', `http://127.0.0.1:${PORT_B}`)) as { addresses: { invitation: string }[] }).addresses[0]!.invitation
  await openAdd(); await h.click('environment-tab-address')
  await fill('environment-name', 'Invitation B'); await fill('environment-address', invitation)
  await h.click('environment-save'); await h.until('connected to B by invitation', () => h.text('remote9-over-ssh'), 30000)
  const byInvitation = registry().environments.find(p => p.name === 'Invitation B')!
  assert(byInvitation?.environment_id && keychainHas(byInvitation.id), 'a pairing invitation saved the environment with its identity and credential')
  await choose('local', 'remote9-local'); await forget(byInvitation.id)

  // --- SSH: host list from the SSH config (read only) ---------------------------------------------------------
  await openAdd()
  assert(await h.present('environment-tab-ssh'), 'Add environment opens on the Over SSH tab')
  await fill('environment-name', 'Remote over SSH'); await fill('environment-machine', 'kyb')
  await h.until('host suggestions', () => h.present('ssh-host-kybern-remote9'))
  assert(!(await h.text('*.wild')) && !(await h.present('ssh-host-remote9-alias')), 'suggestions list matching literal aliases only (no wildcard patterns)')
  await h.shot('r9-02-ssh-hosts')
  await h.click('ssh-host-kybern-remote9')
  await h.click('environment-save')
  // ssh-slow holds every SSH call for 2 s, so each step is on screen long enough to capture.
  await h.until('connect step running', () => h.present('environment-setup-progress'), 15000)
  await h.shot('r9-03-ssh-progress-connect')
  await h.until('start step reached', () => h.text('kybernd 0.9.1 is installed'), 30000)
  await h.shot('r9-04-ssh-progress-install-done')
  await h.until('connected over SSH', () => h.text('remote9-over-ssh'), 90000)
  const ssh = registry().environments.find(p => p.name === 'Remote over SSH')!
  assert(ssh?.ssh?.target === 'kybern-remote9' && ssh.ssh.remote_port === PORT_B && ssh.ssh.local_port > 0 && ssh.url === `ws://127.0.0.1:${ssh.ssh.local_port}/ws`, 'the SSH environment is saved with its tunnel (loopback address, remote port 4306)')
  assert(keychainHas(ssh.id), 'its device token is in the Keychain')
  assert(live().some(token => token.label === 'Kybern desktop · Remote over SSH'), 'the remote daemon paired this device ("Kybern desktop · Remote over SSH")')
  assert(tunnelPids().length === 1, 'one tunnel process (ControlMaster off for the forward)')
  await h.shot('r9-05-ssh-connected')

  // --- Tunnel drop: the keeper respawns ssh on the same local port and the workspace reconnects ----------------
  const [tunnel] = tunnelPids(); const dropped = Date.now()
  process.kill(tunnel!, 'SIGKILL')
  await h.until('new tunnel', async () => tunnelPids().length === 1 && tunnelPids()[0] !== tunnel, 30000)
  await h.until('reconnected', async () => !(await h.present('connection-banner')) && await h.text('remote9-over-ssh'), 40000)
  assert(await listening(ssh.ssh!.local_port), `the tunnel came back on the same local port ${ssh.ssh!.local_port} and the app reconnected in ${((Date.now() - dropped) / 1000).toFixed(1)} s`)

  // --- SSH down: the banner explains it, and the app reconnects once SSH is back ------------------------------
  await stopSshd(); stopMasters(); for (const pid of tunnelPids()) process.kill(pid, 'SIGKILL')
  await h.until('reconnecting banner', () => h.present('connection-banner'), 30000)
  await wait(400); await h.shot('r9-06-ssh-down-banner')
  await wait(3000); await startSshd(); const back = Date.now()
  await h.until('reconnected after SSH came back', async () => !(await h.present('connection-banner')) && await h.text('remote9-over-ssh'), 60000)
  assert(true, `after SSH came back the tunnel and workspace recovered in ${((Date.now() - back) / 1000).toFixed(1)} s (keeper backoff 1–30 s)`)

  // --- Errors with next steps -----------------------------------------------------------------------------------
  await openAdd(); await fill('environment-name', 'Wrong key'); await fill('environment-machine', 'remote9-wrongkey'); await h.click('environment-save')
  await h.until('permission error', () => h.present('environment-setup-error'), 60000)
  assert(await h.text('SSH could not sign in to remote9-wrongkey without a password') && await h.text('ssh-copy-id remote9-wrongkey'), 'a rejected key explains ssh-copy-id, with the command on its own line')
  await wait(300); await h.shot('r9-07-ssh-permission')
  await fill('environment-machine', 'remote9-closed'); await h.click('environment-save')
  await h.until('unreachable error', () => h.text('Unable to reach remote9-closed over SSH'), 60000)
  assert(await h.text('Check that the machine is on and its SSH port is open') && await h.present('environment-save'), 'a closed SSH port says what to check, and the form stays editable')
  await wait(300); await h.shot('r9-08-ssh-unreachable')
  await closeDialog()

  // --- A stopped remote daemon: "Set up again" starts it over SSH ----------------------------------------------
  await choose('local', 'remote9-local')
  await stopDaemon(DATA_B, PORT_B)
  await menuPick('environment-manage', () => h.present('environment-manage-list')); await h.click(`environment-edit-${ssh.id}`)
  await h.app.getByTestId('environment-machine').waitFor()
  await h.click('environment-save')
  await h.until('start step running', () => h.text('kybernd 0.9.1 is installed'), 30000)
  await h.shot('r9-09-ssh-start-daemon')
  await h.until('connected after starting the daemon', () => h.text('remote9-over-ssh'), 120000)
  const restarted = registry().environments.find(p => p.id === ssh.id)!
  assert(await listening(restarted.ssh!.remote_port), `the start step launched kybernd on the remote (port ${restarted.ssh!.remote_port}) and the environment reconnected`)
  // Put B back on its assigned port for the next check (the start step used the default 4173).
  await choose('local', 'remote9-local'); await startDaemon(DATA_B, PORT_B)
  console.log(`PASS remote9 connect-any + SSH (${mode}${process.env.KYBERN_REDUCED_MOTION === '1' ? ', reduced motion' : ''}); devices on B ${devicesBefore} → ${live().length}`)
} catch (e) { await h.shot('r9-failure'); throw e } finally { await h.app.close() }
