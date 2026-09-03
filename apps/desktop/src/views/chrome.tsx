// Shared header chrome, mirroring Synara's ChatHeader / chatHeaderControls
// constants: a 46px bar with a 1px gradient divider, the sidebar toggle and
// back/forward cluster that moves into the route header when the sidebar is
// collapsed, and the dock toggle.

import { IoIosArrowRoundBack, IoIosArrowRoundForward } from "react-icons/io"

import { Button } from "@/components/synara/button"
import { useSidebar } from "@/components/synara/sidebar"
import { Toggle } from "@/components/synara/toggle"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/synara/tooltip"
import { LayoutSidebarIcon, PanelRightCloseIcon, WindowIcon } from "@/lib/synara/icons"
import { mod } from "@/lib/format"
import { isTauri, platform } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import { useStore } from "@/state/store"

export const CHAT_SURFACE_HEADER_ROW_CLASS_NAME = "flex shrink-0 items-center h-[46px] chat-surface-divider"
export const CHAT_SURFACE_HEADER_PADDING_X_CLASS = "px-3 sm:px-5"
export const CHAT_SURFACE_CHIP_CLASS_NAME =
  "!h-7 shrink-0 rounded-lg gap-1.5 border-0 px-1.5 text-[length:var(--app-font-size-ui-sm,11px)] font-normal transition-colors text-[var(--color-text-foreground-secondary)] hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)]"
export const CHAT_HEADER_TOGGLE_CLASS_NAME = `${CHAT_SURFACE_CHIP_CLASS_NAME} data-pressed:text-[var(--color-text-foreground)]`

/** Sidebar toggle + back/forward, as Synara's SidebarLeadingControls. */
export function SidebarLeadingControls({ className }: { className?: string }) {
  const { toggleSidebar } = useSidebar()
  return (
    <div className={cn("flex shrink-0 items-center gap-0.5", className)}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-7 shrink-0 text-muted-foreground/75 hover:text-foreground"
              aria-label="Toggle thread sidebar"
              onClick={toggleSidebar}
            />
          }
        >
          <LayoutSidebarIcon className="size-4" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Toggle sidebar ({mod}B)</TooltipPopup>
      </Tooltip>
      {isTauri() && (
        <div className="flex shrink-0 items-center gap-0.5 [-webkit-app-region:no-drag]">
          <Button variant="ghost" size="icon-xs" className="size-7" aria-label="Back" onClick={() => history.back()}>
            <IoIosArrowRoundBack className="size-5" />
          </Button>
          <Button variant="ghost" size="icon-xs" className="size-7" aria-label="Forward" onClick={() => history.forward()}>
            <IoIosArrowRoundForward className="size-5" />
          </Button>
        </div>
      )}
    </div>
  )
}

/** The leading cluster shows in the route header only while the sidebar is collapsed. */
export function SidebarHeaderNavigationControls() {
  const { open } = useSidebar()
  if (open) return null
  return <SidebarLeadingControls className="hidden md:flex" />
}

export function DockToggle() {
  const rightOpen = useStore((s) => s.rightOpen)
  const set = useStore((s) => s.set)
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            variant="default"
            size="xs"
            pressed={rightOpen}
            onPressedChange={(pressed) => set({ rightOpen: pressed })}
            aria-label="Toggle right sidebar"
            className={cn(CHAT_HEADER_TOGGLE_CLASS_NAME, "!size-7 [&_svg,&_[data-slot=central-icon]]:mx-0")}
          />
        }
      >
        <PanelRightCloseIcon className="size-4 shrink-0 opacity-70" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">{rightOpen ? "Close right sidebar" : "Open right sidebar"}</TooltipPopup>
    </Tooltip>
  )
}

/** Toggles the floating Environment card, as Synara's EnvironmentToggle. */
export function EnvironmentToggle() {
  const envOpen = useStore((s) => s.envOpen)
  const set = useStore((s) => s.set)
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            variant="default"
            size="xs"
            pressed={envOpen}
            onPressedChange={(pressed) => set({ envOpen: pressed })}
            aria-label="Toggle environment panel"
            className={cn(CHAT_HEADER_TOGGLE_CLASS_NAME, "!size-7 [&_svg,&_[data-slot=central-icon]]:mx-0")}
          />
        }
      >
        <WindowIcon className="size-4 shrink-0 opacity-70" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">Environment</TooltipPopup>
    </Tooltip>
  )
}

/**
 * Route header. `minimal` hides the title cluster (home / empty landing).
 * `environment` adds the Environment toggle before the dock toggle.
 * On macOS the traffic-light gutter applies whenever the sidebar is collapsed.
 */
export function SurfaceHeader({ minimal, environment, children, trailing }: { minimal?: boolean; environment?: boolean; children?: React.ReactNode; trailing?: React.ReactNode }) {
  const { open } = useSidebar()
  const gutter = !open && platform() === "macos"
  return (
    <div
      className={cn(
        CHAT_SURFACE_HEADER_ROW_CLASS_NAME,
        CHAT_SURFACE_HEADER_PADDING_X_CLASS,
        "drag-region font-system-ui",
        gutter && "desktop-top-bar-traffic-light-gutter",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div className={cn("flex min-w-0 flex-1 items-center overflow-hidden gap-2 sm:gap-3", !open && "gap-4")}>
          <SidebarHeaderNavigationControls />
          {!minimal && <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-2 [-webkit-app-region:no-drag]">
          {trailing}
          {environment && <EnvironmentToggle />}
          <DockToggle />
        </div>
      </div>
    </div>
  )
}
