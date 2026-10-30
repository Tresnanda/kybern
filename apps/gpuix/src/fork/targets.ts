// Who can take a fork of a thread (design §7.1): the other machines that have the thread's project. Read from the machine
// hub when a menu opens, so a window with one machine never subscribes to anything.
import { forkTargets, type ForkInstance } from '../../../../packages/kybern-client/src/forkMachine.ts'
import { machineHub } from '../machines/index.ts'
import { ownProjectOf, type StateThread } from '../machines/merged.ts'

/** The machines a thread can be forked to; empty with one machine, so the menu item stays out of a single-machine app. */
export function forkTargetsOf(thread: Pick<StateThread, 'project_id' | 'ownProjectId' | 'machineId'> & { coordinator_project_id?: string | null; subagent?: unknown }): ForkInstance[] {
  const hub = machineHub()
  if (hub.machineCount <= 1 || thread.subagent) return []
  const owner = thread.machineId ?? hub.localMachineId
  if (!owner) return []
  const own = ownProjectOf(thread)
  const logical = hub.view().projects.find((project) => project.instances.some((instance) => instance.machineId === owner && instance.project.id === own))
  if (!logical) return []
  const ownInstance = logical.instances.find((instance) => instance.machineId === owner && instance.project.id === own)
  const paused = new Set(hub.connections().filter((connection) => connection.record.paused).map((connection) => connection.record.machineId))
  return forkTargets(
    logical.instances.map((instance) => ({
      machineId: instance.machineId,
      machineName: hub.set.connection(instance.machineId)?.record.name ?? instance.machineId,
      projectId: instance.project.id,
      online: !instance.offline,
      paused: paused.has(instance.machineId) || hub.set.connection(instance.machineId)?.record.member === false,
      project: instance.project,
    })),
    { machineId: owner, ...(ownInstance ? { project: ownInstance.project } : {}) },
  )
}
