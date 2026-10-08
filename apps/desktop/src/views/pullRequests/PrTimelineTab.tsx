import { useState } from "react"

import { Button } from "@/components/kit/button"
import { Checkbox } from "@/components/kit/checkbox"
import { DisclosureChevron } from "@/components/kit/DisclosureChevron"
import { DisclosureRegion } from "@/components/kit/DisclosureRegion"
import { Markdown } from "@/components/kybern/Markdown"
import { relativeTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { PrPageKind, PrReviewEntry, ProjectId } from "@/protocol"
import { loadReview } from "@/state/prReview"

import { PrAvatar } from "./PrAvatar"
import { PrTabs } from "./PrTabs"
import { PR_BODY_TEXT, PR_FINE_TEXT, PR_META_TEXT, PR_QUIET_INK } from "./prText"
import type { PrActions } from "./usePrActions"

const SOURCES: { value: PrPageKind; label: string }[] = [
  { value: "comments", label: "Comments" },
  { value: "reviews", label: "Reviews" },
  { value: "review_comments", label: "Inline comments" },
]
const CLAMP_LINES = 16

function StateChip({ state }: { state: string }) {
  const known: Record<string, { label: string; className: string }> = {
    APPROVED: { label: "Approved", className: "text-status-success" },
    CHANGES_REQUESTED: { label: "Changes requested", className: "text-status-failure" },
    COMMENTED: { label: "Commented", className: "text-muted-foreground" },
    DISMISSED: { label: "Dismissed", className: "text-muted-foreground" },
  }
  const chip = known[state.toUpperCase()]
  if (!chip) return null
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-full bg-[color-mix(in_srgb,currentColor_12%,transparent)] px-2 font-medium",
        PR_FINE_TEXT,
        chip.className
      )}
    >
      {chip.label}
    </span>
  )
}

function Entry({
  entry,
  checked,
  onToggle,
}: {
  entry: PrReviewEntry
  checked: boolean
  onToggle: () => void
}) {
  const [open, setOpen] = useState(true)
  const [clamped, setClamped] = useState(true)
  const body = entry.body || "No review summary."
  const tall = body.split("\n").length > CLAMP_LINES
  return (
    <article className="border-b border-[color:var(--app-surface-divider)] last:border-b-0">
      <div className="flex items-center gap-2 py-2.5">
        <Checkbox
          aria-label={`Select finding by ${entry.author}`}
          checked={checked}
          onCheckedChange={onToggle}
        />
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded-md text-start outline-none focus-visible:ring-1 focus-visible:ring-ring",
            PR_META_TEXT
          )}
        >
          <PrAvatar login={entry.author} url={entry.avatar_url} bot={entry.author_is_bot} size={20} />
          <span className="font-medium">{entry.author}</span>
          {entry.state && <StateChip state={entry.state} />}
          {entry.path && (
            <span className={cn("min-w-0 truncate font-mono", PR_FINE_TEXT, PR_QUIET_INK)}>
              {entry.path}:{entry.line ?? "outdated"}
            </span>
          )}
          <time
            dateTime={entry.updated_at}
            className={cn("ms-auto shrink-0", PR_FINE_TEXT, PR_QUIET_INK)}
          >
            {relativeTime(entry.updated_at)}
          </time>
          <DisclosureChevron open={open} className="size-3.5 shrink-0 opacity-50" />
        </button>
      </div>
      <DisclosureRegion open={open}>
        <div className="ps-[52px] pb-3">
          <div
            className={cn(
              "leading-relaxed break-words",
              PR_BODY_TEXT,
              !entry.body && PR_QUIET_INK,
              tall && clamped && "max-h-[calc(16*1.625em)] overflow-hidden"
            )}
          >
            <Markdown text={body} />
          </div>
          {tall && (
            <Button
              variant="ghost"
              size="xs"
              className="-ms-2 mt-1"
              onClick={() => setClamped((v) => !v)}
            >
              {clamped ? "Show more" : "Show less"}
            </Button>
          )}
        </div>
      </DisclosureRegion>
    </article>
  )
}

export function PrTimelineTab({
  actions,
  projectId,
  number,
  panelId,
  onSend,
}: {
  actions: PrActions
  projectId: ProjectId
  number: number
  panelId: string
  onSend: () => void
}) {
  const { review, draft, toggleFinding, clearSelection } = actions
  const kind = review?.kind ?? "comments"
  const entries = review?.page?.entries ?? []
  const page = review?.page?.page ?? 1
  const label = SOURCES.find((s) => s.value === kind)?.label.toLowerCase() ?? "comments"
  const go = (next: number) => void loadReview(projectId, number, kind, next)
  return (
    <div className="pr-timeline">
      <div className="px-6 pt-4">
        <PrTabs
          size="sm"
          value={kind}
          tabs={SOURCES}
          onChange={(next) => void loadReview(projectId, number, next)}
          label="Conversation source"
          id={`${panelId}-conversation`}
        />
      </div>
      <div
        id={`${panelId}-conversation-panel`}
        role="tabpanel"
        aria-labelledby={`${panelId}-conversation-${kind}`}
        className="mx-auto flex max-w-[56rem] flex-col px-6 pt-2 pb-6"
      >
        <p role="status" className="sr-only">
          {review?.loading ? "Refreshing…" : `${label} · page ${page}`}
        </p>
        {entries.map((entry) => (
          <Entry
            key={`${kind}:${entry.id}`}
            entry={entry}
            checked={draft.selected.includes(`${kind}:${entry.id}`)}
            onToggle={() => toggleFinding(entry)}
          />
        ))}
        {!entries.length && (
          <p className={cn("py-8 text-center", PR_QUIET_INK)}>
            {review?.loading ? "Loading…" : `No ${label} on this page.`}
          </p>
        )}
        <div className="mt-3 flex items-center justify-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={review?.loading || page <= 1}
            onClick={() => go(page - 1)}
          >
            Previous page
          </Button>
          <span className={cn("tabular-nums", PR_FINE_TEXT, PR_QUIET_INK)}>Page {page}</span>
          <Button
            variant="ghost"
            size="sm"
            disabled={review?.loading || !review?.page?.has_more}
            onClick={() => go(page + 1)}
          >
            Next page
          </Button>
        </div>
      </div>
      {draft.selected.length > 0 && (
        <div className="sticky bottom-3 flex justify-center px-6 pb-3">
          <div
            role="region"
            aria-label="Selected findings"
            className={cn(
              "flex items-center gap-3 rounded-full border border-[color:var(--color-border)] bg-popover px-3 py-1.5 shadow-lg/10",
              PR_META_TEXT
            )}
          >
            <span className="tabular-nums">{draft.selected.length} selected</span>
            <Button variant="ghost" size="xs" onClick={clearSelection}>
              Clear
            </Button>
            <Button size="xs" onClick={onSend}>
              Send to agent
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
