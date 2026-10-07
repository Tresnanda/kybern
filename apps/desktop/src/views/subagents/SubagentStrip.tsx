// The composer strip for provider subagents: one row per subagent with its state, name,
// type and model, and time. Hover or focus swaps the time for Run in background and Stop.
// Replaces the generic "N agents working · View activity" panel for agent tasks; processes
// and monitors keep that panel.

import { useEffect, useMemo, useState, type ReactNode } from "react"

import {
  isSubagentQueued,
  stoppableSubagents,
  stripLabel,
  stripSubagents,
  subagentRowLabel,
  subagentThreadPhase,
  subagentTypeLabel,
} from "../../../../../packages/kybern-client/src/subagents.ts"
import { DisclosureRegion } from "@/components/kit/DisclosureRegion"
import { Button } from "@/components/kit/button"
import { IconButton } from "@/components/kit/icon-button"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/kit/tooltip"
import { ComposerStackedPanel, COMPOSER_STACKED_PANEL_DIVIDER_CLASS_NAME } from "@/components/kit/chat/ComposerStackedPanel"
import {
  COMPOSER_STACKED_PANEL_HEADER_ROW_CLASS_NAME,
  COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME,
  COMPOSER_STACKED_PANEL_SCROLL_REGION_CLASS_NAME,
} from "@/components/kit/chat/composerStackedPanelStyles"
import { BackgroundTrayIcon, ChevronDownIcon, StopIcon } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"
import type { Thread, ThreadId } from "@/protocol"
import { openThreadView, runSubagentInBackground, stopAllSubagents, stopOneSubagent, useSubagentChildren, useSubagentModel } from "@/state/subagents"
import { SubagentHoverCard } from "./SubagentHoverCard"
import { ProviderAvatarStack, SubagentElapsed, SubagentGlyph } from "./parts"
import { ProviderMark } from "@/components/kybern/bits"

/** Keep a panel mounted for `ms` after it should go, so it can fade out. */
function usePresence(present: boolean, ms: number): { mounted: boolean; leaving: boolean } {
  const [mounted, setMounted] = useState(present)
  if (present && !mounted) setMounted(true)
  useEffect(() => {
    if (present || !mounted) return
    const timer = window.setTimeout(() => setMounted(false), ms)
    return () => window.clearTimeout(timer)
  }, [present, mounted, ms])
  return { mounted: present || mounted, leaving: !present && mounted }
}

/**
 * The strip for a thread. It subscribes to the child threads itself, so progress updates
 * re-render the strip and nothing above it. `fallback` shows when agents are working but no
 * child thread is known for them (a harness or a history from before child threads).
 */
export function SubagentStrip({
  threadId,
  turnRunning,
  turnId,
  hasActiveAgentTasks,
  fallback,
}: {
  threadId: ThreadId
  turnRunning: boolean
  turnId: string | null
  hasActiveAgentTasks: boolean
  fallback: ReactNode
}) {
  const children = useSubagentChildren(threadId)
  const strip = useMemo(() => stripSubagents(children, { turnRunning, turnId }), [children, turnRunning, turnId])
  // Hold the last rows through the exit so the strip fades with its content.
  const [held, setHeld] = useState(strip)
  if (strip && strip !== held) setHeld(strip)
  const { mounted, leaving } = usePresence(!!strip, 200)
  const shown = strip ?? held
  if (!strip && hasActiveAgentTasks && !mounted) return <>{fallback}</>
  if (!mounted || !shown) return null
  return <StripBody rows={shown.rows} working={shown.working} leaving={leaving} />
}

function StripBody({ rows, working, leaving }: { rows: Thread[]; working: number; leaving: boolean }) {
  const [collapsed, setCollapsed] = useState(false)
  const stoppable = stoppableSubagents(rows)
  return (
    <ComposerStackedPanel className={cn(leaving ? "sa-strip-leave" : "t-panel-enter")} data-subagent-strip="">
      <div className={COMPOSER_STACKED_PANEL_HEADER_ROW_CLASS_NAME}>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-xs">
          <ProviderAvatarStack kinds={rows.map((thread) => thread.provider.kind)} />
          <span className="truncate font-medium text-foreground/85">{stripLabel(rows.length, working)}</span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {stoppable.length >= 2 && (
            <Tooltip>
              <TooltipTrigger render={<Button variant="ghost" size="chip" onClick={() => void stopAllSubagents(stoppable)} />}>
                <StopIcon /> Stop all
              </TooltipTrigger>
              <TooltipPopup side="top">
                <p>Stop all subagents</p>
              </TooltipPopup>
            </Tooltip>
          )}
          <IconButton
            variant="ghost"
            size="icon-chip"
            className={COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME}
            label={collapsed ? "Expand subagents" : "Collapse subagents"}
            tooltip={collapsed ? "Expand subagents" : "Collapse subagents"}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((value) => !value)}
          >
            <ChevronDownIcon className={cn("transition-transform duration-200 ease-out motion-reduce:transition-none", !collapsed && "rotate-180")} />
          </IconButton>
        </div>
      </div>
      <DisclosureRegion open={!collapsed}>
        <div className={cn(COMPOSER_STACKED_PANEL_SCROLL_REGION_CLASS_NAME, COMPOSER_STACKED_PANEL_DIVIDER_CLASS_NAME, "px-1 py-[3px]")}>
          {rows.map((thread) => (
            <StripRow key={thread.id} thread={thread} />
          ))}
        </div>
      </DisclosureRegion>
    </ComposerStackedPanel>
  )
}

/** Run in background and Stop are 22px to the eye with a 28px target, like the kit button on touch. */
const ROW_ACTION_CLASS =
  "relative flex size-[22px] cursor-pointer items-center justify-center rounded-md text-foreground/48 outline-hidden transition-colors after:absolute after:-inset-[3px] hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-3"

function StripRow({ thread }: { thread: Thread }) {
  const info = thread.subagent!
  const { model } = useSubagentModel(thread)
  const phase = subagentThreadPhase(thread)
  const working = phase === "working"
  const meta = [subagentTypeLabel(info.agent_type), model].filter(Boolean).join(" · ")
  const canBackground = working && info.capabilities?.background === true && !info.backgrounded
  const canStop = working && info.capabilities?.stop !== false
  const [now] = useState(() => Date.now())
  const row = (
    <button
      type="button"
      data-subagent-strip-open={thread.id}
      aria-label={subagentRowLabel(thread, now)}
      onClick={() => openThreadView(thread.id)}
      className={cn("flex min-h-7 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-[7px] py-1 ps-1.5 text-start text-[length:var(--app-font-size-ui,12px)] leading-[1.4] outline-hidden focus-visible:ring-2 focus-visible:ring-ring/60", info.backgrounded && working && "@max-[24em]/sa-row:flex-wrap")}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <ProviderMark kind={thread.provider.kind} size={14} className="size-3.5 shrink-0" />
        <SubagentGlyph thread={thread} />
        <span data-subagent-strip-title="" title={thread.title || "Subagent"} className="min-w-0 max-w-[55%] truncate font-medium text-foreground/85">{thread.title || "Subagent"}</span>
        <span className="sa-secondary min-w-0 flex-1 truncate text-foreground/45">{meta}</span>
      </span>
      {info.backgrounded && working && (
        <span data-subagent-strip-background="" className="sa-secondary inline-flex min-w-0 shrink-0 items-center gap-1 whitespace-nowrap text-foreground/45 @max-[24em]/sa-row:basis-full @max-[24em]/sa-row:whitespace-normal">
          <BackgroundTrayIcon className="size-3 shrink-0" /><span className="min-w-0">In background</span>
        </span>
      )}
    </button>
  )
  return (
    <div data-subagent-strip-row={thread.id} className="@container/sa-row group/sa-sr relative flex min-h-7 items-stretch rounded-[7px] text-[length:var(--app-font-size-ui,12px)] hover:bg-[var(--color-background-button-secondary-hover)] focus-within:bg-[var(--color-background-button-secondary-hover)]">
      <SubagentHoverCard thread={thread} trigger={row} side="top" align="start" />
      <div className="grid min-w-[52px] shrink-0 grid-cols-[max-content] text-[length:var(--app-font-size-ui,12px)] leading-[1.4]">
        <span
          data-subagent-strip-time=""
          className={cn(
            "col-start-1 row-start-1 flex items-center justify-end ps-2 pe-1.5 whitespace-nowrap text-foreground/48 transition-opacity",
            (canStop || canBackground) && "group-hover/sa-sr:pointer-events-none group-hover/sa-sr:opacity-0 group-focus-within/sa-sr:pointer-events-none group-focus-within/sa-sr:opacity-0",
          )}
        >
          {isSubagentQueued(thread) ? null : <SubagentElapsed thread={thread} />}
        </span>
        {(canStop || canBackground) && (
          <span className="pointer-events-none col-start-1 row-start-1 me-0.5 flex items-center justify-self-end gap-0.5 opacity-0 transition-opacity group-hover/sa-sr:pointer-events-auto group-hover/sa-sr:opacity-100 group-focus-within/sa-sr:pointer-events-auto group-focus-within/sa-sr:opacity-100">
            {canBackground && (
              <button type="button" aria-label={`Run ${thread.title || "subagent"} in background`} title="Run in background" className={ROW_ACTION_CLASS} onClick={() => void runSubagentInBackground(thread)}>
                <BackgroundTrayIcon />
              </button>
            )}
            {canStop && (
              <button type="button" aria-label={`Stop ${thread.title || "subagent"}`} title="Stop" className={ROW_ACTION_CLASS} onClick={() => void stopOneSubagent(thread)}>
                <StopIcon />
              </button>
            )}
          </span>
        )}
      </div>
    </div>
  )
}
