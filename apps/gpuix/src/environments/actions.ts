import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { KybernClient, type Endpoint } from '../../../../packages/kybern-client/src/client.ts'
import { httpBase, normalizeDaemonUrl, parsePairingInvitation } from '../../../../packages/kybern-client/src/address.ts'
import { activeEnvironment, switchEnvironment } from '../shell/environment.ts'
import { readCredential, writeCredential, removeCredential } from './credentials.ts'
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

export function connectEnvironment(id: string) {
  const profile = profileById(id)
  const endpoint = profileEndpoint(profile)
  const registry = readRegistry()
  writeRegistry({ ...registry, selected_id: id })
  switchEnvironment({ id, name: profile.name, local: profile.local, endpoint, dataDir: localDataDir })
}

export async function saveEnvironment(input: { id?: string; name: string; address: string; code?: string; token?: string }) {
  const name = input.name.trim()
  if (!name || name.length > 80) throw Error('Enter an environment name of 1–80 characters')
  const registry = readRegistry()
  const existing = registry.environments.find((p) => p.id === input.id)
  const invitation = parsePairingInvitation(input.address)
  const url = normalizeDaemonUrl(invitation?.url ?? input.address)
  const code = (invitation?.code ?? input.code ?? '').trim()
  let token = input.token?.trim() ?? ''
  let expected = invitation?.environmentId ?? existing?.environment_id ?? undefined
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
  const profile: EnvironmentProfile = { id, name, url, environment_id: expected, local: false }
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
  removeCredential(id)
  try { writeRegistry({ selected_id: registry.selected_id === id ? 'local' : registry.selected_id, environments: registry.environments.filter((p) => p.id !== id) }) }
  catch (e) { if (previous) writeCredential(id, previous); throw e }
  if (activeEnvironment().id === id) connectEnvironment('local')
}

/** GPUIX 0.10.0 has one native window per renderer/process. */
export function openEnvironmentWindow(id: string) {
  profileById(id)
  const child = spawn(process.execPath, [fileURLToPath(new URL('../main.tsx', import.meta.url))], { detached: true, stdio: 'ignore', env: { ...process.env, KYBERN_GPUIX_ENVIRONMENT: id, KYBERN_GPUIX_THREAD: '' } })
  child.on('error', () => {})
  child.unref()
  return child.pid
}
