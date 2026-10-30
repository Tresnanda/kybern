// Saved environments as machine records (design §5.2, "Migration of
// environments.json"). Each profile becomes a record that remembers its profile
// id in `legacyProfileId`.
//
// `store.ts` persists the records (`machines.json`) and migrates the old file;
// this module only turns a profile into a record.
import type { MachineRecord } from '../../../../packages/kybern-client/src/machines.ts'
import type { Route } from '../../../../packages/kybern-client/src/types.ts'
import type { EnvironmentProfile, Registry } from '../environments/registry.ts'

export const LEGACY_PREFIX = 'legacy:'
/** A profile's machine id: the daemon's `environment_id` once verified, else a stand-in that is replaced the first time the daemon answers. */
export const legacyMachineId = (profile: Pick<EnvironmentProfile, 'id' | 'environment_id'>) => profile.environment_id || `${LEGACY_PREFIX}${profile.id}`
export const isLegacyMachineId = (machineId: string) => machineId.startsWith(LEGACY_PREFIX)

function routesOf(profile: EnvironmentProfile): Route[] {
  if (profile.ssh) return [{ kind: 'ssh', url: `http://127.0.0.1:${profile.ssh.local_port}` }]
  if (profile.url) return [{ kind: 'direct_advertised', url: profile.url.replace(/^ws/, 'http').replace(/\/ws\/?$/, '') }]
  return []
}

export function recordOfProfile(profile: EnvironmentProfile): MachineRecord {
  return {
    machineId: legacyMachineId(profile),
    name: profile.name,
    routes: routesOf(profile),
    // A daemon the user paired by hand is not in the network (design §4.3): its
    // connection is checked by the client's own environment id, not the identity document.
    member: false,
    legacyProfileId: profile.id,
  }
}

/** The local daemon first, then the saved environments in the order the user saved them. */
export function recordsFromRegistry(registry: Registry, local: EnvironmentProfile): MachineRecord[] {
  return [local, ...registry.environments.filter((profile) => profile.id !== local.id)].map(recordOfProfile)
}
