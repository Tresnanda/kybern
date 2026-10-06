// Small pieces the Lineage pane and the delegation rows in a transcript share: the state glyph,
// quiet fact chips and the elapsed clock of a child thread.

import type { ReactNode } from "react"

import {
  childEndedAt,
  childStartedAt,
  conflictsLabel,
  diffstatLabel,
  filesLabel,
  shortBranch,
  workspaceLabel,
  type ChildPhase,
} from "../../../../../packages/kybern-client/src/delegations.ts"
import { ElapsedText } from "@/components/kybern/ElapsedText"
import { MatrixLoader } from "@/components/kybern/motion"
import { CheckIcon, CircleAlertIcon, EyeIcon, GitBranchIcon, HandRaisedIcon, StopIcon, TriangleAlertIcon, WorktreeIcon } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"
import type { Thread } from "@/protocol"

/** State as a shape: a loader while it works, a raised hand while it needs you, a check, an alert circle, a square or a quiet ring. */
export function ChildGlyph({ phase, className }: { phase: ChildPhase; className?: string }) {
  return (
    <span aria-hidden className={cn("flex size-3.5 shrink-0 items-center justify-center", className)}>
      {phase === "working" ? (
        <MatrixLoader variant="orbit" cycle={1600} className="text-foreground/70" />
      ) : phase === "waiting" ? (
        <HandRaisedIcon className="size-3.5 text-amber-600 dark:text-amber-300/90" />
      ) : phase === "done" ? (
        <CheckIcon className="size-3.5 text-muted-foreground/55" />
      ) : phase === "failed" ? (
        <CircleAlertIcon className="size-3.5 text-destructive" />
      ) : phase === "stopped" ? (
        <StopIcon className="size-2.5 text-muted-foreground/45" />
      ) : (
        <span className="size-2.5 rounded-full border border-foreground/30" />
      )}
    </span>
  )
}

/** Live clock of a child. Nothing when no start time is known. */
export function ChildElapsed({ thread, className }: { thread: Thread; className?: string }) {
  const startedAt = childStartedAt(thread)
  if (!startedAt) return null
  return <ElapsedText startedAt={startedAt} endedAt={childEndedAt(thread)} className={className} />
}

const CHIP_CLASS =
  "inline-flex h-[18px] min-w-0 max-w-full items-center gap-1 rounded-md bg-[var(--color-background-elevated-secondary)] px-1.5 text-[11px] leading-none whitespace-nowrap text-foreground/62 [&_svg]:size-3 [&_svg]:shrink-0"

export function Chip({ icon, children, tone = "quiet", title }: { icon?: ReactNode; children: ReactNode; tone?: "quiet" | "warning"; title?: string }) {
  return (
    <span title={title} className={cn(CHIP_CLASS, tone === "warning" && "bg-warning/10 text-foreground/80")}>
      {icon}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  )
}

/**
 * What a row says about where a child edits and what it changed, as quiet chips: the workspace,
 * the branch, files touched and conflicts. Native subagents say they are read-only instead.
 */
export function ChildFacts({ thread }: { thread: Thread }) {
  const info = thread.delegation
  if (!info) {
    if (thread.subagent) return <Chip icon={<EyeIcon />}>Read-only</Chip>
    return thread.worktree ? <Chip icon={<WorktreeIcon />} title={thread.worktree.path}>{shortBranch(thread.worktree.branch)}</Chip> : null
  }
  const files = info.files_touched?.length ?? 0
  const conflicts = info.conflicts?.length ?? 0
  const kept = info.workspace === "worktree" && info.worktree_state === "kept"
  return (
    <>
      <Chip icon={info.workspace === "worktree" ? <WorktreeIcon /> : undefined}>{kept ? "Worktree kept" : workspaceLabel(info)}</Chip>
      {info.workspace === "worktree" && info.branch && (
        <Chip icon={<GitBranchIcon />} title={info.branch}>{shortBranch(info.branch)}</Chip>
      )}
      {info.workspace === "worktree" && info.diffstat ? (
        <Chip>{diffstatLabel(info.diffstat)}</Chip>
      ) : files > 0 ? (
        <Chip>{filesLabel(files)}</Chip>
      ) : null}
      {conflicts > 0 && (
        <Chip tone="warning" icon={<TriangleAlertIcon className="text-warning" />}>{conflictsLabel(conflicts)}</Chip>
      )}
    </>
  )
}
