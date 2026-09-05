// Shared header chrome, mirroring Synara's ChatHeader / chatHeaderControls:
// a 46px bar, 28px controls on one baseline, and the sidebar-toggle +
// back/forward cluster that moves into the route header when the sidebar collapses.

import { forwardRef, type ComponentProps, type ReactNode } from "react"
import { IoIosArrowRoundBack, IoIosArrowRoundForward } from "react-icons/io"

import { Button } from "@/components/synara/button"
import { useSidebar } from "@/components/synara/sidebar"
import { Toggle } from "@/components/synara/toggle"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/synara/tooltip"
import { CHAT_SURFACE_HEADER_HEIGHT_PX } from "@/lib/synara/desktopChrome"
import { LayoutSidebarIcon, PanelRightCloseIcon, WindowIcon, type LucideIcon } from "@/lib/synara/icons"
import { mod } from "@/lib/format"
import { isTauri, platform } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import { useStore } from "@/state/store"

export const CHAT_SURFACE_HEADER_HEIGHT_CLASS: `h-[${typeof CHAT_SURFACE_HEADER_HEIGHT_PX}px]` =
  "h-[46px]"

export const CHAT_SURFACE_HEADER_PADDING_X_CLASS = "px-3 sm:px-5"

export const CHAT_SURFACE_HEADER_ROW_CLASS_NAME = cn(
  "flex shrink-0 items-center",
  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
  "chat-surface-divider",
)

/** Force header glyphs to full-strength ink. Base Button caps SVGs at opacity-80. */
export const CHAT_HEADER_ICON_STRENGTH_CLASS_NAME =
  "text-[var(--color-text-foreground)] [&_svg]:!opacity-100"

/** Fixed control height + radius for every header toolbar control. */
export const CHAT_HEADER_CONTROL_CLASS_NAME = "!h-7 shrink-0 rounded-lg"

export const CHAT_SURFACE_CONTROL_IDLE_TEXT_CLASS_NAME =
  "text-[var(--color-text-foreground-secondary)]"

export const CHAT_SURFACE_CONTROL_HOVER_CLASS_NAME =
  "hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)]"

/** 28px flat chip shared by header toggles and dock tabs. */
export const CHAT_SURFACE_CHIP_CLASS_NAME = cn(
  CHAT_HEADER_CONTROL_CLASS_NAME,
  "gap-1.5 border-0 px-1.5 text-[length:var(--app-font-size-ui-sm,11px)] font-normal transition-colors",
  CHAT_SURFACE_CONTROL_IDLE_TEXT_CLASS_NAME,
  CHAT_SURFACE_CONTROL_HOVER_CLASS_NAME,
)

export const CHAT_SURFACE_CHIP_GLYPH_CLASS_NAME = "size-3.5 shrink-0"

export const CHAT_SURFACE_CHIP_ICON_CLASS_NAME = cn(CHAT_SURFACE_CHIP_GLYPH_CLASS_NAME, "opacity-70")

export function SurfaceChipIcon({ icon: Icon, className }: { icon: LucideIcon; className?: string }) {
  return <Icon aria-hidden className={cn(CHAT_SURFACE_CHIP_ICON_CLASS_NAME, className)} />
}

export const CHAT_HEADER_TOGGLE_CLASS_NAME = cn(
  CHAT_SURFACE_CHIP_CLASS_NAME,
  "data-pressed:text-[var(--color-text-foreground)]",
)

export const CHAT_HEADER_ICON_CONTROL_CLASS_NAME =
  "!size-7 shrink-0 rounded-lg [&_svg,&_[data-slot=central-icon]]:mx-0"

export const DOCK_HEADER_ICON_BUTTON_CLASS = CHAT_HEADER_ICON_CONTROL_CLASS_NAME

export type ChatHeaderControlTone = "plain" | "outline"

export function chatHeaderControlVariant(tone: ChatHeaderControlTone): "chrome" | "chrome-outline" {
  return tone === "outline" ? "chrome-outline" : "chrome"
}

type ChatHeaderButtonProps = Omit<ComponentProps<typeof Button>, "variant" | "size"> & {
  tone?: ChatHeaderControlTone
}

/** Text (or text + icon) header control. Safe as a Menu/Tooltip `render` target. */
export const ChatHeaderButton = forwardRef<HTMLButtonElement, ChatHeaderButtonProps>(
  function ChatHeaderButton({ tone: toneProp, className, ...props }, ref) {
    const tone = toneProp ?? "outline"
    return (
      <Button
        {...props}
        ref={ref}
        size="xs"
        variant={chatHeaderControlVariant(tone)}
        className={cn(CHAT_HEADER_CONTROL_CLASS_NAME, CHAT_HEADER_ICON_STRENGTH_CLASS_NAME, className)}
      />
    )
  },
)

type ChatHeaderIconButtonProps = Omit<ComponentProps<typeof Button>, "variant" | "size" | "aria-label"> & {
  label: string
  tone?: ChatHeaderControlTone
  children?: ReactNode
}

/** Square icon-only header control. Composes with Tooltip/Menu `render` wrappers. */
export const ChatHeaderIconButton = forwardRef<HTMLButtonElement, ChatHeaderIconButtonProps>(
  function ChatHeaderIconButton({ label, tone: toneProp, className, children, ...props }, ref) {
    const tone = toneProp ?? "plain"
    return (
      <Button
        {...props}
        ref={ref}
        aria-label={label}
        size="icon-xs"
        variant={chatHeaderControlVariant(tone)}
        className={cn(CHAT_HEADER_ICON_CONTROL_CLASS_NAME, CHAT_HEADER_ICON_STRENGTH_CLASS_NAME, className)}
      >
        {children}
      </Button>
    )
  },
)

/** One footprint for the sidebar toggle and the back/forward arrows: 28px squares,
 *  no gap, secondary ink at full strength (Base Button dims SVGs to 80%). */
const SIDEBAR_TRIGGER_CLASS_NAME = cn(
  "!size-7 shrink-0 rounded-lg [&_svg]:!opacity-100 [&_svg,&_[data-slot=central-icon]]:mx-0",
  CHAT_SURFACE_CONTROL_IDLE_TEXT_CLASS_NAME,
  CHAT_SURFACE_CONTROL_HOVER_CLASS_NAME,
)

/** Sidebar toggle + back/forward, as Synara's SidebarLeadingControls. */
export function SidebarLeadingControls({ className }: { className?: string }) {
  const { toggleSidebar } = useSidebar()
  return (
    <div
      data-tauri-drag-region="false"
      className={cn("no-drag flex shrink-0 items-center gap-0", className)}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              className={SIDEBAR_TRIGGER_CLASS_NAME}
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
        <div className="flex shrink-0 items-center gap-0">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className={SIDEBAR_TRIGGER_CLASS_NAME}
                  aria-label="Back"
                  onClick={() => history.back()}
                />
              }
            >
              <IoIosArrowRoundBack className="size-[22px]" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Back ({mod}[)</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className={SIDEBAR_TRIGGER_CLASS_NAME}
                  aria-label="Forward"
                  onClick={() => history.forward()}
                />
              }
            >
              <IoIosArrowRoundForward className="size-[22px]" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Forward ({mod}])</TooltipPopup>
          </Tooltip>
        </div>
      )}
    </div>
  )
}

/** The leading cluster shows in the route header only while the sidebar is collapsed. */
export function SidebarHeaderNavigationControls() {
  const { open } = useSidebar()
  if (open) return null
  return <div className="hidden h-7 w-[84px] shrink-0 md:block" aria-hidden="true" />
}

const PANEL_TOGGLE_CLASS_NAME = cn(
  CHAT_HEADER_TOGGLE_CLASS_NAME,
  "!size-7 [&_svg,&_[data-slot=central-icon]]:mx-0",
)

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
            className={PANEL_TOGGLE_CLASS_NAME}
          />
        }
      >
        <SurfaceChipIcon icon={PanelRightCloseIcon} className="size-4" />
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
            className={PANEL_TOGGLE_CLASS_NAME}
          />
        }
      >
        <SurfaceChipIcon icon={WindowIcon} className="size-4" />
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
export function SurfaceHeader({
  minimal,
  environment,
  showSidebarControls = true,
  children,
  trailing,
}: {
  minimal?: boolean
  environment?: boolean
  showSidebarControls?: boolean
  children?: ReactNode
  trailing?: ReactNode
}) {
  const { open } = useSidebar()
  const gutter = showSidebarControls && !open && platform() === "macos"
  return (
    <div
      data-tauri-drag-region="deep"
      className={cn(
        CHAT_SURFACE_HEADER_ROW_CLASS_NAME,
        CHAT_SURFACE_HEADER_PADDING_X_CLASS,
        "@container drag-region font-system-ui",
        gutter && "desktop-top-bar-traffic-light-gutter",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div
          className={cn(
            "flex min-w-0 flex-1 items-center overflow-hidden",
            !open ? "gap-4" : "gap-2 sm:gap-3",
          )}
        >
          {showSidebarControls && <SidebarHeaderNavigationControls />}
          {!minimal && <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>}
        </div>
        <div
          data-tauri-drag-region="false"
          className="flex shrink-0 items-center gap-2 [-webkit-app-region:no-drag]"
        >
          {trailing}
          {environment && <EnvironmentToggle />}
          <DockToggle />
        </div>
      </div>
    </div>
  )
}
