import type { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import type { LogicalProject } from '../../../../packages/kybern-client/src/machineMerge.ts'
import type { Project, ProvisionPlan } from '../../../../packages/kybern-client/src/types.ts'

export const groupPathsKey = (logicalKey: string, projectId: string, machineId: string) => JSON.stringify([logicalKey, projectId, machineId])

/** The probe pairs repositories by identity; Project.repos is sorted and cannot be zipped with members. */
export function groupPathsFromPlan(source: Project, target: Project, plan: ProvisionPlan): Record<string, string> {
  const members = plan.members ?? []
  const paths = Object.fromEntries(members.map((member) => [member.path, member.target_path]))
  if (plan.project_id !== source.id || source.members?.some((member) => !paths[member.path]) ||
    members.length !== source.members?.length || new Set(Object.values(paths)).size !== members.length ||
    members.some((member) => !target.members?.some((candidate) => candidate.path === member.target_path))) {
    throw new Error('Could not match this group’s repositories. Reconnect both machines and select the machine again.')
  }
  return paths
}

/** Existing groups need the same mapping as newly provisioned ones, using their actual destination folder. */
export async function readGroupPaths(logical: LogicalProject, projectId: string, targetId: string, clientFor: (id: string) => KybernClient): Promise<Record<string, string> | undefined> {
  const source = logical.instances.find((item) => item.project.id === projectId)
  const target = logical.instances.find((item) => item.machineId === targetId)
  if (!source || !target) throw new Error('The project list has not refreshed yet.')
  if (source.machineId === targetId || source.project.kind !== 'group') return undefined
  const plan = await clientFor(source.machineId).call('projects.provision_plan', { project_id: source.project.id, machine: targetId, path: target.project.path })
  if (plan.target.id !== targetId) throw new Error('The project list has not refreshed yet.')
  return groupPathsFromPlan(source.project, target.project, plan)
}
