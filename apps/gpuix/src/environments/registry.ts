import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
export function readRegistry(): Registry {
  try {
    const value = JSON.parse(readFileSync(path.join(configDir(), 'environments.json'), 'utf8')) as Registry
    if (!Array.isArray(value.environments) || !value.environments.every((p) => typeof p.id === 'string' && typeof p.name === 'string')) throw Error('Invalid environment registry')
    return { selected_id: typeof value.selected_id === 'string' ? value.selected_id : 'local', environments: value.environments.filter((p) => p.id !== 'local') }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { selected_id: 'local', environments: [] }
    throw new Error('Unable to read saved environments. Restore environments.json from a backup before saving connections.')
  }
}
export function writeRegistry(registry: Registry) {
  const dir = configDir()
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'environments.json')
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(registry, null, 2), { mode: 0o600 })
  renameSync(temp, file)
}
export function profileById(id: string) {
  if (id === 'local') return localProfile
  const profile = readRegistry().environments.find((p) => p.id === id)
  if (!profile) throw Error('This environment was removed. Choose another environment.')
  return profile
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
/** A saved environment's endpoint. The device token comes from the credential store, which is asynchronous off macOS. */
export function profileEndpoint(profile: EnvironmentProfile): Endpoint | Promise<Endpoint> {
  if (profile.id === 'local') return localEndpoint()
  if (!profile.url) throw Error('Edit this environment and enter its address.')
  const url = normalizeDaemonUrl(profile.url), environmentId = profile.environment_id ?? undefined
  return readCredential(profile.id).then(token => ({ url, token, environmentId }))
}
