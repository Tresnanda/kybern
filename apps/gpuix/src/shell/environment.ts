// The machine the user is at: this window's own daemon connection. There is one per window and it never changes
// while the app runs; other machines are not "environments" any more but members of the machine set (`machines/`).
// `KYBERN_GPUIX_ENVIRONMENT` still names a machine of `machines.json` to focus, for checks.
import { useSyncExternalStore } from 'react'
import type { Endpoint } from '../../../../packages/kybern-client/src/client.ts'
import { ensureSshTunnel } from '../environments/ssh.ts'
import { localDataDir, localProfile, profileById, profileEndpoint } from '../environments/registry.ts'
import { createLocalDaemonResolver } from './daemon.ts'

const resolveLocalDaemon = createLocalDaemonResolver({ root: localDataDir, port: process.env.KYBERN_PORT })

export interface Environment { id: string; name: string; local: boolean; endpoint: Endpoint | null; dataDir: string; revision: number }
function initial(): Environment {
  let profile = localProfile
  try { profile = profileById(process.env.KYBERN_GPUIX_ENVIRONMENT ?? 'local') } catch { /* The connection surface reports missing credentials or addresses. */ }
  return { id: profile.id, name: profile.name, local: profile.local, endpoint: null, dataDir: localDataDir, revision: 0 }
}
const active = initial()
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
/** The machine this window is at. It does not change, so this is `activeEnvironment()` for components. */
export function useEnvironment() { return useSyncExternalStore(() => () => {}, activeEnvironment) }
/**
 * Nothing calls these back any more: the window's machine never changes. The registrations that remain reset
 * stores that no longer need resetting and are removed in the next commit.
 */
export function onEnvironmentChange(_reset: (previous: Environment, next: Environment) => void, _priority = 0) { return () => {} }
export function onEnvironmentLeaving(_save: () => void) { return () => {} }
