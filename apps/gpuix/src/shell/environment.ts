import { ensureSshTunnel, stopSshTunnels } from '../environments/ssh.ts'
// Connection lifetime and singleton-store reset boundary. Reset callbacks run
// before the new socket opens. React remounts once, keyed by revision, so effects
// and local forms cannot carry data from one machine into another.
import { useSyncExternalStore } from 'react'
import type { Endpoint } from '../../../../packages/kybern-client/src/client.ts'
import { localDataDir, localProfile, profileById, profileEndpoint, readRegistry } from '../environments/registry.ts'
import { createLocalDaemonResolver } from './daemon.ts'

const resolveLocalDaemon = createLocalDaemonResolver({ root: localDataDir, port: process.env.KYBERN_PORT })

export interface Environment { id: string; name: string; local: boolean; endpoint: Endpoint | null; dataDir: string; revision: number }
function initial(): Environment {
  let profile = localProfile
  try {
    const id = process.env.KYBERN_GPUIX_ENVIRONMENT ?? (process.env.KYBERN_DATA_DIR || process.env.KYBERN_URL ? 'local' : readRegistry().selected_id)
    profile = profileById(id)
  } catch { /* The connection surface reports missing credentials or addresses. */ }
  return { id: profile.id, name: profile.name, local: profile.local, endpoint: null, dataDir: localDataDir, revision: 0 }
}
let active = initial()
const listeners = new Set<() => void>()
const leaving = new Set<() => void>()
const resets = new Set<{ reset: (previous: Environment, next: Environment) => void; priority: number }>()
let connection: { close: () => void; connect: () => void } | undefined
export const activeEnvironment = () => active
export const environmentKey = () => active.id === 'local' ? process.env.KYBERN_URL || active.dataDir : active.id
export const environmentEndpoint = () => {
  const profile = profileById(active.id)
  if (profile.id === 'local' && !process.env.KYBERN_URL) return resolveLocalDaemon()
  if (profile.ssh) return ensureSshTunnel(profile.id, profile.ssh).then(port => {
    profile.url = `ws://127.0.0.1:${port}/ws`
    return profileEndpoint(profile)
  })
  // Local/direct connections must be ready before immediate thread selection.
  return profileEndpoint(profile)
}
export function useEnvironment() { return useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn) } }, activeEnvironment) }
export function onEnvironmentChange(reset: (previous: Environment, next: Environment) => void, priority = 0) {
  const entry = { reset, priority }; resets.add(entry); return () => { resets.delete(entry) }
}
export function onEnvironmentLeaving(save: () => void) { leaving.add(save); return () => { leaving.delete(save) } }
export function registerEnvironmentConnection(lifecycle: NonNullable<typeof connection>) { connection = lifecycle }
export function switchEnvironment(next: Omit<Environment, 'revision'>) {
  const previous = active
  for (const save of leaving) save()
  connection?.close()
  stopSshTunnels(next.id)
  active = { ...next, revision: previous.revision + 1 }
  for (const entry of [...resets].sort((a, b) => a.priority - b.priority)) entry.reset(previous, active)
  connection?.connect()
  for (const listener of listeners) listener()
}
