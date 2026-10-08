import type { PrChecksSummary } from "@/protocol"

import { ringSegments } from "./prChecks"

const COLORS = {
  failed: "var(--status-failure)",
  pending: "var(--color-warning, #f59e0b)",
  passed: "var(--status-success)",
  skipped: "var(--color-border)",
} as const

export function PrChecksRing({ summary, size = 16 }: { summary: PrChecksSummary | null | undefined; size?: number }) {
  const r = 6
  const c = 2 * Math.PI * r
  if (!summary || summary.total === 0)
    return (
      <svg aria-hidden width={size} height={size} viewBox="0 0 16 16" className="shrink-0">
        <circle cx="8" cy="8" r={r} fill="none" stroke="var(--color-border)" strokeWidth="2" />
      </svg>
    )
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 16 16" className="shrink-0 -rotate-90">
      {ringSegments(summary, c).map((s) => (
        <circle
          key={s.bucket}
          data-bucket={s.bucket}
          cx="8"
          cy="8"
          r={r}
          fill="none"
          stroke={COLORS[s.bucket]}
          strokeWidth="2"
          strokeDasharray={`${s.length} ${c - s.length}`}
          strokeDashoffset={-s.offset}
        />
      ))}
    </svg>
  )
}
