// Where GPUIX keeps its machines (design §5.2, "Migration of environments.json").
//
// - `machines.json` in the client config dir holds one `MachineRecord` per
//   machine. A record made from a saved SSH profile keeps its `ssh` settings so
//   the app can open the tunnel before it dials.
// - Device tokens live in the credential store under `machine:<machine id>`. A
//   record that came from a saved profile reads that profile's token until its
//   machine id is verified (the set moves it then, see `MachineSet.rekeyMachine`).
// - `migrateEnvironments` turns the old `environments.json` into `machines.json`
//   the first time and renames the old file to `environments.json.migrated`. It
//   is idempotent: with `machines.json` present nothing is read or written.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { CredentialStore, MachineRecord } from '../../../../packages/kybern-client/src/machines.ts'
import type { CacheStorage } from '../../../../packages/kybern-client/src/machineCache.ts'
import type { EnvironmentProfile, Registry } from '../environments/registry.ts'
import { writeAllowed } from '../shell/persist.ts'
import { isLegacyMachineId, recordsFromRegistry } from './records.ts'

export type SavedSsh = NonNullable<EnvironmentProfile['ssh']>
/** A record as GPUIX keeps it: the SSH settings of a machine reached through a tunnel. */
export type GpuixMachineRecord = MachineRecord & { ssh?: SavedSsh }

const VERSION = 1
export const MACHINES_FILE = 'machines.json'
export const MACHINE_CACHE_FILE = 'machine-cache.json'
export const ENVIRONMENTS_FILE = 'environments.json'
export const ENVIRONMENTS_MIGRATED = 'environments.json.migrated'
export const machineCredentialId = (machineId: string) => `machine:${machineId}`

function writeJson(file: string, value: unknown) {
  if (!writeAllowed(file)) return
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
  renameSync(temp, file)
}

function isRecord(value: unknown): value is GpuixMachineRecord {
  const record = value as GpuixMachineRecord | null
  return !!record && typeof record === 'object' && typeof record.machineId === 'string' && typeof record.name === 'string'
}

/** The saved records, or `null` when there is no `machines.json` yet. An unreadable file is an error: a later save must not replace it. */
export function readMachineRecords(dir: string): GpuixMachineRecord[] | null {
  const file = path.join(dir, MACHINES_FILE)
  let text: string
  try { text = readFileSync(file, 'utf8') } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error('Unable to read saved machines. Restore machines.json from a backup before saving connections.')
  }
  const value = JSON.parse(text) as { machines?: unknown }
  if (!Array.isArray(value.machines)) throw new Error('Invalid machines file')
  return value.machines.filter(isRecord).map((record) => ({ ...record, routes: Array.isArray(record.routes) ? record.routes : [] }))
}

export function writeMachineRecords(dir: string, records: readonly MachineRecord[]) {
  writeJson(path.join(dir, MACHINES_FILE), { version: VERSION, machines: records })
}

/** The offline cache's file, written whole each time. */
export function fileCacheStorage(dir: string): CacheStorage {
  const file = path.join(dir, MACHINE_CACHE_FILE)
  return {
    read: () => { try { return readFileSync(file, 'utf8') } catch { return null } },
    write: (text) => { if (!writeAllowed(file)) return; mkdirSync(dir, { recursive: true, mode: 0o700 }); const temp = `${file}.${process.pid}.tmp`; writeFileSync(temp, text, { mode: 0o600 }); renameSync(temp, file) },
  }
}

export interface MigrationDeps {
  dir: string
  /** The saved environments (`readRegistry`), or `null` when the old file is absent. */
  registry: () => Registry | null
  local: EnvironmentProfile
  read: (id: string) => Promise<string>
  write: (id: string, token: string) => Promise<void>
  remove: (id: string) => Promise<void>
}

export interface MigrationResult { records: GpuixMachineRecord[]; migrated: boolean }

/**
 * `machines.json` as it is, else made from `environments.json`. A profile whose daemon id is known gets its token under
 * `machine:<id>` now; the rest keep theirs under the profile id until the machine answers. Then the old file is renamed.
 */
export async function migrateEnvironments(deps: MigrationDeps): Promise<MigrationResult> {
  const existing = readMachineRecords(deps.dir)
  if (existing) return { records: existing, migrated: false }
  const registry = deps.registry()
  const records: GpuixMachineRecord[] = recordsFromRegistry(registry ?? { selected_id: 'local', environments: [] }, deps.local)
  if (registry) for (const profile of registry.environments) {
    if (!profile.ssh) continue
    const record = records.find((item) => item.legacyProfileId === profile.id)
    if (record) record.ssh = profile.ssh
  }
  writeMachineRecords(deps.dir, records)
  if (!registry) return { records, migrated: false }
  // Verified machines first: a token that cannot move (locked keyring) stays under the profile id, which the record still names.
  for (const profile of registry.environments) {
    const record = records.find((item) => item.legacyProfileId === profile.id)
    if (!record || isLegacyMachineId(record.machineId)) continue
    try {
      const token = await deps.read(profile.id)
      await deps.write(machineCredentialId(record.machineId), token)
      await deps.remove(profile.id)
    } catch { /* The legacy token keeps working through `legacyProfileId`. */ }
  }
  const file = path.join(deps.dir, ENVIRONMENTS_FILE)
  if (existsSync(file) && writeAllowed(file)) renameSync(file, path.join(deps.dir, ENVIRONMENTS_MIGRATED))
  return { records, migrated: true }
}

export interface CredentialDeps {
  read: (id: string) => Promise<string>
  write: (id: string, token: string) => Promise<void>
  remove: (id: string) => Promise<void>
  /** A machine's saved profile, for a token that has not moved yet. */
  legacyProfileOf: (machineId: string) => string | undefined
}

/** The set's credentials: `machine:<id>`, then the saved profile's token for a machine that has not moved yet. */
export function machineCredentials(deps: CredentialDeps): CredentialStore {
  return {
    get: async (machineId) => {
      try { return await deps.read(machineCredentialId(machineId)) } catch { /* not moved yet */ }
      const profile = deps.legacyProfileOf(machineId)
      if (!profile) return undefined
      try { return await deps.read(profile) } catch { return undefined }
    },
    set: (machineId, token) => deps.write(machineCredentialId(machineId), token),
    delete: async (machineId) => {
      const profile = deps.legacyProfileOf(machineId)
      await deps.remove(machineCredentialId(machineId)).catch(() => {})
      if (profile && machineId !== profile) await deps.remove(profile).catch(() => {})
    },
  }
}
