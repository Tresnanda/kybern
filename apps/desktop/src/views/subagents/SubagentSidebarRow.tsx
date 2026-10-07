// A subagent nested under its parent in the sidebar. It exists while it works, and stays
// for as long as you are viewing it. When it finishes it holds a check for 600ms and then
// leaves: it rises 4px, fades and collapses over 200ms. A finished row also has a hover
// dismiss button. Read-only: no rename, pin, drag, archive or split.

import { useEffect, useState } from "react"

import {
  SUBAGENT_SIDEBAR_HOLD_MS,
  subagentThreadPhase,
} from "../../../../../packages/kybern-client/src/subagents.ts"
import { ProviderMark } from "@/components/kybern/bits"
import { IconSwap, TextSwap } from "@/components/kybern/motion"
import { DisclosureChevron } from "@/components/kit/DisclosureChevron"
import { SidebarIconButton } from "@/components/kit/SidebarIconButton"
import { ContextMenu, ContextMenuContent, ContextMenuGroup, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu"
import { BackToParentIcon, CheckIcon, StopIcon, XIcon } from "@/lib/kit/icons"
import { primeMarquee } from "@/lib/kit/marquee"
import { SIDEBAR_THREAD_ROW_BASE_CLASS_NAME, SIDEBAR_ROW_ACTIVE_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME, SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME, sidebarHoverRevealHideClassName } from "@/lib/kit/sidebarRowStyles"
import { cn } from "@/lib/utils"
import type { Thread } from "@/protocol"
import { useStore } from "@/state/store"
import { dismissSubagentRow, openParentOf, openThreadView, stopOneSubagent } from "@/state/subagents"

/** Indentation stops growing here; deeper rows keep the cap and show their guide lines. */
const MAX_DEPTH = 3
const LEAVE_MS = 220

export function SubagentSidebarRow({
  thread,
  depth,
  childCount,
  childrenOpen,
  onToggleChildren,
}: {
  thread: Thread
  depth: number
  childCount: number
  childrenOpen: boolean
  onToggleChildren: () => void
}) {
  const info = thread.subagent!
  const selected = useStore((state) => state.selected.kind === "thread" && state.selected.id === thread.id)
  const phase = subagentThreadPhase(thread)
  const working = phase === "working"
  const completedAt = info.completed_at ? Date.parse(info.completed_at) : NaN
  const [dismissing, setDismissing] = useState(false)
  // The hold elapsed for this completion. Derived state: viewing the row (or it working again)
  // ends the leave without an effect, and navigating away resumes it with no second hold.
  const [heldFor, setHeldFor] = useState<string | null>(null)
  const holdToken = String(info.completed_at ?? "")
  const level = Math.min(depth, MAX_DEPTH)
  const [fresh] = useState(() => Date.now() - Date.parse(info.started_at) < 3000)
  const leaving = dismissing || (!working && !selected && heldFor === holdToken)

  // A finished row that you are not viewing holds its check, then leaves.
  useEffect(() => {
    if (working || selected || dismissing || heldFor === holdToken) return
    const age = Number.isFinite(completedAt) ? Date.now() - completedAt : SUBAGENT_SIDEBAR_HOLD_MS
    const hold = Math.min(SUBAGENT_SIDEBAR_HOLD_MS, Math.max(0, SUBAGENT_SIDEBAR_HOLD_MS - age))
    const timer = window.setTimeout(() => setHeldFor(holdToken), hold)
    return () => window.clearTimeout(timer)
  }, [working, selected, dismissing, heldFor, holdToken, completedAt])
  useEffect(() => {
    if (!leaving) return
    const timer = window.setTimeout(() => dismissSubagentRow(thread.id), LEAVE_MS)
    return () => window.clearTimeout(timer)
  }, [leaving, thread.id])

  const approval = thread.status === "awaiting-approval"
  const showResult = !working
  const open = () => openThreadView(thread.id)

  return (
    <li className="sa-side-row" data-leaving={leaving || undefined} data-subagent-row="">
      <div className="min-h-0 overflow-hidden py-px">
        <ContextMenu>
          <ContextMenuTrigger render={<div className="group/menu-sub-item group/thread-row relative w-full" />}>
            {Array.from({ length: level }, (_, index) => (
              <span
                key={index}
                aria-hidden="true"
                className="pointer-events-none absolute -top-0.5 bottom-0 z-10 w-px bg-sidebar-foreground/15 contrast-more:bg-sidebar-foreground/40"
                style={{ insetInlineStart: 17 + index * 20 }}
              />
            ))}
            {childCount > 0 && (
              <button
                type="button"
                aria-label={`${childrenOpen ? "Collapse" : "Expand"} ${childCount} nested ${childCount === 1 ? "subagent" : "subagents"} of ${thread.title || "subagent"}`}
                aria-expanded={childrenOpen}
                onClick={onToggleChildren}
                className="absolute top-1/2 z-20 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                style={{ insetInlineStart: 5 + level * 20 }}
              >
                <DisclosureChevron open={childrenOpen} />
              </button>
            )}
            <div
              role="button"
              tabIndex={0}
              onClick={open}
              onKeyDown={(event) => event.key === "Enter" && open()}
              data-active={selected || undefined}
              data-marquee-host
              style={{ paddingInlineStart: 32 + level * 20 }}
              onPointerEnter={(event) => primeMarquee(event.currentTarget)}
              onFocus={(event) => primeMarquee(event.currentTarget)}
              aria-current={selected ? "page" : undefined}
              className={cn(
                SIDEBAR_THREAD_ROW_BASE_CLASS_NAME,
                fresh && "t-row-enter",
                "flex min-w-0 cursor-pointer items-center gap-2 overflow-hidden rounded-md pr-[1.75rem] text-sidebar-foreground outline-hidden [-webkit-user-drag:none]",
                selected ? SIDEBAR_ROW_ACTIVE_CLASS_NAME : cn(SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME),
              )}
            >
              <span className="relative inline-flex size-3 shrink-0 items-center justify-center">
                <ProviderMark kind={thread.provider.kind} size={12} className="size-3" />
              </span>
              <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                {/* A little quieter than its parent, so the parent stays dominant. */}
                <TextSwap text={thread.title || "Subagent"} className={cn("t-marquee flex-1 text-[length:var(--app-font-size-ui,12px)] leading-5", selected ? "text-foreground" : "text-foreground/82")} />
                {approval && <span className="t-pop shrink-0 text-[10px] font-medium text-amber-600 dark:text-amber-300/90">Pending</span>}
              </div>
            </div>
            {/* No glyph while it works: its presence says so, and the parent already shows the loader. */}
            <div className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center">
              <div className="relative flex shrink-0 items-center justify-end gap-[3px]">
                {/* Always mounted so the glyph swaps in through IconSwap the moment it settles. */}
                <span
                  role={showResult ? "img" : undefined}
                  aria-label={showResult ? (phase === "failed" ? "Failed" : phase === "stopped" ? "Stopped" : "Done") : undefined}
                  aria-hidden={showResult ? undefined : true}
                  className={cn("flex w-[15px] shrink-0 items-center justify-center leading-none", sidebarHoverRevealHideClassName("thread-row"))}
                >
                  <IconSwap
                    className="size-3"
                    active={showResult ? "b" : "a"}
                    a={null}
                    b={phase === "failed" ? <span className="size-1.5 rounded-full bg-destructive" /> : phase === "stopped" ? <StopIcon className="size-2 text-muted-foreground/45" /> : <CheckIcon className="size-3 text-muted-foreground/55" />}
                  />
                </span>
                {showResult && (
                  <div className="t-reveal pointer-events-none absolute inset-y-0 right-0 my-auto inline-flex translate-x-1 items-center opacity-0 group-hover/thread-row:translate-x-0 group-hover/thread-row:pointer-events-auto group-hover/thread-row:opacity-100 group-focus-within/thread-row:translate-x-0 group-focus-within/thread-row:pointer-events-auto group-focus-within/thread-row:opacity-100">
                    <SidebarIconButton
                      icon={XIcon}
                      label="Dismiss"
                      tooltip="Dismiss"
                      size="md"
                      iconClassName="size-[15px] shrink-0"
                      className="text-muted-foreground/45 hover:text-foreground/89"
                      onClick={(event) => {
                        event.stopPropagation()
                        setDismissing(true)
                      }}
                    />
                  </div>
                )}
              </div>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-48 min-w-48">
            <ContextMenuGroup>
              <ContextMenuItem onClick={open}>Open</ContextMenuItem>
              <ContextMenuItem onClick={() => void openParentOf(thread)}>
                <BackToParentIcon /> Open parent
              </ContextMenuItem>
              {working && info.capabilities?.stop !== false && (
                <ContextMenuItem onClick={() => void stopOneSubagent(thread)}>
                  <StopIcon /> Stop
                </ContextMenuItem>
              )}
            </ContextMenuGroup>
          </ContextMenuContent>
        </ContextMenu>
      </div>
    </li>
  )
}
