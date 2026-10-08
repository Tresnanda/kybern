// Small pieces shared by every subagent surface: the state glyph, the avatar stack, model
// text and the elapsed span of a subagent thread.

import { isSubagentQueued, subagentSpan, subagentThreadPhase } from "../../../../../packages/kybern-client/src/subagents.ts"
import { ProviderMark } from "@/components/kybern/bits"
import { ElapsedText } from "@/components/kybern/ElapsedText"
import { MatrixLoader } from "@/components/kybern/motion"
import { CheckIcon, CircleAlertIcon, StopIcon } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"
import type { ProviderKind, Thread } from "@/protocol"

/** The state glyph of a subagent: loader, check, alert circle or square. Shape plus word, never colour alone. */
export function SubagentGlyph({ thread, className }: { thread: Pick<Thread, "subagent">; className?: string }) {
  const phase = subagentThreadPhase(thread)
  const queued = isSubagentQueued(thread)
  return (
    <span aria-hidden className={cn("flex size-3.5 shrink-0 items-center justify-center", className)}>
      {phase === "working" ? (
        <MatrixLoader variant={queued ? "twinkle" : "orbit"} cycle={1600} className={cn(queued ? "text-muted-foreground/40" : "text-foreground/70")} />
      ) : phase === "done" ? (
        <CheckIcon className="size-3.5 text-muted-foreground/55" />
      ) : phase === "failed" ? (
        <CircleAlertIcon className="size-3.5 text-destructive" />
      ) : (
        <StopIcon className="size-2.5 text-muted-foreground/45" />
      )}
    </span>
  )
}

/** One mark per distinct provider, overlapped, at most three and then a +N disc. */
export function ProviderAvatarStack({ kinds, className }: { kinds: readonly ProviderKind[]; className?: string }) {
  const distinct = [...new Set(kinds)]
  const shown = distinct.slice(0, 3)
  const extra = distinct.length - shown.length
  return (
    <span aria-hidden className={cn("flex shrink-0 pl-0.5", className)}>
      {shown.map((kind, index) => (
        <span key={kind} className={cn("sa-avatar sa-avatar--stacked", index > 0 && "-ml-1.5")}>
          <ProviderMark kind={kind} size={12} className="size-3" />
        </span>
      ))}
      {extra > 0 && <span className="sa-avatar sa-avatar--stacked -ml-1.5 text-[10px] font-medium text-[var(--color-text-foreground-secondary)]">+{extra}</span>}
    </span>
  )
}

/** The elapsed span of a subagent thread. Nothing when the harness gave no start time. */
export function SubagentElapsed({ thread, className }: { thread: Pick<Thread, "subagent">; className?: string }) {
  const span = subagentSpan(thread)
  if (!span) return null
  return <ElapsedText startedAt={span.startedAt} endedAt={span.endedAt} className={cn("shrink-0 whitespace-nowrap", className)} />
}
