// App rail: the narrow column of destinations beside the thread sidebar.
// Home (chats), Notes, Tasks, Pull requests, and Usage at the top; Settings at the foot, with
// the plan usage glance and, when a new release is ready, an update badge above it.
// It stays put when the sidebar collapses and while Settings is open, so every
// destination is one click away.

import type { ComponentType } from "react"

import { Kbd, KbdGroup } from "@/components/kit/kbd"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/kit/tooltip"
import { mod } from "@/lib/format"
import { AnalyticsIcon, GitPullRequestIcon, HomeIcon, ListChecksIcon, NoteIcon, SettingsIcon } from "@/lib/kit/icons"
import { useSlidingPill } from "@/lib/kit/slidingPill"
import { cn } from "@/lib/utils"
import { useNotes } from "@/state/notes"
import { loadThread } from "@/state/rpc"
import { useStore } from "@/state/store"
import { useTasks } from "@/state/tasks"
import { RailUpdateButton } from "@/views/AppUpdate"
import { RailUsage } from "@/views/RailUsage"

type Destination = "home" | "notes" | "tasks" | "pulls" | "usage"

export function NavRail() {
  const settingsOpen = useStore((s) => s.settingsOpen)
  const selectedDestination = useStore((s): Destination => (s.selected.kind === "pulls" ? "pulls" : s.selected.kind === "usage" ? "usage" : s.selected.kind === "notes" ? "notes" : s.selected.kind === "tasks" ? "tasks" : "home"))
  const destination = settingsOpen ? null : selectedDestination
  // A run finished and waits for review: a small dot on Tasks.
  const reviewWaiting = useTasks((s) => Object.values(s.tasks).some((task) => task.status === "needs_review"))
  const [railRef, pillStyle, pillReady] = useSlidingPill<HTMLDivElement>(destination ?? selectedDestination)

  const go = (to: Destination) => {
    const store = useStore.getState()
    store.set({ settingsOpen: false })
    if (to === "notes") {
      // Back on Notes, reopen the note that was open when the page was left.
      return store.selectNotes(store.selected.kind === "notes" ? store.selected.noteId : useNotes.getState().lastOpenId)
    }
    if (to === "tasks") return store.selectTasks()
    if (to === "pulls") return store.selectPulls()
    if (to === "usage") return store.selectUsage()
    // From Settings, Home returns to whatever the workspace was showing.
    if (!settingsOpen || selectedDestination !== "home") store.selectHome()
    const selected = useStore.getState().selected
    if (selected.kind === "thread") void loadThread(selected.id)
  }

  return (
    <nav
      aria-label="App"
      data-tauri-drag-region="deep"
      className="app-nav-rail drag-region relative z-10 hidden h-dvh w-[var(--app-rail-width)] shrink-0 flex-col items-center pb-3 font-system-ui md:flex"
    >
      {/* Title bar zone: the traffic lights sit here. */}
      <div className="h-[46px] w-full shrink-0" aria-hidden="true" />
      <div ref={railRef} data-tauri-drag-region="false" className="t-tabs no-drag flex flex-col items-center gap-1.5 rounded-[10px] pt-1.5">
        <span aria-hidden="true" data-ready={pillReady} style={pillStyle} className={cn("t-tabs-pill z-0 bg-[var(--app-rail-active)]", !destination && "opacity-0")} />
        <RailButton icon={HomeIcon} label="Home" active={destination === "home"} onClick={() => go("home")} />
        <RailButton icon={NoteIcon} label="Notes" active={destination === "notes"} onClick={() => go("notes")} />
        <RailButton icon={ListChecksIcon} label="Tasks" active={destination === "tasks"} badge={reviewWaiting && destination !== "tasks"} onClick={() => go("tasks")} />
        <RailButton icon={GitPullRequestIcon} label="Pull requests" active={destination === "pulls"} onClick={() => go("pulls")} />
        <RailButton icon={AnalyticsIcon} label="Usage" active={destination === "usage"} onClick={() => go("usage")} />
      </div>
      <div data-tauri-drag-region="false" className="no-drag mt-auto flex flex-col items-center gap-1.5">
        <RailUsage />
        <RailUpdateButton />
        <RailButton icon={SettingsIcon} label="Settings" shortcut={[mod, ","]} active={settingsOpen} activeFill onClick={() => useStore.getState().set(settingsOpen ? { settingsOpen: false } : { settingsOpen: true, settingsTab: "general" })} />
      </div>
    </nav>
  )
}

function RailButton({
  icon: Icon,
  label,
  active = false,
  activeFill = false,
  badge = false,
  shortcut,
  onClick,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  active?: boolean
  /** Paint its own active fill; buttons in the sliding group share the pill. */
  activeFill?: boolean
  /** A small accent dot: something here wants attention. */
  badge?: boolean
  shortcut?: string[]
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-current={active ? "page" : undefined}
            data-tab-active={(active && !activeFill) || undefined}
            onClick={onClick}
            className={cn(
              "press relative z-[1] inline-flex size-9 cursor-pointer items-center justify-center rounded-[10px] outline-hidden",
              "focus-visible:ring-1 focus-visible:ring-ring",
              active
                ? cn("text-[var(--color-text-foreground)]", activeFill && "bg-[var(--app-rail-active)]")
                : "text-[var(--app-rail-idle)] hover:bg-[var(--app-rail-hover)] hover:text-[var(--color-text-foreground)]",
            )}
          />
        }
      >
        <Icon className="size-[18px] shrink-0" />
        {badge && <span aria-hidden className="tk-rail-badge" />}
      </TooltipTrigger>
      <TooltipPopup side="right" sideOffset={6}>
        <span className="flex items-center gap-2">
          {label}
          {shortcut && (
            <KbdGroup>
              {shortcut.map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </KbdGroup>
          )}
        </span>
      </TooltipPopup>
    </Tooltip>
  )
}
