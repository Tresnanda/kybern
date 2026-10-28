import { ensureSshTunnel, stopSshTunnel, bootstrapSsh, runSsh, type BootstrapInput, type BootstrapProgress, type SavedSsh } from './ssh.ts'
import { KybernClient, type Endpoint } from '../../../../packages/kybern-client/src/client.ts'
import { httpBase, normalizeDaemonUrl, parsePairingInvitation } from '../../../../packages/kybern-client/src/address.ts'
import { machineHub } from '../machines/index.ts'
import { desktopVersion } from '../shell/daemon.ts'

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

/** A machine added by address, pairing code, invitation or SSH setup: where it lives and what the machine set calls it. */
export interface SavedMachine { machineId: string; name: string }

/**
 * Add a machine to this device's list (design §5.2): it joins the machine set, which connects it and merges its
 * threads into the sidebar. The device token is kept under `machine:<id>` before any socket opens, so a pairing code that
 * was used once is never lost to a network failure.
 */
export async function saveMachine(input: { id?: string; name: string; address: string; code?: string; token?: string; ssh?: SavedSsh; expectedIdentity?: string }): Promise<SavedMachine> {
  const name = input.name.trim()
  if (!name || name.length > 80) throw Error('Enter a machine name of 1–80 characters')
  const invitation = parsePairingInvitation(input.address)
  const url = normalizeDaemonUrl(invitation?.url ?? input.address)
  const code = (invitation?.code ?? input.code ?? '').trim()
  let token = input.token?.trim() ?? ''
  let expected = invitation?.environmentId ?? input.expectedIdentity ?? undefined
  if (code && token) throw Error('Use a pairing code or a device token, not both')
  if (code && !/^\d{6}$/.test(code)) throw Error('Enter the six-digit pairing code')
  const hub = machineHub()
  const duplicate = (id: string | undefined) => !!id && !!hub.set.connection(id)
  if (duplicate(expected)) throw Error('This machine is already in your list.')
  if (code) {
    const response = await fetch(`${httpBase(url)}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, device_name: `Kybern desktop · ${name}` }), redirect: 'error', signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw Error(`Pairing failed (${response.status}). Create a new invitation on that machine.`)
    const result = await response.json() as { token: string; environment_id: string }
    if (!result.token || !result.environment_id) throw Error('The pairing response was incomplete. Create a new invitation.')
    if (expected && expected !== result.environment_id) throw Error('This invitation belongs to a different machine. Add it separately.')
    token = result.token; expected = result.environment_id
    if (duplicate(expected)) throw Error('This machine is already in your list.')
  }
  if (!token) throw Error('Enter a pairing code from the other machine')
  // A token given without a code is checked first: the machine's own id is what the list is keyed by.
  if (!expected) {
    const info = await verifyEndpoint({ url, token })
    expected = info.machine_id || info.environment_id
    if (duplicate(expected)) throw Error('This machine is already in your list.')
  }
  const route = input.ssh ? { kind: 'ssh' as const, url: `http://127.0.0.1:${input.ssh.local_port}` } : { kind: 'direct_advertised' as const, url: httpBase(url) }
  // The profile id names the SSH tunnel and a saved token of the old kind; an SSH machine keeps one so its tunnel can be reopened.
  const legacyProfileId = input.ssh ? (input.id ?? crypto.randomUUID()) : undefined
  // `member: false`: a daemon added by hand is not in the network (design §4.3); the network offers to add it from Settings → Machines.
  await hub.set.addMachine({ machineId: expected, name, routes: [route], member: false, ...(legacyProfileId ? { legacyProfileId } : {}), ...(input.ssh ? { ssh: input.ssh } : {}) } as Parameters<typeof hub.set.addMachine>[0], token)
  return { machineId: expected, name }
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
  const version = desktopVersion()
  return bootstrapSsh(input, report, {
    version, signal, run: plan => runSsh(plan, signal), tunnel: ensureSshTunnel, stop: stopSshTunnel,
    info: (port, token) => verifyEndpoint({ url: `ws://127.0.0.1:${port}/ws`, token }),
    shutdown: (port, token) => withClient(port, token, client => client.call('daemon.shutdown', {})).then(() => {}),
    pair: async (port, token, next, ssh, identity) => {
      const invitation = await withClient(port, token, client => client.call('access.pairing.create', { label: `Kybern desktop · ${next.name}` }))
      return saveMachine({ id: next.id, name: next.name, address: `ws://127.0.0.1:${port}/ws`, code: invitation.code, expectedIdentity: identity, ssh })
    },
  })
}
