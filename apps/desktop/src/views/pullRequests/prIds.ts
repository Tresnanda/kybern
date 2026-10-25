import type { ProjectId } from "@/protocol"

/** Identity of one pull request in lists and review state: a group project's members can repeat a number. */
export const prRef = (projectId: ProjectId, number: number, repo?: string | null) =>
  `${projectId}${repo ? `/${repo}` : ""}:${number}`

export const prRowId = (projectId: ProjectId, number: number, repo?: string | null) =>
  `pr-row-${prRef(projectId, number, repo).replace(/[^\w-]/g, "-")}`
