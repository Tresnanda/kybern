// The project list stays in step with the daemon: `projects.list` at boot, then
// `projects.changed` (the whole list) whenever any client, the CLI or the daemon
// adds, updates or removes a project. Pure helpers, so the merge is testable.
import type { Project, ProjectId } from "@/protocol"

/**
 * The project map for a `projects.changed` list. Projects that did not change keep
 * their objects, so views reading them do not re-render; missing ones are removed.
 */
export function mergeProjects(current: Readonly<Record<ProjectId, Project>>, incoming: readonly Project[]): Record<ProjectId, Project> {
  const next: Record<ProjectId, Project> = {}
  for (const project of incoming) {
    const existing = current[project.id]
    next[project.id] = existing && sameProject(existing, project) ? existing : project
  }
  return next
}

function sameProject(a: Project, b: Project): boolean {
  return (
    a.name === b.name &&
    a.path === b.path &&
    a.is_git === b.is_git &&
    (a.worktrees_default ?? null) === (b.worktrees_default ?? null) &&
    (a.task_prefix ?? null) === (b.task_prefix ?? null) &&
    a.created_at === b.created_at &&
    a.updated_at === b.updated_at
  )
}

/** Whether the selection is a draft in a project that no longer exists. */
export function selectsMissingProject(
  selected: { kind: string; draft?: { projectId?: ProjectId | null } },
  projects: Readonly<Record<ProjectId, Project>>,
): boolean {
  const projectId = selected.kind === "draft" ? selected.draft?.projectId : undefined
  return !!projectId && !projects[projectId]
}
