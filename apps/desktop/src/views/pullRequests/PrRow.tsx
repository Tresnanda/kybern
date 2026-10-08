import { memo } from "react"

import { DiffStat } from "@/components/kit/diff-stat"
import { relativeTime } from "@/lib/format"
import { SIDEBAR_ROW_HOVER_CLASS_NAME } from "@/lib/kit/sidebarRowStyles"
import { cn } from "@/lib/utils"
import type { ProjectId, PullRequest } from "@/protocol"
import { openPullRequest } from "@/state/prReview"

import { prRowId } from "./prIds"
import { PrAvatar } from "./PrAvatar"
import { checksDotLabel } from "./prChecks"
import { resolvePrState } from "./prState"
import { PR_BODY_TEXT, PR_FINE_TEXT, PR_QUIET_INK } from "./prText"

function ciDotClass(failed: number, pending: number) {
  return failed > 0
    ? "bg-status-failure"
    : pending > 0
      ? "bg-warning"
      : "bg-status-success"
}

/** One pull request as two lines: the title, then state, author, age, CI, size and number. */
export const PrRow = memo(function PrRow({
  pr,
  projectId,
  selected,
  tabbable,
  onFocusRow,
}: {
  pr: PullRequest
  projectId: ProjectId
  selected: boolean
  tabbable: boolean
  onFocusRow: (key: string) => void
}) {
  const state = resolvePrState(pr)
  const summary = pr.checks_summary
  const updated = new Date(pr.updated_at)
  return (
    <button
      id={prRowId(projectId, pr.number)}
      data-pr-row
      data-row-key={`${projectId}:${pr.number}`}
      type="button"
      aria-current={selected ? "page" : undefined}
      tabIndex={tabbable ? 0 : -1}
      title={`${pr.title} #${pr.number}`}
      onFocus={() => onFocusRow(`${projectId}:${pr.number}`)}
      onClick={() => openPullRequest(projectId, pr.number)}
      className={cn(
        "pr-row -mx-1 flex w-[calc(100%+0.5rem)] min-w-0 flex-col gap-1 rounded-lg px-3 py-2 text-start outline-none focus-visible:ring-1 focus-visible:ring-ring",
        SIDEBAR_ROW_HOVER_CLASS_NAME,
        selected &&
          "bg-[color-mix(in_srgb,var(--color-text-foreground)_7%,transparent)]"
      )}
    >
      <span
        className={cn(
          PR_BODY_TEXT,
          "line-clamp-2 min-w-0 leading-snug font-medium text-foreground [overflow-wrap:anywhere]"
        )}
      >
        {pr.title}
      </span>
      <span
        className={cn(
          PR_FINE_TEXT,
          PR_QUIET_INK,
          "pr-row-meta flex min-w-0 items-center gap-1.5"
        )}
      >
        <state.Icon
          role="img"
          aria-label={state.label}
          className={cn("size-3.5 shrink-0", state.colorClass)}
        />
        <PrAvatar
          login={pr.author}
          url={pr.author_avatar_url}
          bot={pr.author_is_bot}
          size={16}
        />
        <span className="min-w-0 truncate">{pr.author}</span>
        <span aria-hidden className="shrink-0">
          ·
        </span>
        <time
          dateTime={pr.updated_at}
          title={`Updated ${updated.toLocaleString()}`}
          className="shrink-0 tabular-nums"
        >
          {relativeTime(pr.updated_at)}
        </time>
        <span className="ms-auto flex shrink-0 items-center gap-2 tabular-nums">
          {summary && summary.total > 0 && (
            <span
              role="img"
              aria-label={checksDotLabel(summary)}
              title={checksDotLabel(summary)}
              className={cn(
                "size-1.5 rounded-full",
                ciDotClass(summary.failed, summary.pending)
              )}
            />
          )}
          {pr.additions != null && pr.deletions != null && (
            <DiffStat
              className="pr-row-counts [&>span]:opacity-80"
              insertions={pr.additions}
              deletions={pr.deletions}
            />
          )}
          <span className="opacity-80">#{pr.number}</span>
        </span>
      </span>
    </button>
  )
})
