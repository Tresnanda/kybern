// The info column. One DOM tree: wide, it is a sticky column; narrow, container
// queries turn each section into a label/value row under the header (review.css).

import { useState } from "react"

import { Button } from "@/components/kit/button"
import { copyText } from "@/lib/hooks"
import {
  ArrowDownIcon,
  ArrowUpRightIcon,
  ChatBubbleIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  ClockIcon,
  CopyIcon,
  GitMergeConflictIcon,
  GitMergedSimpleIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  LoaderCircleIcon,
  XIcon,
  type LucideIcon,
} from "@/lib/kit/icons"
import { openExternal } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import type { PrCheck, PrDetailResult, PrPageResult } from "@/protocol"

import { PrAvatar } from "./PrAvatar"
import { PrChecksRing } from "./PrChecksRing"
import {
  checkBucket,
  checksPhrase,
  sortChecks,
  summarizeChecks,
} from "./prChecks"
import { agoPhrase } from "./prFormat"
import { PR_FINE_TEXT, PR_META_TEXT, PR_QUIET_INK, PR_SECTION_TEXT } from "./prText"

const CHECK_ROWS = 6

interface MergeStatus {
  Icon: LucideIcon
  tone: string
  text: string
  hint?: string
}

function mergeStatus(detail: PrDetailResult): MergeStatus {
  const pr = detail.pull_request
  const state = pr.state.toUpperCase()
  if (state === "MERGED")
    return {
      Icon: GitMergedSimpleIcon,
      tone: "text-status-merged",
      text: `Merged${detail.merged_by ? ` by ${detail.merged_by}` : ""} into ${pr.base} ${agoPhrase(detail.merged_at ?? pr.updated_at)}`.trim(),
    }
  if (state === "CLOSED")
    return {
      Icon: GitPullRequestClosedIcon,
      tone: "text-status-neutral",
      text: `Closed ${agoPhrase(detail.closed_at ?? pr.updated_at)}`.trim(),
    }
  const mss = detail.merge_state_status
  if (pr.is_draft || mss === "DRAFT")
    return {
      Icon: GitPullRequestDraftIcon,
      tone: "text-status-neutral",
      text: "Draft. Mark it ready on GitHub to merge.",
    }
  if (pr.mergeable === "CONFLICTING" || mss === "DIRTY")
    return {
      Icon: GitMergeConflictIcon,
      tone: "text-status-failure",
      text: `Conflicts with ${pr.base}`,
      hint: "Send this pull request to an agent to resolve them.",
    }
  if (mss === "BEHIND")
    return {
      Icon: ArrowDownIcon,
      tone: "text-warning",
      text: `Behind ${pr.base}. Update the branch on GitHub.`,
    }
  if (mss === "BLOCKED")
    return {
      Icon: CircleAlertIcon,
      tone: "text-warning",
      text: "Blocked by required reviews or checks",
    }
  if (mss === "UNSTABLE")
    return { Icon: CircleAlertIcon, tone: "text-status-failure", text: "Checks failing" }
  if (mss === "CLEAN" || mss === "HAS_HOOKS")
    return { Icon: CircleCheckIcon, tone: "text-status-success", text: "Ready to merge" }
  return { Icon: ClockIcon, tone: PR_QUIET_INK, text: "Checking mergeability" }
}

const DECISIONS: Record<string, { label: string; className: string }> = {
  APPROVED: { label: "Approved", className: "text-status-success" },
  CHANGES_REQUESTED: { label: "Changes requested", className: "text-status-failure" },
  REVIEW_REQUIRED: { label: "Review required", className: "text-muted-foreground" },
}

function ReviewerGlyph({ state }: { state: string }) {
  if (state === "APPROVED")
    return <CircleCheckIcon aria-label="Approved" className="size-3.5 text-status-success" />
  if (state === "CHANGES_REQUESTED")
    return <CircleAlertIcon aria-label="Requested changes" className="size-3.5 text-status-failure" />
  if (state === "REQUESTED")
    return (
      <span className={cn("inline-flex items-center gap-1", PR_FINE_TEXT, PR_QUIET_INK)}>
        <ClockIcon aria-hidden className="size-3.5" />
        Requested
      </span>
    )
  return <ChatBubbleIcon aria-label="Commented" className={cn("size-3.5", PR_QUIET_INK)} />
}

function CheckGlyph({ check }: { check: PrCheck }) {
  const bucket = checkBucket(check)
  if (bucket === "failed") return <XIcon aria-label="Failed" className="size-3.5 shrink-0 text-status-failure" />
  if (bucket === "pending")
    return <LoaderCircleIcon aria-label="Running" className="size-3.5 shrink-0 text-warning" />
  if (bucket === "passed")
    return <CircleCheckIcon aria-label="Passed" className="size-3.5 shrink-0 text-status-success" />
  return <CircleCheckIcon aria-label="Skipped" className={cn("size-3.5 shrink-0", PR_QUIET_INK)} />
}

function Section({
  title,
  label,
  children,
  className,
}: {
  title: string
  label?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn("pr-info-section", className)} aria-label={label}>
      <h3 className={PR_SECTION_TEXT}>{title}</h3>
      <div className={cn("pr-info-value min-w-0", PR_META_TEXT)}>{children}</div>
    </section>
  )
}

export function PrInfo({
  detail,
  pagedChecks,
  checksKind,
  loading,
  onLoadChecks,
  onChecksPage,
  onOpenTimeline,
  linkedTitle,
  onOpenConversation,
}: {
  detail: PrDetailResult
  pagedChecks: PrPageResult | null
  checksKind: boolean
  loading: boolean
  onLoadChecks: () => void
  onChecksPage: (page: number) => void
  onOpenTimeline: () => void
  linkedTitle?: string
  onOpenConversation?: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const status = mergeStatus(detail)
  const decision = detail.pull_request.review_decision
    ? DECISIONS[detail.pull_request.review_decision]
    : undefined
  const summary = summarizeChecks(detail.checks)
  const sorted = sortChecks(detail.checks)
  const shown = expanded ? sorted : sorted.slice(0, CHECK_ROWS)
  const reviews = detail.reviews ?? []
  const count = detail.comment_count
  return (
    <aside className="pr-info" aria-label="Pull request details">
      <Section title="Merge status">
        <p className="flex items-start gap-2">
          <status.Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", status.tone)} />
          <span className="min-w-0">{status.text}</span>
        </p>
        {status.hint && (
          <p className={cn("mt-1", PR_FINE_TEXT, PR_QUIET_INK)}>{status.hint}</p>
        )}
        <p className={cn("mt-1 flex items-center gap-1", PR_FINE_TEXT, PR_QUIET_INK)}>
          <span>Head</span>
          <code className="font-mono" title={detail.head_sha}>
            {detail.head_sha.slice(0, 8)}
          </code>
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-5"
            aria-label="Copy head commit"
            onClick={() => {
              void copyText(detail.head_sha)
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1200)
            }}
          >
            {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
          </Button>
        </p>
      </Section>

      <Section title="Reviews">
        {decision && (
          <p className={cn("font-medium", decision.className)}>{decision.label}</p>
        )}
        {reviews.length > 0 ? (
          <ul className={cn("flex flex-col gap-1.5", decision && "mt-1.5")}>
            {reviews.map((r) => (
              <li key={r.login} className="flex min-w-0 items-center gap-2">
                <PrAvatar login={r.login} url={r.avatar_url} bot={r.is_bot} size={16} />
                <span className="min-w-0 flex-1 truncate">{r.login}</span>
                <ReviewerGlyph state={r.state} />
              </li>
            ))}
          </ul>
        ) : (
          <p className={PR_QUIET_INK}>No reviews yet</p>
        )}
      </Section>

      <Section title="Checks" label="Pull request checks">
        <p className="flex items-center gap-2">
          <PrChecksRing summary={summary} size={16} />
          <span className="min-w-0">{checksPhrase(summary)}</span>
        </p>
        {sorted.length > 0 && (
          <>
            <ul className="pr-checks-rows mt-1.5 flex flex-col" data-expanded={expanded || undefined}>
              {shown.map((check, i) => (
                <li key={`${check.name}:${i}`}>
                  <button
                    type="button"
                    disabled={!check.url}
                    onClick={() => void openExternal(check.url)}
                    className="group/check -mx-1.5 flex h-7 w-[calc(100%+0.75rem)] items-center gap-2 rounded-md px-1.5 text-start outline-none hover:bg-[var(--color-background-elevated-secondary)] focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default"
                  >
                    <CheckGlyph check={check} />
                    <span className="min-w-0 flex-1 truncate">{check.name}</span>
                    <ArrowUpRightIcon
                      aria-hidden
                      className="size-3 shrink-0 opacity-0 group-hover/check:opacity-60 group-focus-visible/check:opacity-60"
                    />
                  </button>
                </li>
              ))}
            </ul>
            {!expanded && (
              <Button
                variant="ghost"
                size="xs"
                className={cn("pr-checks-toggle -ms-2 mt-1", PR_QUIET_INK)}
                onClick={() => setExpanded(true)}
              >
                <span className="pr-checks-toggle-wide">
                  {sorted.length > CHECK_ROWS ? `Show all ${sorted.length} checks` : ""}
                </span>
                <span className="pr-checks-toggle-narrow">Show checks</span>
              </Button>
            )}
          </>
        )}
        {detail.checks.length >= 100 && !checksKind && (
          <Button
            variant="ghost"
            size="xs"
            className={cn("-ms-2 mt-1", PR_QUIET_INK)}
            onClick={onLoadChecks}
          >
            Load more checks
          </Button>
        )}
        {checksKind && (
          <div className="mt-2 flex flex-col gap-1" aria-label="Paged checks">
            <p role="status" className={cn(PR_FINE_TEXT, PR_QUIET_INK)}>
              {loading ? "Refreshing…" : `Checks · page ${pagedChecks?.page ?? 1}`}
            </p>
            {pagedChecks?.checks?.map((check, i) => (
              <button
                key={`${check.name}:${i}`}
                type="button"
                disabled={!check.url}
                onClick={() => void openExternal(check.url)}
                className="-mx-1.5 flex h-7 w-[calc(100%+0.75rem)] items-center gap-2 rounded-md px-1.5 text-start outline-none hover:bg-[var(--color-background-elevated-secondary)] focus-visible:ring-1 focus-visible:ring-ring"
              >
                <CheckGlyph check={check} />
                <span className="min-w-0 flex-1 truncate">{check.name}</span>
              </button>
            ))}
            {!pagedChecks?.checks?.length && (
              <p className={PR_QUIET_INK}>No checks on this page.</p>
            )}
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="xs"
                disabled={loading || (pagedChecks?.page ?? 1) <= 1}
                onClick={() => onChecksPage((pagedChecks?.page ?? 1) - 1)}
              >
                Previous page
              </Button>
              <Button
                variant="ghost"
                size="xs"
                disabled={loading || !pagedChecks?.has_more}
                onClick={() => onChecksPage((pagedChecks?.page ?? 1) + 1)}
              >
                Next page
              </Button>
            </div>
          </div>
        )}
      </Section>

      {count != null && (
        <Section title="Comments">
          {count === 0 ? (
            <p className={PR_QUIET_INK}>No comments</p>
          ) : (
            <button
              type="button"
              className="rounded-sm text-start outline-none hover:underline focus-visible:ring-1 focus-visible:ring-ring"
              onClick={onOpenTimeline}
            >
              {count} {count === 1 ? "comment" : "comments"}
            </button>
          )}
        </Section>
      )}

      {linkedTitle && onOpenConversation && (
        <Section title="Conversation">
          <button
            type="button"
            className="max-w-full truncate rounded-sm text-start outline-none hover:underline focus-visible:ring-1 focus-visible:ring-ring"
            onClick={onOpenConversation}
          >
            {linkedTitle}
          </button>
        </Section>
      )}
    </aside>
  )
}
