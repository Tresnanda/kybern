// Desktop-owned trusted access: credentials stay in the machine hub; SSH goes through its
// existing bootstrap/tunnel/pairing path. The daemon never receives shell credentials.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { useSyncExternalStore } from 'react'
import { configDir, profileById, profileEndpoint } from '../environments/registry.ts'
import { ensureSshTunnel, listSshHosts } from '../environments/ssh.ts'
import { setupSshEnvironment } from '../environments/actions.ts'
import { SavedEndpointUnavailable, withVerifiedEndpoint } from '../environments/savedEndpoint.ts'
import { writeAllowed } from '../shell/persist.ts'
import { parseSshTarget } from '../shell/platform.ts'
import { getClient } from '../state.ts'
import { machineHub } from './index.ts'
import type { GpuixMachineRecord } from './store.ts'
import { MachineSetup, enableUnconfigured, type SetupRow, type SetupTarget } from './setup.ts'

let setup: MachineSetup | undefined
const file = () => path.join(configDir(), 'machine-setup.json')
function savedRows(): SetupRow[] {
  try {
    const rows: unknown = JSON.parse(readFileSync(file(), 'utf8'))
    if (!Array.isArray(rows)) return []
    return rows.filter((row): row is SetupRow => !!row && typeof row.target?.id === 'string' && typeof row.target?.name === 'string' && typeof row.detail === 'string' && ['queued', 'checking', 'installing', 'starting', 'pairing', 'ready', 'off', 'install', 'error', 'access', 'canceled'].includes(row.phase)).slice(0, 64)
  } catch { return [] }
}
function save(rows: SetupRow[]) {
  if (!writeAllowed(file())) return
  try {
    mkdirSync(configDir(), { recursive: true, mode: 0o700 })
    const temp = `${file()}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(rows.slice(0, 64)), { mode: 0o600 })
    renameSync(temp, file())
  } catch { /* read-only config: results remain visible this session */ }
}
function sshAddress(ssh: NonNullable<GpuixMachineRecord['ssh']>) { return `${ssh.target}${ssh.port ? `:${ssh.port}` : ''}` }
async function discover(): Promise<SetupTarget[]> {
  const client = getClient()
  if (!client || client.status !== 'open') throw Error('Reconnect to this machine, then check again.')
  const status = await client.call('network.status', {})
  if (!status.enabled) return []
  const hub = machineHub()
  await hub.set.load()
  const records = hub.connections().map(connection => connection.record as GpuixMachineRecord)
  const targets: SetupTarget[] = records.filter(record => record.machineId !== status.self_machine.machine_id && !record.member).map(record => ({
    id: `paired:${record.machineId}`, name: record.name, os: record.os, access: 'paired', machineId: record.machineId,
    ...(record.ssh ? { target: sshAddress(record.ssh), dataDir: record.ssh.data_dir ?? undefined } : {}),
  }))
  // Fixture/background runs cannot even probe the user's own SSH aliases.
  const hosts = process.env.GPUIX_BACKGROUND === '1' && !process.env.KYBERN_SSH_CONFIG ? [] : await listSshHosts(process.env.KYBERN_SSH_CONFIG)
  const saved = new Set(records.flatMap(record => record.ssh ? [record.ssh.target] : []))
  for (const alias of hosts.slice(0, 64)) if (!saved.has(alias)) targets.push({ id: `ssh:${alias}`, name: alias, access: 'ssh', target: alias })
  const addresses = new Set(targets.map(target => target.target?.split('@').at(-1)?.toLowerCase()).filter(Boolean))
  for (const node of status.setup_candidates ?? []) {
    if (addresses.has(node.address.toLowerCase()) || addresses.has(node.name.toLowerCase())) continue
    targets.push({ id: `tailnet:${node.node_id}`, name: node.name, address: node.address, online: node.online, access: 'guidance' })
  }
  return targets.slice(0, 64)
}

export function machineSetup(): MachineSetup {
  return setup ??= new MachineSetup({ discover, save, connect: async (target, install, report, signal) => {
    signal.throwIfAborted()
    const local = getClient()
    if (!local || !(await local.call('network.status', {})).enabled) throw Error('The network is off here. Turn it on before retrying.')
    signal.throwIfAborted()
    if (target.access === 'paired' && target.machineId) {
      try {
        const client = machineHub().clientFor(target.machineId)
        const status = await enableUnconfigured(client, signal)
        return { enabled: status.enabled, machineId: target.machineId }
      } catch (error) {
        // An offline saved SSH machine may need its daemon started. Authentication/policy
        // errors on an open paired socket are never bypassed by bootstrap access.
        const connection = machineHub().set.connection(target.machineId)
        if (['online', 'relaying', 'needs-update'].includes(connection?.status ?? '')) throw error
        // Off machines do not serve the network identity endpoint. A previously paired
        // device can still use its authenticated /ws endpoint and pin the saved machine id.
        // Never substitute an address learned only from the tailnet for this saved route.
        try {
          const profile = profileById(target.machineId)
          if (profile.ssh) {
            const port = await ensureSshTunnel(profile.id, profile.ssh)
            profile.url = `ws://127.0.0.1:${port}/ws`
          }
          const endpoint = await profileEndpoint(profile)
          return await withVerifiedEndpoint(endpoint, async client => {
            const status = await enableUnconfigured(client, signal)
            return { enabled: status.enabled, machineId: client.info?.machine_id ?? target.machineId }
          }, signal)
        } catch (savedError) {
          // Bootstrap is for a stopped daemon over saved SSH, not a rejected identity/token.
          signal.throwIfAborted()
          if (!target.target || !(savedError instanceof SavedEndpointUnavailable)) throw savedError
        }
      }
    }
    if (!target.target || target.access === 'guidance') throw Error('Add a pairing invitation or a verified SSH connection first.')
    parseSshTarget(target.target)
    const saved = await setupSshEnvironment({
      id: `network-setup:${target.id}`, name: target.name.slice(0, 80), target: target.target, data_dir: target.dataDir,
      network_setup: install ? 'install' : 'connect', expectedIdentity: target.machineId?.startsWith('legacy:') ? undefined : target.machineId,
    }, progress => {
      if (progress.state === 'running') report(progress.detail === 'Checking daemon service' ? 'checking' : ({ connect: 'checking', install: 'installing', start: 'starting', pair: 'pairing' } as const)[progress.step])
    }, signal)
    signal.throwIfAborted()
    return { enabled: !!saved.networkEnabled, machineId: saved.machineId }
  } }, savedRows())
}
export const useMachineSetup = () => { const current = machineSetup(); return useSyncExternalStore(current.subscribe, current.get) }
export function startMachineSetup() { void machineSetup().start(true) }
export function cancelMachineSetup() { setup?.cancelAll() }
