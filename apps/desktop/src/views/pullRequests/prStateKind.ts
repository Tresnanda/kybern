import type { PullRequest } from "../../../../../packages/kybern-client/src/types.ts"

export type PrStateKind = "open" | "draft" | "conflicts" | "merged" | "closed"

type StateInput = Pick<PullRequest, "state" | "is_draft" | "mergeable">

/** Precedence: merged > closed > draft > conflicts > open. */
export function resolvePrStateKind(pr: StateInput, mergeStateStatus?: string | null): PrStateKind {
  const state = pr.state.toUpperCase()
  if (state === "MERGED") return "merged"
  if (state === "CLOSED") return "closed"
  if (pr.is_draft) return "draft"
  if (pr.mergeable === "CONFLICTING" || mergeStateStatus === "DIRTY") return "conflicts"
  return "open"
}

