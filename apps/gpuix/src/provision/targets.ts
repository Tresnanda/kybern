// Which machines have a sidebar project and which could get it, read from the machine hub when a menu or the sheet opens.
import type { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import type { MachineId } from '../../../../packages/kybern-client/src/types.ts'
import { provisionSource, provisionTargets, type ProvisionTarget } from '../../../../packages/kybern-client/src/provision.ts'
import { machineHub } from '../machines/index.ts'

export interface ProvisionInstance { machineId: MachineId; machineName: string; projectId: string; online: boolean }

export interface ProvisionContext {
  name: string
  /** The machines that have the project, each with its own project id. */
  instances: ProvisionInstance[]
  targets: ProvisionTarget[]
  /** The machine that sends it by default. */
  source: MachineId | null
}

const LIVE = new Set(['online', 'relaying', 'needs-update'])

/** Native fixtures only (`provision.fixture.tsx`): a fixed context and one client for every machine, with no machine hub. */
let fixture: { context: ProvisionContext; client: () => KybernClient } | null = null
export function setProvisionFixture(next: typeof fixture) { fixture = next }
export const fixtureClient = (): KybernClient | null => fixture?.client() ?? null

/** The project a sidebar row shows, across machines. `machineId` is the machine the row (or thread) is on, when known. */
export function provisionContextOf(projectId: string, machineId?: MachineId | null, sourceOverride?: MachineId | null): ProvisionContext | null {
  if (fixture) return fixture.context
  const hub = machineHub()
  if (hub.machineCount <= 1) return null
  const local = hub.localMachineId
  const owner = machineId ?? local
  const projects = hub.view().projects
  const logical = projects.find((project) => project.instances.some((instance) => instance.machineId === owner && instance.project.id === projectId))
    ?? projects.find((project) => project.instances.some((instance) => instance.project.id === projectId))
  if (!logical) return null
  const connections = hub.connections()
  const nameOf = (id: MachineId) => hub.set.displayName(id) ?? id
  const onlineOf = (id: MachineId) => LIVE.has(connections.find((connection) => connection.record.machineId === id)?.status ?? '')
  const instances = logical.instances.map((instance) => ({ machineId: instance.machineId, machineName: nameOf(instance.machineId), projectId: instance.project.id, online: !instance.offline && onlineOf(instance.machineId) }))
  const source = provisionSource(instances, sourceOverride ?? owner)
  const members = connections.map((connection) => ({
    machineId: connection.record.machineId,
    machineName: nameOf(connection.record.machineId),
    online: LIVE.has(connection.status),
    paused: !!connection.record.paused,
    member: connection.record.member,
  }))
  return { name: logical.name, instances, targets: source ? provisionTargets(members, new Set(instances.map((instance) => instance.machineId)), source) : [], source }
}

/** Whether "Add to another machine…" belongs in a project's menu: another member exists that lacks it. */
export function canProvision(projectId: string, machineId?: MachineId | null): boolean {
  const context = provisionContextOf(projectId, machineId)
  return !!context?.source && context.targets.some((target) => !target.has)
}
