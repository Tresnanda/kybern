import { ensureSshTunnel, stopSshTunnel, stopSshTunnels, bootstrapSsh, runSsh, type BootstrapInput, type BootstrapProgress, type SavedSsh } from './ssh.ts'
import { openWindowFor } from '../windows/registry.ts'
import { KybernClient, type Endpoint } from '../../../../packages/kybern-client/src/client.ts'
import { httpBase, normalizeDaemonUrl, parsePairingInvitation } from '../../../../packages/kybern-client/src/address.ts'
import { activeEnvironment, switchEnvironment } from '../shell/environment.ts'
import { readCredential, writeCredential, removeCredential } from './credentials.ts'
import { rmSync } from 'node:fs'
import { prefsFileFor } from '../nav/live.ts'
import { savedEnvironmentStateFile } from '../shell/persist.ts'
import { localDataDir, profileById, profileEndpoint, readRegistry, writeRegistry, type EnvironmentProfile } from './registry.ts'

/** Verify protocol and environment identity with the same transport as the workspace. */
export async function verifyEndpoint(endpoint: Endpoint) {
  const client = new KybernClient(endpoint, { requestTimeoutMs: 15000, createSocket: (url, token) => new WebSocket(url, { headers: { origin: 'tauri://localhost', Authorization: `Bearer ${token}` } } as unknown as string[]) })
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { stop(); reject(Error('Unable to reach this machine. Check its address and network, then reconnect.')) }, 15000)
      const stop = client.onStatus((status, detail) => {
        if (status === 'open') { clearTimeout(timeout); stop(); resolve() }
        else if (status === 'failed') { clearTimeout(timeout); stop(); reject(Error(detail ?? 'Connection failed')) }
      })
      client.connect()
    })
    return client.info!
  } finally { client.close() }
}

let selectionAttempt = 0
export async function connectEnvironment(id: string) {
  const attempt = ++selectionAttempt
  const profile = profileById(id)
  if (profile.ssh) {
    let port: number
    try { port = await ensureSshTunnel(id, profile.ssh) } catch (error) { if (attempt !== selectionAttempt) return; throw error }
    if (attempt !== selectionAttempt) return
    profile.url = `ws://127.0.0.1:${port}/ws`
    profile.ssh.local_port = port
  }
  const endpoint = profile.id === 'local' && !process.env.KYBERN_URL ? null : profileEndpoint(profile)
  const registry = readRegistry()
  writeRegistry({ ...registry, selected_id: id, environments: registry.environments.map(saved => saved.id === profile.id ? profile : saved) })
  stopSshTunnels(id)
  switchEnvironment({ id, name: profile.name, local: profile.local, endpoint, dataDir: localDataDir })
}

export async function saveEnvironment(input: { id?: string; name: string; address: string; code?: string; token?: string; ssh?: SavedSsh; expectedIdentity?: string }) {
  const name = input.name.trim()
  if (!name || name.length > 80) throw Error('Enter an environment name of 1–80 characters')
  const registry = readRegistry()
  const existing = registry.environments.find((p) => p.id === input.id)
  const invitation = parsePairingInvitation(input.address)
  const url = normalizeDaemonUrl(invitation?.url ?? input.address)
  const code = (invitation?.code ?? input.code ?? '').trim()
  let token = input.token?.trim() ?? ''
  let expected = invitation?.environmentId ?? input.expectedIdentity ?? existing?.environment_id ?? undefined
  const id = input.id ?? crypto.randomUUID()
  if (id === 'local') throw Error('The local environment is managed by Kybern')
  if (code && token) throw Error('Use a pairing code or a device token, not both')
  if (code && !/^\d{6}$/.test(code)) throw Error('Enter the six-digit pairing code')
  if (expected && registry.environments.some((p) => p.id !== id && p.environment_id === expected)) throw Error('This environment is already saved. Select it from the environment menu.')
  let paired = false
  if (code) {
    const response = await fetch(`${httpBase(url)}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, device_name: `Kybern desktop · ${name}` }), redirect: 'error', signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw Error(`Pairing failed (${response.status}). Create a new invitation on that machine.`)
    const result = await response.json() as { token: string; environment_id: string }
    if (!result.token || !result.environment_id) throw Error('The pairing response was incomplete. Create a new invitation.')
    if (expected && expected !== result.environment_id) throw Error('This invitation belongs to a different environment. Add it separately.')
    token = result.token; expected = result.environment_id; paired = true
  }
  if (!token && existing) token = readCredential(existing.id)
  if (!token) throw Error('Enter a pairing code from the other machine')
  if (expected && registry.environments.some((p) => p.id !== id && p.environment_id === expected)) throw Error('This environment is already saved. Select it from the environment menu.')
  const profile: EnvironmentProfile = { id, name, url, environment_id: expected, local: false, ssh: input.ssh ?? existing?.ssh }
  const persist = (next: EnvironmentProfile) => {
    const latest = readRegistry()
    writeCredential(id, token)
    writeRegistry({ ...latest, environments: [...latest.environments.filter((p) => p.id !== id), next] })
  }
  // The pairing code is single use. Keep its credential before opening a socket
  // so a network failure still leaves a recoverable saved connection.
  if (paired) persist(profile)
  try {
    const info = await verifyEndpoint({ url, token, environmentId: expected })
    if (registry.environments.some((p) => p.id !== id && p.environment_id === info.environment_id)) throw Error('This environment is already saved. Select it from the environment menu.')
    profile.environment_id = info.environment_id; profile.hostname = info.hostname
    persist(profile)
  } catch (e) {
    if (paired) throw Error(`Paired and saved. Reconnect from the environment menu when the machine is reachable. ${e instanceof Error ? e.message : String(e)}`)
    throw e
  }
  return profile
}

export function forgetEnvironment(id: string) {
  if (id === 'local') throw Error('The local environment cannot be removed')
  const registry = readRegistry()
  const previous = (() => { try { return readCredential(id) } catch { return null } })()
  stopSshTunnel(id)
  removeCredential(id)
  try { writeRegistry({ selected_id: registry.selected_id === id ? 'local' : registry.selected_id, environments: registry.environments.filter((p) => p.id !== id) }) }
  catch (e) { if (previous) writeCredential(id, previous); throw e }
  // The desktop drops the environment's stored workspace with it (`forgetEnvironmentStore`).
  if (activeEnvironment().id !== id) for (const file of [savedEnvironmentStateFile(localDataDir, id), prefsFileFor(id)]) rmSync(file, { force: true })
  if (activeEnvironment().id === id) { const files = [savedEnvironmentStateFile(localDataDir, id), prefsFileFor(id)]; connectEnvironment('local'); for (const file of files) rmSync(file, { force: true }) }
}

/**
 * "Open in a new window": focus the window that already shows this environment, or open one
 * (`windows/registry.ts` explains why each window is its own process). Errors become a toast like the desktop's.
 */
export async function openEnvironmentWindow(id: string) {
  try {
    profileById(id)
    return await openWindowFor(id)
  } catch (error) {
    const { toast } = await import('../shell/toasts.tsx')
    toast.error(error instanceof Error ? error.message : String(error))
    return null
  }
}

/** Native-independent SSH lifecycle; the same endpoint/pairing checks as address connections. */
export async function setupSshEnvironment(input: BootstrapInput, report: (progress: BootstrapProgress) => void, signal?: AbortSignal) {
  const withClient = async <T>(port: number, token: string, action: (client: KybernClient) => Promise<T>) => {
    const client = new KybernClient({ url: `ws://127.0.0.1:${port}/ws`, token }, { requestTimeoutMs: 10000, createSocket: (url, token) => new WebSocket(url, { headers: { origin: 'tauri://localhost', Authorization: `Bearer ${token}` } } as never) })
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('The daemon did not answer through the tunnel.')), 10000)
        client.onStatus((status, detail) => { if (status === 'open') { clearTimeout(timer); resolve() } else if (status === 'failed') { clearTimeout(timer); reject(Error(detail ?? 'Unable to connect through the tunnel.')) } })
        client.connect()
      })
      return await action(client)
    } finally { client.close() }
  }
  const version = (await import('../../../desktop/src-tauri/tauri.conf.json')).default.version
  return bootstrapSsh(input, report, {
    version, signal, run: plan => runSsh(plan, signal), tunnel: ensureSshTunnel, stop: stopSshTunnel,
    info: (port, token) => verifyEndpoint({ url: `ws://127.0.0.1:${port}/ws`, token }),
    shutdown: (port, token) => withClient(port, token, client => client.call('daemon.shutdown', {})).then(() => {}),
    pair: async (port, token, next, ssh, identity) => {
      const invitation = await withClient(port, token, client => client.call('access.pairing.create', { label: `Kybern desktop · ${next.name}` }))
      return saveEnvironment({ id: next.id, name: next.name, address: `ws://127.0.0.1:${port}/ws`, code: invitation.code, expectedIdentity: identity, ssh })
    },
  })
}
