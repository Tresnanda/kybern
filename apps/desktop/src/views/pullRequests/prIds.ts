import type { ProjectId } from "@/protocol"

export const prRowId = (projectId: ProjectId, number: number) =>
  `pr-row-${projectId}-${number}`
