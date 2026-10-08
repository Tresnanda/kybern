import type { PrCheck, PrChecksSummary } from "../../../../../packages/kybern-client/src/types.ts"

export type CheckBucket = "passed" | "failed" | "pending" | "skipped"

const FAILED = ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]

/** Same rule as the daemon's `check_bucket`. Paged checks carry lower-case values. */
export function checkBucket(check: PrCheck): CheckBucket {
  const status = check.status.toUpperCase()
  const conclusion = check.conclusion.toUpperCase()
  // A StatusContext reports its state in both fields.
  if (["PENDING", "EXPECTED"].includes(conclusion)) return "pending"
  if (status && status !== "COMPLETED" && !["SUCCESS", "FAILURE", "ERROR"].includes(status))
    return "pending"
  if (conclusion === "SUCCESS") return "passed"
  if (FAILED.includes(conclusion)) return "failed"
  return "skipped"
}

export function summarizeChecks(checks: readonly PrCheck[]): PrChecksSummary {
  const out: PrChecksSummary = { total: checks.length, passed: 0, failed: 0, pending: 0, skipped: 0 }
  for (const check of checks) out[checkBucket(check)]++
  return out
}

const ORDER: Record<CheckBucket, number> = { failed: 0, pending: 1, passed: 2, skipped: 3 }
export function sortChecks(checks: readonly PrCheck[]): PrCheck[] {
  return checks
    .map((check, index) => ({ check, index, rank: ORDER[checkBucket(check)] }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.check)
}

export function checksPhrase(summary: PrChecksSummary | null | undefined): string {
  if (!summary || summary.total === 0) return "No checks reported"
  if (summary.passed === summary.total) return `All ${summary.total} passed`
  const parts: string[] = []
  if (summary.failed) parts.push(`${summary.failed} failing`)
  if (summary.pending) parts.push(`${summary.pending} running`)
  if (summary.passed) parts.push(`${summary.passed} passed`)
  if (summary.skipped) parts.push(`${summary.skipped} skipped`)
  return parts.join(" · ")
}

/** Accessible label for the list's CI dot, e.g. "Checks: 2 failing of 14". */
export function checksDotLabel(summary: PrChecksSummary): string {
  if (summary.failed) return `Checks: ${summary.failed} failing of ${summary.total}`
  if (summary.pending) return `Checks: ${summary.pending} running of ${summary.total}`
  if (summary.skipped) return `Checks: ${summary.passed} passed, ${summary.skipped} skipped`
  return `Checks: all ${summary.total} passed`
}

/** Arc lengths for the ring, proportional to each bucket with a 2-unit gap between segments. */
export function ringSegments(summary: PrChecksSummary, circumference: number, gap = 2) {
  const order = ["failed", "pending", "passed", "skipped"] as const
  const buckets = order.filter((b) => summary[b] > 0)
  const gaps = buckets.length > 1 ? gap : 0
  const usable = circumference - gaps * buckets.length
  let offset = 0
  return buckets.map((bucket) => {
    const length = (summary[bucket] / summary.total) * usable
    const segment = { bucket, length, offset }
    offset += length + gaps
    return segment
  })
}

