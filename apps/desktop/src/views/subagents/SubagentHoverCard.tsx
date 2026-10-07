// The card shown on hover over a subagent row (group member or strip row): name, model and
// effort, state and time, a three line prompt excerpt, the last tool call and usage.
// Mounted only while open. Pointer hover only; keyboard focus never opens it. The same
// information is on the subagent page, so nothing lives only here.

import { useEffect, useRef, useState, type ReactElement } from "react"

import {
  formatTokenCount,
  isSubagentQueued,
  subagentDetail,
  subagentPhaseWord,
  subagentThreadPhase,
  subagentTokenCount,
  subagentTypeLabel,
} from "../../../../../packages/kybern-client/src/subagents.ts"
import { ProviderMark } from "@/components/kybern/bits"
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "@/components/kit/preview-card"
import { runtimeActivityPrompt } from "@/lib/toolActivity"
import { HammerIcon } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"
import type { Thread } from "@/protocol"
import { useStore } from "@/state/store"
import { useSubagentModel } from "@/state/subagents"
import { SubagentElapsed } from "./parts"

const OPEN_DELAY_MS = 400
const CLOSE_DELAY_MS = 120
/** Moving from one row to the next within this window opens the next card at once, without motion. */
const SKIP_DELAY_MS = 350
let lastClosedAt = 0

function finePointerHover(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(hover: hover) and (pointer: fine)").matches
}

export function SubagentHoverCard({
  thread,
  trigger,
  side = "bottom",
  align = "start",
}: {
  thread: Thread
  trigger: ReactElement<Record<string, unknown>>
  side?: "top" | "bottom"
  align?: "start" | "center" | "end"
}) {
  const [open, setOpen] = useState(false)
  const [instant, setInstant] = useState(false)
  const timer = useRef(0)
  const clear = () => window.clearTimeout(timer.current)
  useEffect(() => clear, [])

  const close = (delay: number) => {
    clear()
    timer.current = window.setTimeout(() => {
      setOpen((current) => {
        if (current) lastClosedAt = Date.now()
        return false
      })
    }, delay)
  }
  const request = (next: boolean, reason: string) => {
    if (reason === "trigger-focus") return
    if (!next) return close(reason === "escape-key" || reason === "outside-press" ? 0 : CLOSE_DELAY_MS)
    clear()
    if (open || !finePointerHover()) return
    const skip = Date.now() - lastClosedAt < SKIP_DELAY_MS
    setInstant(skip)
    timer.current = window.setTimeout(() => setOpen(true), skip ? 0 : OPEN_DELAY_MS)
  }

  return (
    <PreviewCard open={open} onOpenChange={(next, details) => request(next, details.reason)}>
      <PreviewCardTrigger delay={0} closeDelay={0} render={trigger} />
      <PreviewCardPopup
        side={side}
        align={align}
        sideOffset={6}
        className={cn("w-80 rounded-xl bg-[var(--color-background-elevated-primary-opaque)] p-0", instant && "!transition-none")}
        onPointerEnter={clear}
        onPointerLeave={() => close(CLOSE_DELAY_MS)}
      >
        <SubagentCardBody thread={thread} />
      </PreviewCardPopup>
    </PreviewCard>
  )
}

/** The prompt the subagent was launched with: its own transcript if loaded, else the parent's launch call. */
function promptExcerpt(thread: Thread): string | null {
  const state = useStore.getState()
  const own = state.transcripts[thread.id]?.blocks.find((block) => block.kind === "user")
  if (own?.kind === "user") {
    const text = own.message.parts.map((part) => (part.type === "text" ? part.text : "")).join("").trim()
    if (text) return text
  }
  const callId = thread.subagent?.tool_call_id
  const parent = thread.parent_thread_id ? state.transcripts[thread.parent_thread_id]?.blocks : undefined
  const launch = callId ? parent?.find((block) => block.kind === "tool" && block.call.id === callId) : undefined
  return launch?.kind === "tool" ? runtimeActivityPrompt(launch.call) : null
}

function SubagentCardBody({ thread }: { thread: Thread }) {
  const { model, effort } = useSubagentModel(thread)
  const [prompt] = useState(() => promptExcerpt(thread))
  const info = thread.subagent!
  const phase = subagentThreadPhase(thread)
  const type = subagentTypeLabel(info.agent_type)
  const detail = subagentDetail(thread)
  const tokens = formatTokenCount(subagentTokenCount(thread))
  const toolCalls = info.stats?.tool_uses
  const lastTool = phase === "working" ? detail?.text : info.last_tool_name ? `Used ${info.last_tool_name}` : null
  const state = isSubagentQueued(thread) ? "Starting" : capitalize(subagentPhaseWord(thread))
  const footer = [tokens, typeof toolCalls === "number" && toolCalls > 0 ? `${toolCalls} tool ${toolCalls === 1 ? "call" : "calls"}` : null].filter(Boolean).join(" · ")
  return (
    <div className="px-3.5 py-3 text-xs leading-[18px]">
      <h4 className="truncate text-[13px] font-medium leading-[18px]">{thread.title || "Subagent"}</h4>
      <div className="mt-0.5 flex items-center gap-1.5 text-[var(--color-text-foreground-secondary)]">
        <ProviderMark kind={thread.provider.kind} size={12} className="size-3 shrink-0" />
        <span className="min-w-0 truncate">{[type, model, effort].filter(Boolean).join(" · ") || "Subagent"}</span>
        <span className="ml-auto shrink-0 tabular-nums">
          {state}
          {phase !== "working" || info.started_at ? " · " : ""}
          <SubagentElapsed thread={thread} />
        </span>
      </div>
      {prompt && (
        <p className="mt-2 line-clamp-3 border-t border-[color:var(--color-border)] pt-2 break-words text-[var(--color-text-foreground-secondary)]">{prompt}</p>
      )}
      {lastTool && (
        <p className={cn("mt-2 flex items-center gap-1.5 text-foreground/48", detail?.failed && "text-destructive/85")}>
          <HammerIcon className="size-3 shrink-0" />
          <span className="min-w-0 truncate">{lastTool}</span>
        </p>
      )}
      <div className="mt-2.5 flex justify-between text-[11px] text-foreground/40">
        <span>{footer}</span>
        <span>Click to open</span>
      </div>
    </div>
  )
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
