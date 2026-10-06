// One row of the Lineage tree and its detail. The row is a disclosure: the header says who and how it
// stands, the detail says what it produced. Detail mounts only while open (DisclosureRegion), so a
// long result, a long file list or a Markdown parse never sits behind a closed row.

import { memo, useState, type CSSProperties } from "react"

import {
  canRemoveWorktree,
  canStopDelegation,
  childState,
  delegationRoleLabel,
  lineageKind,
  type LineageRow,
} from "../../../../../packages/kybern-client/src/delegations.ts"
import { subagentTypeLabel } from "../../../../../packages/kybern-client/src/subagents.ts"
import { ProviderMark } from "@/components/kybern/bits"
import { TextSwap } from "@/components/kybern/motion"
import { DisclosureChevron } from "@/components/kit/DisclosureChevron"
import { DisclosureRegion } from "@/components/kit/DisclosureRegion"
import { Button } from "@/components/kit/button"
import { ArrowUpRightIcon, StopIcon, WorktreeIcon } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"
import type { Thread } from "@/protocol"
import { stopDelegatedChild } from "@/state/delegations"
import { openThreadView, useSubagentModel } from "@/state/subagents"
import { ClampedMarkdown, ConflictsList, DetailSection, FilesList, WorkspaceFacts } from "./detail"
import { ChildElapsed, ChildFacts, ChildGlyph } from "./parts"
import { phaseWordClass } from "./phaseStyles"

/** Indent per level of the tree, and the gutter every row keeps for its tree toggle. */
const INDENT = 14
const GUTTER = 18

const ACTION_CLASS =
  "relative flex size-[22px] cursor-pointer items-center justify-center rounded-md text-foreground/48 outline-hidden transition-colors after:absolute after:-inset-[3px] hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-3"

function roleText(thread: Thread): string {
  if (thread.delegation) return delegationRoleLabel(thread.delegation.role)
  if (thread.subagent) return subagentTypeLabel(thread.subagent.agent_type) ?? "Subagent"
  return "Helper thread"
}

export interface LineageRowViewProps {
  row: LineageRow<Thread>
  detailOpen: boolean
  onToggleDetail: (id: string) => void
  onToggleTree: (id: string, open: boolean) => void
  onRemoveWorktree: (thread: Thread) => void
}

export const LineageRowView = memo(function LineageRowView({ row, detailOpen, onToggleDetail, onToggleTree, onRemoveWorktree }: LineageRowViewProps) {
  const { thread, depth, childCount, open } = row
  const { model } = useSubagentModel(thread)
  const state = childState(thread)
  const stoppable = canStopDelegation(thread)
  const title = thread.title || "Untitled"
  const meta = [roleText(thread), model].filter(Boolean).join(" · ")
  const [fresh] = useState(() => Date.now() - Date.parse(thread.created_at) < 3000)
  const level = Math.min(depth, 3)
  return (
    <div role="listitem" data-lineage-row={thread.id} data-lineage-kind={row.kind} className={cn("px-1.5", fresh && "t-row-enter")}>
      <div className="group/lr relative rounded-[10px] hover:bg-[var(--color-background-button-secondary-hover)] focus-within:bg-[var(--color-background-button-secondary-hover)]">
        {Array.from({ length: level }, (_, index) => (
          <span key={index} aria-hidden className="pointer-events-none absolute inset-y-0 w-px bg-foreground/10" style={{ insetInlineStart: 12 + index * INDENT }} />
        ))}
        {childCount > 0 && (
          <button
            type="button"
            aria-label={`${open ? "Collapse" : "Expand"} ${childCount} ${childCount === 1 ? "agent" : "agents"} started by ${title}`}
            aria-expanded={open}
            onClick={() => onToggleTree(thread.id, !open)}
            className="absolute top-1.5 z-10 inline-flex size-5 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
            style={{ insetInlineStart: 3 + level * INDENT } as CSSProperties}
          >
            <DisclosureChevron open={open} />
          </button>
        )}
        <button
          type="button"
          aria-expanded={detailOpen}
          aria-label={`${title}, ${state.word}`}
          onClick={() => onToggleDetail(thread.id)}
          className="flex w-full min-w-0 cursor-pointer items-start gap-2 rounded-[10px] py-1.5 pe-2 text-start outline-hidden focus-visible:ring-2 focus-visible:ring-ring/60"
          style={{ paddingInlineStart: GUTTER + 4 + level * INDENT }}
        >
          <span className="sa-avatar sa-avatar--single mt-px shrink-0" aria-hidden>
            <ProviderMark kind={thread.provider.kind} size={12} className="size-3" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-[13px] leading-5 text-foreground/90" title={title}>{title}</span>
            <span className="sa-secondary flex min-w-0 items-center gap-1.5 text-xs leading-4 text-foreground/50">
              <ChildGlyph phase={state.phase} />
              <TextSwap text={state.word} className={cn("shrink-0", phaseWordClass(state.phase))} shimmer={state.phase === "working"} />
              <span aria-hidden className="shrink-0">·</span>
              <span className="min-w-0 truncate">{meta}</span>
            </span>
            <span className="flex min-w-0 flex-wrap items-center gap-1 pt-0.5 empty:hidden">
              <ChildFacts thread={thread} />
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1 pt-0.5">
            <span className={cn("flex min-w-[3.25rem] justify-end text-xs text-foreground/48 transition-opacity", stoppable && "group-hover/lr:opacity-0 group-focus-within/lr:opacity-0")}>
              <ChildElapsed thread={thread} />
            </span>
            <DisclosureChevron open={detailOpen} className="size-3 text-foreground/45 transition-colors group-hover/lr:text-foreground/80" />
          </span>
        </button>
        <span className="pointer-events-none absolute top-1.5 right-7 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/lr:pointer-events-auto group-hover/lr:opacity-100 group-focus-within/lr:pointer-events-auto group-focus-within/lr:opacity-100">
          <button type="button" aria-label={`Open ${title}`} title="Open" className={ACTION_CLASS} onClick={() => openThreadView(thread.id)}>
            <ArrowUpRightIcon />
          </button>
          {stoppable && (
            <button type="button" aria-label={`Stop ${title}`} title="Stop" className={ACTION_CLASS} onClick={() => void stopDelegatedChild(thread)}>
              <StopIcon />
            </button>
          )}
        </span>
      </div>
      <DisclosureRegion open={detailOpen}>
        <LineageDetail thread={thread} indent={GUTTER + 4 + level * INDENT + 28} onRemoveWorktree={onRemoveWorktree} />
      </DisclosureRegion>
    </div>
  )
})

// ---- detail ----

/** What the child returned, or why there is nothing yet. */
function ResultSection({ thread }: { thread: Thread }) {
  const info = thread.delegation
  const kind = lineageKind(thread)
  const text = (info?.result ?? thread.subagent?.result ?? "").trim()
  const error = (info?.error ?? "").trim()
  if (!text && !error) {
    const phase = childState(thread).phase
    const empty =
      kind === "helper"
        ? "Open the thread to see its work."
        : phase === "working" || phase === "waiting"
          ? "The result comes back to this thread when the agent finishes."
          : phase === "done"
            ? "The agent finished without a summary. Open it to see what it did."
            : "No result. Open the thread to see how far it got."
    return <p className="text-xs leading-5 text-foreground/55 text-pretty">{empty}</p>
  }
  return (
    <>
      {error && (
        <DetailSection label="Error">
          <p className="selectable text-xs leading-5 break-words text-destructive/90">{error}</p>
        </DetailSection>
      )}
      {text && (
        <DetailSection label="Result">
          <ClampedMarkdown text={text} />
        </DetailSection>
      )}
    </>
  )
}

function LineageDetail({ thread, indent, onRemoveWorktree }: { thread: Thread; indent: number; onRemoveWorktree: (thread: Thread) => void }) {
  const info = thread.delegation
  const stoppable = canStopDelegation(thread)
  const removable = canRemoveWorktree(info)
  return (
    <div className="flex min-w-0 flex-col gap-3 pe-2 pt-1 pb-2.5" style={{ paddingInlineStart: indent }}>
      <ResultSection thread={thread} />
      {info ? (
        <>
          <WorkspaceFacts info={info} />
          <FilesList files={info.files_touched ?? []} />
          <ConflictsList conflicts={info.conflicts} />
        </>
      ) : thread.worktree ? (
        <WorkspaceFacts info={{ workspace: "worktree", branch: thread.worktree.branch }} />
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        <Button variant="subtle" size="chip" onClick={() => openThreadView(thread.id)}>
          <ArrowUpRightIcon /> Open
        </Button>
        {stoppable && (
          <Button variant="subtle" size="chip" onClick={() => void stopDelegatedChild(thread)}>
            <StopIcon /> Stop
          </Button>
        )}
        {removable && (
          <Button variant="destructive-outline" size="chip" onClick={() => onRemoveWorktree(thread)}>
            <WorktreeIcon /> Remove worktree
          </Button>
        )}
      </div>
    </div>
  )
}
