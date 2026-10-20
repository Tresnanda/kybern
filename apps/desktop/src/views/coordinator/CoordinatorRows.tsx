// Quiet transcript rows of the self-setting-up Coordinator: Kybern's own "Setup started"
// row (a `system_row` part, never a bubble) and the one line a settled Coordinator card
// leaves behind ("Saved the project brief", "Pushed fix/x", "Merged PR #12").
import { memo } from "react"
import { IconSwap } from "@/components/kybern/motion"

import { CheckIcon, CircleAlertIcon, GitMergeIcon, GitPullRequestIcon, NoteIcon, PushIcon, SettingsIcon } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"
import type { ApprovalDecision, SystemRowKind } from "@/protocol"
import { cardPartsText, coordinatorCardOutcome, type CardTextPart, type CoordinatorCardKind } from "../../../../../packages/kybern-client/src/coordinatorCards"

// The transcript's own inline-code chip, as the secret request line uses it.
const CARD_CODE_CLASS = "rounded-[0.4rem] bg-[var(--app-chat-code-surface)] px-[0.35em] py-px font-[family-name:var(--font-chat-code-family)] text-[0.92em] text-foreground/90"

/** Text with branch names set as code. */
export function CardText({ parts }: { parts: readonly CardTextPart[] }) {
  return <>{parts.map((part, index) => (part.code ? <code key={index} className={CARD_CODE_CLASS}>{part.text}</code> : <span key={index}>{part.text}</span>))}</>
}

/** A row Kybern adds to the conversation: centered, quiet, with hairlines to either side. */
export const SystemRowLine = memo(function SystemRowLine({ text, kind }: { text: string; kind: SystemRowKind }) {
  return (
    <div role="note" data-system-row={kind} className="flex w-full items-center gap-3 font-system-ui text-[length:var(--app-font-size-ui-sm,11.5px)] text-muted-foreground/75">
      <span aria-hidden className="h-px flex-1 bg-[color:var(--app-surface-divider)]" />
      <span className="shrink-0">{text}</span>
      <span aria-hidden className="h-px flex-1 bg-[color:var(--app-surface-divider)]" />
    </div>
  )
})

function lineIcon(kind: CoordinatorCardKind) {
  switch (kind) {
    case "brief":
      return <NoteIcon className="size-4" />
    case "settings":
      return <SettingsIcon className="size-4" />
    case "open_pr":
      return <GitPullRequestIcon className="size-4" />
    case "merge_pr":
      return <GitMergeIcon className="size-4" />
    default:
      return <PushIcon className="size-4" />
  }
}

/** A settled Coordinator card, in the same shape as the other approval lines. */
export const CoordinatorCardLine = memo(function CoordinatorCardLine({ kind, parts, decision, style }: { kind: CoordinatorCardKind; parts: readonly CardTextPart[]; decision: ApprovalDecision | null; style?: React.CSSProperties }) {
  const outcome = coordinatorCardOutcome(decision)
  const text = cardPartsText(parts)
  return (
    <div className="rounded-lg py-1" data-coordinator-card-outcome={outcome}>
      <div className="flex w-full min-w-0 items-center gap-2">
        <span className={cn("flex size-5 shrink-0 items-center justify-center", outcome === "declined" ? "text-destructive/85" : "text-muted-foreground")}>
          <IconSwap tempo="quick" className="size-4" active={outcome === "done" || outcome === "declined" || outcome === "ended" ? "b" : "a"} a={lineIcon(kind)} b={outcome === "done" ? <CheckIcon className="size-4 text-[var(--color-success)]" /> : <CircleAlertIcon className="size-4" />} />
        </span>
        <p className={cn("min-w-0 truncate leading-6", outcome === "declined" ? "text-destructive/85" : outcome === "done" ? "text-foreground/80" : "text-muted-foreground")} style={style} title={text}>
          <CardText parts={parts} />
        </p>
      </div>
    </div>
  )
})
