// Pull requests: the state a pull request is in, how its checks read, list filtering and the
// conversations a checkout or repair can use. Pure; shared by desktop, GPUIX and mobile so a
// pull request reads the same everywhere. (State and check rules moved from desktop
// views/pullRequests/prStateKind.ts and prChecks.ts.)
import type { PrCheck, PrChecksSummary, PullRequest, Thread } from "./types.ts";

export type PrStateKind = "open" | "draft" | "conflicts" | "merged" | "closed";

type StateInput = Pick<PullRequest, "state" | "is_draft" | "mergeable">;

/** Precedence: merged > closed > draft > conflicts > open. */
export function resolvePrStateKind(pr: StateInput, mergeStateStatus?: string | null): PrStateKind {
  const state = pr.state.toUpperCase();
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  if (pr.is_draft) return "draft";
  if (pr.mergeable === "CONFLICTING" || mergeStateStatus === "DIRTY") return "conflicts";
  return "open";
}

/** The word beside the state glyph. */
export const PR_STATE_WORDS: Record<PrStateKind, string> = {
  open: "Open",
  draft: "Draft",
  conflicts: "Has conflicts",
  merged: "Merged",
  closed: "Closed",
};

/** "Approved", "Changes requested", "Review required"; empty when GitHub gave no decision. */
export function reviewDecisionWord(decision: string | null | undefined): string {
  switch ((decision ?? "").toUpperCase()) {
    case "APPROVED":
      return "Approved";
    case "CHANGES_REQUESTED":
      return "Changes requested";
    case "REVIEW_REQUIRED":
      return "Review required";
    default:
      return "";
  }
}

// ---- checks ----

export type CheckBucket = "passed" | "failed" | "pending" | "skipped";

const FAILED = ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"];

/** Same rule as the daemon's `check_bucket`. Paged checks carry lower-case values. */
export function checkBucket(check: PrCheck): CheckBucket {
  const status = check.status.toUpperCase();
  const conclusion = check.conclusion.toUpperCase();
  // A StatusContext reports its state in both fields.
  if (["PENDING", "EXPECTED"].includes(conclusion)) return "pending";
  if (status && status !== "COMPLETED" && !["SUCCESS", "FAILURE", "ERROR"].includes(status)) return "pending";
  if (conclusion === "SUCCESS") return "passed";
  if (FAILED.includes(conclusion)) return "failed";
  return "skipped";
}

export function summarizeChecks(checks: readonly PrCheck[]): PrChecksSummary {
  const out: PrChecksSummary = { total: checks.length, passed: 0, failed: 0, pending: 0, skipped: 0 };
  for (const check of checks) out[checkBucket(check)]++;
  return out;
}

const ORDER: Record<CheckBucket, number> = { failed: 0, pending: 1, passed: 2, skipped: 3 };
/** Failing first, then running, passed and skipped; the original order within a bucket. */
export function sortChecks(checks: readonly PrCheck[]): PrCheck[] {
  return checks
    .map((check, index) => ({ check, index, rank: ORDER[checkBucket(check)] }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.check);
}

export function checksPhrase(summary: PrChecksSummary | null | undefined): string {
  if (!summary || summary.total === 0) return "No checks reported";
  if (summary.passed === summary.total) return `All ${summary.total} passed`;
  const parts: string[] = [];
  if (summary.failed) parts.push(`${summary.failed} failing`);
  if (summary.pending) parts.push(`${summary.pending} running`);
  if (summary.passed) parts.push(`${summary.passed} passed`);
  if (summary.skipped) parts.push(`${summary.skipped} skipped`);
  return parts.join(" · ");
}

/** Accessible label for the list's CI dot, e.g. "Checks: 2 failing of 14". */
export function checksDotLabel(summary: PrChecksSummary): string {
  if (summary.failed) return `Checks: ${summary.failed} failing of ${summary.total}`;
  if (summary.pending) return `Checks: ${summary.pending} running of ${summary.total}`;
  if (summary.skipped) return `Checks: ${summary.passed} passed, ${summary.skipped} skipped`;
  return `Checks: all ${summary.total} passed`;
}

/** The one bucket a summary reads as: any failure fails, else anything running is pending. */
export function checksOutcome(summary: PrChecksSummary | null | undefined): CheckBucket | null {
  if (!summary || summary.total === 0) return null;
  if (summary.failed) return "failed";
  if (summary.pending) return "pending";
  if (summary.passed) return "passed";
  return "skipped";
}

/** Arc lengths for the ring, proportional to each bucket with a 2-unit gap between segments. */
export function ringSegments(summary: PrChecksSummary, circumference: number, gap = 2) {
  const order = ["failed", "pending", "passed", "skipped"] as const;
  const buckets = order.filter((b) => summary[b] > 0);
  const gaps = buckets.length > 1 ? gap : 0;
  const usable = circumference - gaps * buckets.length;
  let offset = 0;
  return buckets.map((bucket) => {
    const length = (summary[bucket] / summary.total) * usable;
    const segment = { bucket, length, offset };
    offset += length + gaps;
    return segment;
  });
}

// ---- lists ----

export type PrFilter = "open" | "merged" | "closed" | "all";
export const PR_FILTERS: readonly { value: PrFilter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "merged", label: "Merged" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

/** Title, head branch or number ("#12" or "12"). */
export function matchesPrQuery(pr: Pick<PullRequest, "title" | "head" | "number">, query: string): boolean {
  const q = query.trim().toLowerCase().replace(/^#/, "");
  return !q || pr.title.toLowerCase().includes(q) || pr.head.toLowerCase().includes(q) || String(pr.number).includes(q);
}

/** Newest activity first across projects. */
export function byUpdated<T extends { pr: Pick<PullRequest, "updated_at"> }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.pr.updated_at.localeCompare(a.pr.updated_at));
}

/** "No open pull requests", "No pull requests": the empty list's title for a filter. */
export function emptyPrTitle(filter: PrFilter): string {
  return filter === "all" ? "No pull requests" : `No ${filter} pull requests`;
}

// ---- checkout and repair conversations ----

type ThreadLike = Pick<Thread, "id" | "project_id" | "status" | "worktree" | "subagent" | "delegation">;

/** Conversations in this project with their own worktree: where a checkout or repair can run. */
export function repairChoices<T extends ThreadLike>(threads: readonly T[], projectId: string): T[] {
  return threads.filter(
    (t) => t.project_id === projectId && !!t.worktree && t.status !== "archived" && !t.subagent && !t.delegation,
  );
}

/**
 * The conversation a draft repairs in: the one it chose (`"new"` asks for a new one), else a
 * worktree conversation already on the pull request's head branch.
 */
export function linkedRepairThread<T extends ThreadLike>(
  threads: readonly T[],
  projectId: string,
  head: string | undefined,
  chosen: string | null,
): T | undefined {
  const choices = repairChoices(threads, projectId);
  if (chosen === "new") return undefined;
  if (chosen) return choices.find((t) => t.id === chosen);
  return head ? choices.find((t) => t.worktree?.branch === head) : undefined;
}

/** A conversation that is working (or waiting on you) can't take a checkout or repair yet. */
export function repairBlocked(thread: Pick<Thread, "status"> | undefined): boolean {
  return thread?.status === "running" || thread?.status === "awaiting-approval";
}
