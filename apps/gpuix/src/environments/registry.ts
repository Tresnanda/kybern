import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { Endpoint } from '../../../../packages/kybern-client/src/client.ts'
import { normalizeDaemonUrl } from '../../../../packages/kybern-client/src/address.ts'
import { readCredential } from './credentials.ts'
import { desktopConfigDir, osLabels } from '../platform/os.ts'

export interface EnvironmentProfile {
  id: string; name: string; url?: string | null; environment_id?: string | null; hostname?: string | null; local: boolean
  ssh?: { target: string; port?: number; remote_port: number; local_port: number; data_dir?: string | null }
}
export interface Registry { selected_id: string; environments: EnvironmentProfile[] }
export const localDataDir = process.env.KYBERN_DATA_DIR ?? path.join(homedir(), '.kybern')
const configuredUrl = process.env.KYBERN_URL
export const localProfile: EnvironmentProfile = { id: 'local', name: process.env.KYBERN_ENVIRONMENT_NAME ?? (configuredUrl ? 'Configured environment' : osLabels().thisComputer), local: !configuredUrl, url: configuredUrl }
export const configDir = () => desktopConfigDir()
/** The pre-network `environments.json`, or `null` when there is none. Read once, by the migration to `machines.json` (`machines/store.ts`). */
export function readLegacyRegistry(): Registry | null {
  try {
    const value = JSON.parse(readFileSync(path.join(configDir(), 'environments.json'), 'utf8')) as Registry
    if (!Array.isArray(value.environments) || !value.environments.every((p) => typeof p.id === 'string' && typeof p.name === 'string')) throw Error('Invalid environment registry')
    return { selected_id: typeof value.selected_id === 'string' ? value.selected_id : 'local', environments: value.environments.filter((p) => p.id !== 'local') }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error('Unable to read saved environments. Restore environments.json from a backup before saving connections.')
  }
}
/**
 * A machine of `machines.json` as the profile the connection code wants (`KYBERN_GPUIX_ENVIRONMENT` names one to focus for checks).
 * The same file is read by `machines/store.ts`; it is read here with the file system alone so this module stays below it.
 */
export function profileById(id: string): EnvironmentProfile {
  if (id === 'local') return localProfile
  let machines: { machineId: string; name: string; legacyProfileId?: string; routes?: { kind: string; url: string }[]; ssh?: EnvironmentProfile['ssh'] }[] = []
  try { machines = (JSON.parse(readFileSync(path.join(configDir(), 'machines.json'), 'utf8')) as { machines?: typeof machines }).machines ?? [] } catch { /* none saved */ }
  const record = machines.find((m) => m.legacyProfileId === id || m.machineId === id)
  if (!record) throw Error('This machine was removed. Choose another machine.')
  const route = record.routes?.find((r) => r.kind !== 'ssh') ?? record.routes?.[0]
  const verified = !record.machineId.startsWith('legacy:')
  return { id: record.legacyProfileId ?? record.machineId, name: record.name, url: route ? route.url.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws' : null, environment_id: verified ? record.machineId : null, local: false, ...(record.ssh ? { ssh: record.ssh } : {}) }
}
/** The local daemon's address and token, from the data folder (or `KYBERN_URL` and `KYBERN_TOKEN`). Synchronous: two small files. */
export function localEndpoint(): Endpoint {
  const configuredUrl = process.env.KYBERN_URL, configuredToken = process.env.KYBERN_TOKEN
  if (configuredUrl) {
    if (!configuredToken) throw Error('Set KYBERN_TOKEN for the daemon configured by KYBERN_URL')
    return { url: normalizeDaemonUrl(configuredUrl), token: configuredToken }
  }
  const port = readFileSync(path.join(localDataDir, 'daemon.port'), 'utf8').trim()
  const token = readFileSync(path.join(localDataDir, 'daemon.token'), 'utf8').trim()
  return { url: `ws://127.0.0.1:${port}/ws`, token }
}
/** A saved machine's endpoint. The device token comes from the credential store (`machine:<id>`, else the saved profile's), which is asynchronous off macOS. */
export function profileEndpoint(profile: EnvironmentProfile): Endpoint | Promise<Endpoint> {
  if (profile.id === 'local') return localEndpoint()
  if (!profile.url) throw Error('This machine has no address saved. Add it again from Settings → Machines.')
  const url = normalizeDaemonUrl(profile.url), environmentId = profile.environment_id ?? undefined
  return (environmentId ? readCredential(`machine:${environmentId}`).catch(() => readCredential(profile.id)) : readCredential(profile.id)).then(token => ({ url, token, environmentId }))
}
