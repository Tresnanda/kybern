import { completeProvisionProject } from '../../../../packages/kybern-client/src/provision.ts'
import type { LogicalProject } from '../../../../packages/kybern-client/src/machineMerge.ts'
import type { ProvisionPlan } from '../../../../packages/kybern-client/src/types.ts'

const ofProject = (projects: readonly LogicalProject[], projectId: string) =>
  projects.find((item) => item.instances.some((instance) => instance.project.id === projectId))

/**
 * Nothing is selected until the destination and its member mappings are ready. The project is found by its id, not by
 * the key the picker had: a project registered before its first commit gets its repository identity during setup, which
 * changes its key.
 */
export async function finishMachineSetup(input: { projectId: string; targetId: string; paneId: string; plan?: ProvisionPlan }, actions: {
  refresh: (machineId: string) => Promise<unknown>
  projects: () => readonly LogicalProject[]
  localMachineId: string | undefined
  paths: (projectId: string, machineId: string, paneId: string, plan?: ProvisionPlan) => Promise<void>
  providers: (machineId: string, force: boolean, projectId: string) => Promise<void>
  select: (key: string, machineId: string, paneId: string) => void
}) {
  // The source's list too: setup may have just stored the identity the two copies are paired by.
  const sourceMachine = ofProject(actions.projects(), input.projectId)?.instances.find((item) => item.project.id === input.projectId)?.machineId
  await Promise.all([actions.refresh(input.targetId), ...(sourceMachine && sourceMachine !== input.targetId ? [actions.refresh(sourceMachine)] : [])])
  const logical = ofProject(actions.projects(), input.projectId)
  const source = logical?.instances.find((item) => item.project.id === input.projectId)
  const destination = logical?.instances.find((item) => item.machineId === input.targetId)
  if (!logical || !source || !destination || !completeProvisionProject(source.project, destination.project)) throw new Error('The project list has not refreshed yet.')
  if (destination.project.kind === 'group') await actions.paths(input.projectId, input.targetId, input.paneId, input.plan)
  if (input.targetId !== actions.localMachineId) await actions.providers(input.targetId, true, destination.project.id)
  actions.select(logical.key, input.targetId, input.paneId)
}
