import {
  GitMergeConflictIcon,
  GitMergedSimpleIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  type LucideIcon,
} from "@/lib/kit/icons"
import type { PullRequest } from "@/protocol"

import type { PrStateKind } from "./prStateKind"
export type { PrStateKind }
export interface PrStateView {
  kind: PrStateKind
  label: string
  colorClass: string
  Icon: LucideIcon
}

export const PR_STATE_VIEWS: Record<PrStateKind, PrStateView> = {
  open: { kind: "open", label: "Open", colorClass: "text-status-open", Icon: GitPullRequestIcon },
  draft: { kind: "draft", label: "Draft", colorClass: "text-status-neutral", Icon: GitPullRequestDraftIcon },
  conflicts: { kind: "conflicts", label: "Has conflicts", colorClass: "text-status-failure", Icon: GitMergeConflictIcon },
  merged: { kind: "merged", label: "Merged", colorClass: "text-status-merged", Icon: GitMergedSimpleIcon },
  closed: { kind: "closed", label: "Closed", colorClass: "text-status-neutral", Icon: GitPullRequestClosedIcon },
}

import { resolvePrStateKind } from "./prStateKind"

export function resolvePrState(pr: Pick<PullRequest, "state" | "is_draft" | "mergeable">, mergeStateStatus?: string | null): PrStateView {
  return PR_STATE_VIEWS[resolvePrStateKind(pr, mergeStateStatus)]
}
