// The new chat's group choices (L3 sheet 5): which members a worktree chat includes and the branch per member, kept in
// the composer draft for one project at a time, and the `threads.create` fields they become.
import type { MemberState, Project, ProjectId, ThreadsCreateParams } from '../../../../packages/kybern-client/src/types.ts'

export interface GroupChoice {
  projectId: ProjectId
  /** Worktree mode: the member paths in this chat; null is every available member. */
  members: string[] | null
  /** Member path → branch: the fork point (worktree) or the branch to check out (local). */
  baseBranches: Record<string, string>
}

/** The choice when it belongs to this project, else a fresh one (nothing deselected, current branches). */
export function choiceFor(choice: GroupChoice | null | undefined, projectId: ProjectId): GroupChoice {
  return choice?.projectId === projectId ? choice : { projectId, members: null, baseBranches: {} }
}

/** Members that exist on disk; a missing one is offered to no new chat. */
export const availableMembers = (project: Pick<Project, 'members'>) => (project.members ?? []).filter((m) => m.status === 'ok')

/** The members this chat spans: every available one in local mode, the ticked ones in worktree mode. Project order. */
export function includedMembers(project: Pick<Project, 'members'>, choice: GroupChoice, worktree: boolean) {
  const available = availableMembers(project)
  if (!worktree || choice.members === null) return available
  const picked = available.filter((m) => choice.members!.includes(m.path))
  return picked.length ? picked : available.slice(0, 1)
}

/** Tick or untick a member; the last one can't be unticked. */
export function toggleMember(project: Pick<Project, 'members'>, choice: GroupChoice, path: string): GroupChoice {
  const current = includedMembers(project, choice, true).map((m) => m.path)
  const next = current.includes(path) ? current.filter((p) => p !== path) : [...current, path]
  if (!next.length) return choice
  const all = availableMembers(project).map((m) => m.path)
  return { ...choice, members: all.every((p) => next.includes(p)) ? null : all.filter((p) => next.includes(p)) }
}

/** A member's branch as the chat will use it: the one picked here, else its checkout's current branch. */
export function branchOf(choice: GroupChoice, path: string, status: readonly MemberState[] | null | undefined): string | null {
  return choice.baseBranches[path] ?? status?.find((m) => m.path === path)?.branch ?? null
}

/** The group fields of `threads.create`: `members` only when a worktree chat leaves some out, `base_branches` only when picked. */
export function groupCreateParams(project: Pick<Project, 'members'>, choice: GroupChoice, worktree: boolean): Pick<ThreadsCreateParams, 'members' | 'base_branches'> {
  const included = includedMembers(project, choice, worktree).map((m) => m.path)
  const params: Pick<ThreadsCreateParams, 'members' | 'base_branches'> = {}
  if (worktree && included.length < availableMembers(project).length) params.members = included
  const branches = Object.fromEntries(Object.entries(choice.baseBranches).filter(([path]) => included.includes(path)))
  if (Object.keys(branches).length) params.base_branches = branches
  return params
}
