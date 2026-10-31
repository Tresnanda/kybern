import { completeProvisionProject } from '../../../../packages/kybern-client/src/provision.ts'
import type { LogicalProject } from '../../../../packages/kybern-client/src/machineMerge.ts'
import type { ProvisionPlan } from '../../../../packages/kybern-client/src/types.ts'

/** Nothing is selected until the destination and its member mappings are ready. */
export async function finishMachineSetup(input: { projectId: string; key: string; targetId: string; paneId: string; plan?: ProvisionPlan }, actions: {
  refresh: (machineId: string) => Promise<unknown>
  projects: () => readonly LogicalProject[]
  localMachineId: string | undefined
  paths: (projectId: string, machineId: string, paneId: string, plan?: ProvisionPlan) => Promise<void>
  providers: (machineId: string, force: boolean, projectId: string) => Promise<void>
  select: (key: string, machineId: string, paneId: string) => void
}) {
  await actions.refresh(input.targetId)
  const logical = actions.projects().find((item) => item.key === input.key)
  const source = logical?.instances.find((item) => item.project.id === input.projectId)
  const destination = logical?.instances.find((item) => item.machineId === input.targetId)
  if (!source || !destination || !completeProvisionProject(source.project, destination.project)) throw new Error('The project list has not refreshed yet.')
  if (destination.project.kind === 'group') await actions.paths(input.projectId, input.targetId, input.paneId, input.plan)
  if (input.targetId !== actions.localMachineId) await actions.providers(input.targetId, true, destination.project.id)
  actions.select(input.key, input.targetId, input.paneId)
}
