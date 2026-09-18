// FILE: NotificationBell.tsx
// Purpose: Sidebar-header notification toggle. The bell filters the sidebar down
//          to just the threads that need attention — agents that finished (done),
//          failed, or are waiting on the user and haven't been opened since. An
//          urgency dot reflects the most-urgent pending state. Toggle off to
//          restore the full project/thread list.

import { useMemo } from "react"
import { BellIcon, CheckIcon } from "@/lib/kit/icons"
import { sidebarIconButtonSlotClass } from "@/components/kit/SidebarIconButton"
import { sidebarGlyphClass } from "@/components/kit/sidebarGlyphs"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/kit/tooltip"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { useStore } from "@/state/store"
import { selectAttentionItems, type NotificationKind } from "@/state/notifications"
import { cn } from "@/lib/utils"

// Reuse the sidebar StatusGlyph colour language: amber = waiting on you,
// destructive = failed, emerald = finished.
const KIND_DOT: Record<NotificationKind, string> = {
  blocked: "bg-amber-500 dark:bg-amber-300/90",
  failed: "bg-destructive",
  done: "bg-emerald-500 dark:bg-emerald-400/90",
}

export function NotificationBell() {
  const notifications = useStore((s) => s.notifications)
  const threads = useStore((s) => s.threads)
  const active = useStore((s) => s.notificationFilter)
  const clearAllNotifications = useStore((s) => s.clearAllNotifications)

  const items = useMemo(() => selectAttentionItems({ threads, notifications }), [threads, notifications])
  const completedCount = Object.keys(notifications).length
  const count = items.length
  const topKind = items[0]?.kind

  const label = active ? "Show all threads" : "Show threads that need attention"

  return (
    <ContextMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <ContextMenuTrigger
              render={
                <button
                  type="button"
                  aria-label={label}
                  aria-pressed={active}
                  onClick={() => useStore.getState().set((s) => ({ notificationFilter: !s.notificationFilter }))}
                  className={cn(
                    "sidebar-icon-button relative inline-flex shrink-0 cursor-pointer items-center justify-center transition-colors",
                    active
                      ? "bg-[var(--sidebar-accent-active)] text-foreground"
                      : "text-foreground/80 hover:bg-[var(--sidebar-accent)] hover:text-foreground",
                    sidebarIconButtonSlotClass("header"),
                  )}
                >
                  <BellIcon className={sidebarGlyphClass("leading")} />
                  {count > 0 && topKind && (
                    <span
                      aria-hidden
                      data-slot="notification-dot"
                      className={cn(
                        "absolute top-0.5 right-0.5 size-2 rounded-full",
                        KIND_DOT[topKind],
                      )}
                    />
                  )}
                </button>
              }
            />
          }
        />
        <TooltipPopup side="bottom">
          {active ? "Show all threads" : count > 0 ? `${count} need attention` : "Threads that need attention"}
        </TooltipPopup>
      </Tooltip>
      <ContextMenuContent align="end" side="bottom" className="w-56">
        <ContextMenuGroup>
          <ContextMenuLabel>Notifications</ContextMenuLabel>
          <ContextMenuItem onClick={() => useStore.getState().set((s) => ({ notificationFilter: !s.notificationFilter }))}>
            <BellIcon /> {active ? "Show all threads" : "Show notifications"}
          </ContextMenuItem>
          <ContextMenuItem disabled={completedCount === 0} onClick={clearAllNotifications}>
            <CheckIcon /> Dismiss completed
          </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  )
}
