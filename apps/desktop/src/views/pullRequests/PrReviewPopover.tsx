// The GitHub review composer. Choosing a verdict and pressing submit is the
// confirmation: approve and request changes open no second dialog.

import { useState } from "react"

import { Alert } from "@/components/kit/alert"
import { Button } from "@/components/kit/button"
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/kit/popover"
import { Textarea } from "@/components/kit/textarea"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/kit/tooltip"
import { ChevronDownIcon, PencilIcon } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"
import { updateReviewDraft } from "@/state/prReview"
import {
  clearReviewDraft,
  reuseReviewDraftText,
} from "@/state/prReviewModel"

import { PR_FINE_TEXT, PR_META_TEXT, PR_QUIET_INK } from "./prText"
import type { PrActions } from "./usePrActions"

type Verdict = "comment" | "approve" | "request_changes"

const VERDICTS: { value: Verdict; label: string; hint: string }[] = [
  { value: "comment", label: "Comment", hint: "Post feedback without a verdict." },
  { value: "approve", label: "Approve", hint: "Approve these changes." },
  {
    value: "request_changes",
    label: "Request changes",
    hint: "Block merging until these are addressed.",
  },
]

export function PrReviewPopover({
  actions,
  stateKey,
  number,
  mode,
  open,
  onOpenChange,
}: {
  actions: PrActions
  stateKey: string
  number: number
  mode: "page" | "dock"
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { draft, detail, pr, busy, staleDraft, actionError, setActionError, submit } =
    actions
  const [verdict, setVerdict] = useState<Verdict>("comment")
  const [showInline, setShowInline] = useState(false)
  const isOpen = pr?.state === "OPEN"
  const empty = !draft.body.trim() && !draft.inline.length
  const disabled = (value: Verdict) =>
    value === "comment"
      ? false
      : !isOpen || staleDraft || (value === "request_changes" && empty)
  // A choice that became unavailable falls back to a plain comment.
  const effective = disabled(verdict) ? "comment" : verdict
  const inlineCount = draft.inline.length
  const submitLabel = busy
    ? "Submitting…"
    : effective === "comment"
      ? `Post comment${inlineCount ? ` and ${inlineCount} inline ${inlineCount === 1 ? "draft" : "drafts"}` : ""}`
      : effective === "approve"
        ? "Approve"
        : "Request changes"
  const canSubmit =
    !busy && !staleDraft && (effective !== "comment" || !empty)

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={
                    inlineCount
                      ? `Review, ${inlineCount} inline ${inlineCount === 1 ? "draft" : "drafts"}`
                      : "Review"
                  }
                  className="relative"
                />
              }
            />
          }
        >
          <PencilIcon className="size-3.5" />
          <span className="pr-topbar-label">Review</span>
          {inlineCount > 0 && (
            <span className="rounded-full bg-[var(--color-background-button-secondary)] px-1.5 tabular-nums">
              {inlineCount}
            </span>
          )}
          {staleDraft && (
            <span
              aria-hidden
              data-stale-dot
              className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-warning"
            />
          )}
          <ChevronDownIcon className="pr-topbar-label size-3 opacity-60" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Write a review</TooltipPopup>
      </Tooltip>
      <PopoverPopup
        align="end"
        sideOffset={6}
        className="w-[26rem] max-w-[calc(100vw-2rem)]"
      >
        <div className="flex flex-col gap-3" data-pr-review-popover>
          <div>
            <h2 className={cn(PR_META_TEXT, "font-medium")}>Review</h2>
            <p className={cn(PR_FINE_TEXT, PR_QUIET_INK)}>
              Drafts stay here until GitHub accepts them.
            </p>
          </div>
          {staleDraft && detail && (
            <Alert variant="warning" size="sm">
              <div className="flex flex-col gap-2">
                <p className="leading-relaxed">
                  This draft refers to{" "}
                  {draft.sourceHead
                    ? `commit ${draft.sourceHead.slice(0, 8)}`
                    : "an earlier commit"}
                  . The current commit is {detail.head_sha.slice(0, 8)}. Review
                  its changes before reusing your text. Inline comments need new
                  line anchors.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={
                      busy || !!draft.inline.length || !!draft.pendingInline
                    }
                    onClick={() => {
                      updateReviewDraft(
                        stateKey,
                        reuseReviewDraftText(draft, detail.head_sha)
                      )
                      setActionError(null)
                    }}
                  >
                    Use draft text for current commit
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={busy}
                    onClick={() => {
                      updateReviewDraft(stateKey, clearReviewDraft(draft))
                      setActionError(null)
                    }}
                  >
                    Clear review draft
                  </Button>
                </div>
                {(draft.inline.length > 0 || draft.pendingInline) && (
                  <p className="text-muted-foreground">
                    Remove saved inline drafts and cancel the unfinished inline
                    editor to reuse only the summary.
                  </p>
                )}
              </div>
            </Alert>
          )}
          {inlineCount > 0 && (
            <div className="rounded-lg border border-[color:var(--color-border)]">
              <button
                type="button"
                aria-expanded={showInline}
                className={cn(
                  PR_META_TEXT,
                  "flex w-full items-center gap-1.5 px-2.5 py-1.5 text-start outline-none focus-visible:ring-1 focus-visible:ring-ring"
                )}
                onClick={() => setShowInline((v) => !v)}
              >
                <ChevronDownIcon
                  className={cn("size-3 transition-transform", !showInline && "-rotate-90")}
                />
                {inlineCount} inline {inlineCount === 1 ? "comment" : "comments"}
              </button>
              {showInline && (
                <ul className="flex flex-col gap-2 px-2.5 pb-2">
                  {draft.inline.map((comment, i) => (
                    <li
                      key={`${comment.path}:${comment.side}:${comment.line}:${i}`}
                      className="flex items-start gap-2"
                    >
                      <div className="min-w-0 flex-1">
                        <p className={cn("font-mono break-all", PR_FINE_TEXT, PR_QUIET_INK)}>
                          {comment.path}:{comment.line} ·{" "}
                          {comment.side === "LEFT" ? "original" : "new"}
                        </p>
                        <p className="line-clamp-2 break-words whitespace-pre-wrap">
                          {comment.body}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() =>
                          updateReviewDraft(stateKey, {
                            inline: draft.inline.filter((_, index) => index !== i),
                          })
                        }
                      >
                        Remove draft
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor={`review-${mode}-${number}`}
              className={cn(PR_FINE_TEXT, "font-medium text-muted-foreground")}
            >
              Summary
            </label>
            <Textarea
              id={`review-${mode}-${number}`}
              value={draft.body}
              maxLength={65536}
              onChange={(e) => updateReviewDraft(stateKey, { body: e.target.value })}
              className="[&_textarea]:min-h-28 [&_textarea]:leading-relaxed"
            />
          </div>
          <div role="radiogroup" aria-label="Review type" className="flex flex-col gap-0.5">
            {VERDICTS.map((v) => {
              const off = disabled(v.value)
              return (
                <label
                  key={v.value}
                  className={cn(
                    "flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-[var(--color-background-elevated-secondary)] has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-ring",
                    off && "cursor-not-allowed opacity-50 hover:bg-transparent"
                  )}
                >
                  <input
                    type="radio"
                    name={`review-verdict-${mode}-${number}`}
                    value={v.value}
                    checked={effective === v.value}
                    disabled={off}
                    onChange={() => setVerdict(v.value)}
                    className="mt-0.5 size-3.5 accent-[var(--color-text-foreground)]"
                  />
                  <span className="min-w-0">
                    <span className={cn("block", PR_META_TEXT)}>{v.label}</span>
                    <span className={cn("block", PR_FINE_TEXT, PR_QUIET_INK)}>
                      {v.hint}
                    </span>
                  </span>
                </label>
              )
            })}
          </div>
          {actionError && (
            <p role="alert" className="break-words text-destructive">
              {actionError} Your draft is kept.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!canSubmit}
              onClick={async () => {
                if (await submit(effective)) onOpenChange(false)
              }}
            >
              {submitLabel}
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  )
}
