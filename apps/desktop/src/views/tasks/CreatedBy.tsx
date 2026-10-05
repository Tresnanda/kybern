// "From <thread>": where an agent filed a note or task. The link opens that chat;
// the glyph is the same fact in one mark for dense rows and cards, with the thread
// named in its tooltip. Titles come from the store; a thread this window has not
// loaded reads as "an agent thread" and is not a link.
import type { CSSProperties } from "react"

import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/kit/tooltip"
import { BotIcon } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"
import type { ThreadId } from "@/protocol"
import { useStore } from "@/state/store"
import { openRunThread } from "@/state/tasks"

const FALLBACK = "an agent thread"

/** The thread's title, or null while this window does not know the thread. */
function useCreatedByTitle(threadId: ThreadId | null | undefined): string | null {
  return useStore((s) => {
    if (!threadId) return null
    const thread = s.threads[threadId]
    if (!thread) return null
    return thread.title?.trim() || "Untitled thread"
  })
}

/** "From Fix the login flow", or "From an agent thread". */
function createdByLabel(title: string | null): string {
  return `From ${title ?? FALLBACK}`
}

export interface CreatedByThreadProps {
  /** The item's `created_by_thread`. Renders nothing when unset. */
  threadId: ThreadId | null | undefined
  /** `link`: glyph + "From <title>" text. `glyph`: the mark alone, the title in a tooltip. */
  variant?: "link" | "glyph"
  /**
   * Whether it opens the thread. Pass false inside another button (a card or a dock
   * row) so the whole row stays one target; the tooltip still names the thread.
   */
  interactive?: boolean
  className?: string
  style?: CSSProperties
}

/** Where an agent filed this note or task, opening that chat on click. */
export function CreatedByThread({ threadId, variant = "link", interactive = true, className, style }: CreatedByThreadProps) {
  const title = useCreatedByTitle(threadId)
  if (!threadId) return null
  const label = createdByLabel(title)
  const canOpen = interactive && title !== null
  const glyph = <BotIcon aria-hidden className={variant === "glyph" ? "size-3.5" : "size-3 shrink-0"} />

  if (variant === "link") {
    const content = (
      <>
        {glyph}
        <span className="min-w-0 truncate">{label}</span>
      </>
    )
    const base = cn("inline-flex min-w-0 max-w-full items-center gap-1", className)
    if (!canOpen) return <span className={base} style={style}>{content}</span>
    return (
      <button
        type="button"
        className={cn(base, "cursor-pointer rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring")}
        style={style}
        title={`Open ${title}`}
        onClick={(event) => {
          event.stopPropagation()
          openRunThread(threadId)
        }}
      >
        {content}
      </button>
    )
  }

  const trigger = canOpen ? (
    <button
      type="button"
      aria-label={`${label}. Open the thread`}
      className={cn(
        "inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-[5px] transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
      style={style}
      // Rows and cards open the task on click and start drags on pointer down.
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        openRunThread(threadId)
      }}
    />
  ) : (
    <span role="img" aria-label={label} className={cn("inline-flex shrink-0 items-center justify-center", className)} style={style} />
  )
  return (
    <Tooltip>
      <TooltipTrigger render={trigger}>{glyph}</TooltipTrigger>
      <TooltipPopup side="top">
        <p className="max-w-64 truncate">{label}</p>
      </TooltipPopup>
    </Tooltip>
  )
}
