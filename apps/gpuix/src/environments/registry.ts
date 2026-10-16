import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { Endpoint } from '../../../../packages/kybern-client/src/client.ts'
import { normalizeDaemonUrl } from '../../../../packages/kybern-client/src/address.ts'
import { readCredential } from './credentials.ts'

export interface EnvironmentProfile {
  id: string; name: string; url?: string | null; environment_id?: string | null; hostname?: string | null; local: boolean
  ssh?: { target: string; port?: number; remote_port: number; local_port: number; data_dir?: string | null }
}
export interface Registry { selected_id: string; environments: EnvironmentProfile[] }
export const localDataDir = process.env.KYBERN_DATA_DIR ?? path.join(homedir(), '.kybern')
const configuredUrl = process.env.KYBERN_URL
const configuredToken = process.env.KYBERN_TOKEN
export const localProfile: EnvironmentProfile = { id: 'local', name: process.env.KYBERN_ENVIRONMENT_NAME ?? (configuredUrl ? 'Configured environment' : 'This Mac'), local: !configuredUrl, url: configuredUrl }
export const configDir = () => process.env.KYBERN_CLIENT_CONFIG_DIR ?? path.join(homedir(), 'Library/Application Support/dev.kybern.desktop')
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
export function profileEndpoint(profile: EnvironmentProfile): Endpoint {
  if (profile.id === 'local') {
    if (configuredUrl && configuredToken) return { url: normalizeDaemonUrl(configuredUrl), token: configuredToken }
    const port = readFileSync(path.join(localDataDir, 'daemon.port'), 'utf8').trim()
    const token = readFileSync(path.join(localDataDir, 'daemon.token'), 'utf8').trim()
    return { url: `ws://127.0.0.1:${port}/ws`, token }
  }
  if (!profile.url) throw Error('Edit this environment and enter its address.')
  return { url: normalizeDaemonUrl(profile.url), token: readCredential(profile.id), environmentId: profile.environment_id ?? undefined }
}
