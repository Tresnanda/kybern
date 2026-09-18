// FILE: NotificationBell.tsx
// Purpose: Sidebar-header notification center. A bell with an urgency dot that
//          opens a popover listing only the threads needing attention — agents
//          that finished, failed, or are waiting on the user and haven't been
//          opened since. Opening a thread clears its entry.

import { useMemo } from "react"
import type { ThreadId } from "@/protocol"
import { BellIcon } from "@/lib/kit/icons"
import { Popover, PopoverClose, PopoverPopup, PopoverTrigger } from "@/components/kit/popover"
import { sidebarIconButtonSlotClass } from "@/components/kit/SidebarIconButton"
import { sidebarGlyphClass } from "@/components/kit/sidebarGlyphs"
import { useStore } from "@/state/store"
import { loadThread } from "@/state/rpc"
import { selectAttentionItems, type NotificationKind } from "@/state/notifications"
import { relativeTime } from "@/lib/format"
import { cn } from "@/lib/utils"

const KIND_LABEL: Record<NotificationKind, string> = {
  blocked: "Needs you",
  failed: "Failed",
  done: "Done",
}

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
  const projects = useStore((s) => s.projects)
  const clearAll = useStore((s) => s.clearAllNotifications)

  const items = useMemo(() => selectAttentionItems({ threads, notifications }), [threads, notifications])
  const count = items.length
  const topKind = items[0]?.kind

  function openThread(id: ThreadId) {
    useStore.getState().selectThread(id) // clears this thread's notification
    void loadThread(id)
  }

  return (
    <Popover>
      <PopoverTrigger
        aria-label={count > 0 ? `Notifications, ${count} need attention` : "Notifications"}
        title="Notifications"
        className={cn(
          "sidebar-icon-button relative inline-flex shrink-0 cursor-pointer items-center justify-center",
          "text-foreground/80 transition-colors hover:text-foreground",
          sidebarIconButtonSlotClass("header"),
        )}
      >
        <BellIcon className={sidebarGlyphClass("leading")} />
        {count > 0 && topKind && (
          <span
            aria-hidden
            className={cn(
              "absolute top-0.5 right-0.5 size-2 rounded-full ring-2 ring-[var(--sidebar,var(--background))]",
              KIND_DOT[topKind],
            )}
          />
        )}
      </PopoverTrigger>
      <PopoverPopup align="end" side="bottom">
        <div className="w-80 max-w-[85vw]">
          <header className="flex items-center justify-between gap-2 px-1 pb-2">
            <span className="font-medium text-[length:var(--app-font-size-ui-lg,13px)] text-foreground">Notifications</span>
            {count > 0 && (
              <button
                type="button"
                onClick={() => clearAll()}
                className="rounded text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground transition-colors hover:text-foreground"
              >
                Mark all read
              </button>
            )}
          </header>
          {count === 0 ? (
            <div className="px-1 py-6 text-center">
              <p className="text-[length:var(--app-font-size-ui,12px)] text-foreground">You're all caught up</p>
              <p className="mt-1 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
                Agents that finish, fail, or need you show up here.
              </p>
            </div>
          ) : (
            <ul className="-mx-2 flex flex-col">
              {items.map((item) => {
                const project = projects[item.thread.project_id]
                return (
                  <li key={item.thread.id}>
                    <PopoverClose
                      onClick={() => openThread(item.thread.id)}
                      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-[var(--sidebar-accent)] focus-visible:bg-[var(--sidebar-accent)]"
                    >
                      <span className={cn("mt-1.5 size-1.5 shrink-0 self-start rounded-full", KIND_DOT[item.kind])} aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[length:var(--app-font-size-ui,12px)] text-foreground/95">
                          {item.thread.title || "Untitled thread"}
                        </span>
                        <span className="mt-0.5 block truncate text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
                          {KIND_LABEL[item.kind]}
                          {project ? ` · ${project.name}` : ""} · {relativeTime(item.at)}
                        </span>
                      </span>
                    </PopoverClose>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  )
}
