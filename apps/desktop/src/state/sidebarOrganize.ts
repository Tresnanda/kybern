// Sidebar organization: the user's project order and thread filter. Pure
// helpers so the ordering and matching rules are testable without React.
import type { ProjectId, ProviderKind, Thread, ThreadActivityState } from "@/protocol"

export type ThreadFilter = "all" | "pinned" | "working"

export interface SidebarFilter {
  threads: ThreadFilter
  /** Show only threads run by this agent. */
  agent: ProviderKind | null
}

export const DEFAULT_SIDEBAR_FILTER: SidebarFilter = { threads: "all", agent: null }

const THREAD_FILTERS: readonly ThreadFilter[] = ["all", "pinned", "working"]

export function isFiltering(filter: SidebarFilter): boolean {
  return filter.threads !== "all" || filter.agent !== null
}

/** Accept a stored filter only when every field is valid. */
export function readSidebarFilter(value: unknown): SidebarFilter | undefined {
  if (!value || typeof value !== "object") return undefined
  const { threads, agent } = value as Record<string, unknown>
  if (!THREAD_FILTERS.includes(threads as ThreadFilter)) return undefined
  if (agent !== null && typeof agent !== "string") return undefined
  return { threads: threads as ThreadFilter, agent: agent as ProviderKind | null }
}

/** Working means the agent is doing something or waiting on you. */
export function threadMatchesFilter(thread: Thread, filter: SidebarFilter, activity?: ThreadActivityState): boolean {
  if (filter.agent && thread.provider.kind !== filter.agent) return false
  switch (filter.threads) {
    case "pinned":
      return thread.pinned
    case "working":
      return thread.status === "running" || thread.status === "awaiting-approval" || activity === "working" || activity === "monitoring"
    default:
      return true
  }
}

/**
 * Projects in the user's order. Projects the order does not mention yet
 * (added since the last reorder) follow it alphabetically.
 */
export function orderProjects<T extends { id: ProjectId; name: string }>(projects: readonly T[], order: readonly ProjectId[]): T[] {
  const rank = new Map(order.map((id, index) => [id, index]))
  return [...projects].sort((a, b) => {
    const ra = rank.get(a.id)
    const rb = rank.get(b.id)
    if (ra !== undefined && rb !== undefined) return ra - rb
    if (ra !== undefined) return -1
    if (rb !== undefined) return 1
    return a.name.localeCompare(b.name)
  })
}

/**
 * Move `id` to `targetIndex` among the `visible` projects and return the new
 * full order. Hidden projects (filtered out) keep their places relative to
 * one another; the moved project lands just before the visible project it now
 * precedes, or just after the last one.
 */
export function moveProject(order: readonly ProjectId[], visible: readonly ProjectId[], id: ProjectId, targetIndex: number): ProjectId[] {
  const others = visible.filter((projectId) => projectId !== id)
  const index = Math.max(0, Math.min(targetIndex, others.length))
  const next = order.filter((projectId) => projectId !== id)
  const before = others[index]
  if (before !== undefined) next.splice(next.indexOf(before), 0, id)
  else {
    const after = others[others.length - 1]
    next.splice(after === undefined ? next.length : next.indexOf(after) + 1, 0, id)
  }
  return next
}

/**
 * Where a dragged row belongs: the number of other rows whose midpoint lies
 * above the dragged row's midpoint. `midpoints` are the other rows' resting
 * midpoints in list order.
 */
export function dropIndex(midpoints: readonly number[], draggedMidpoint: number): number {
  let index = 0
  while (index < midpoints.length && midpoints[index]! < draggedMidpoint) index += 1
  return index
}
