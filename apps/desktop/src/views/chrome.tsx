// Shared header chrome: the window title bar (back/forward + sidebar toggle,
// then the route header over the content column), a 46px row, and 28px
// controls on one baseline.

import { createContext, forwardRef, useContext, type ComponentProps, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { Button } from "@/components/kit/button"
import { useSidebar } from "@/components/kit/sidebar"
import { IconSwap } from "@/components/kybern/motion"
import { Toggle } from "@/components/kit/toggle"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/kit/tooltip"
import { CHAT_SURFACE_HEADER_HEIGHT_PX } from "@/lib/kit/desktopChrome"
import { ArrowLeftIcon, ArrowRightIcon, LayoutSidebarIcon, NewThreadIcon, PanelRightCloseIcon, WindowIcon, type LucideIcon } from "@/lib/kit/icons"
import { mod } from "@/lib/format"
import { isTauri } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import { goBack, goForward, useNavigationAvailability } from "@/state/navigation"
import { newThread } from "@/state/nav"
import { useStore } from "@/state/store"

export const CHAT_SURFACE_HEADER_HEIGHT_CLASS: `h-[${typeof CHAT_SURFACE_HEADER_HEIGHT_PX}px]` =
  "h-[46px]"

export const CHAT_SURFACE_HEADER_PADDING_X_CLASS = "px-3 sm:px-5"

/** The title-bar slot over the content column; route headers render into it. */
const TitlebarSlotContext = createContext<HTMLElement | null>(null)
export const TitlebarSlotProvider = TitlebarSlotContext.Provider

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
  "!size-7 shrink-0 rounded-lg [&_svg]:mx-0"

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

/** One footprint for the sidebar toggle and the navigation cluster: 28px squares,
 *  size-4 Hugeicons (stroke 2.5) so they match the file-tree / explorer glyphs. */
const SIDEBAR_TRIGGER_CLASS_NAME = cn(
  "!size-7 shrink-0 rounded-lg [&_svg]:!opacity-100 [&_svg]:mx-0",
  CHAT_SURFACE_CONTROL_IDLE_TEXT_CLASS_NAME,
  CHAT_SURFACE_CONTROL_HOVER_CLASS_NAME,
)

/** Back and forward dim while there is nowhere to go; the opacity eases so a step does not flicker them. */
const NAVIGATION_ARROW_CLASS_NAME = cn(SIDEBAR_TRIGGER_CLASS_NAME, "transition-opacity duration-150 disabled:opacity-40")

/** The sidebar toggle first, so it never moves, then back/forward (or a single new-thread action when collapsed). */
export function SidebarLeadingControls({ className }: { className?: string }) {
  const { open, toggleSidebar } = useSidebar()
  // Notes have no side panel, so nothing here applies (App.tsx keeps the panel closed there).
  const panelless = useStore((s) => s.selected.kind === "notes")
  const { canBack, canForward } = useNavigationAvailability()
  if (panelless) return null
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
        <IconSwap
          active={open ? "a" : "b"}
          className="h-7 w-14 shrink-0"
          a={
            <div className="flex size-full items-center" aria-hidden={!open} inert={!open}>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className={NAVIGATION_ARROW_CLASS_NAME}
                      aria-label="Back"
                      tabIndex={open ? 0 : -1}
                      disabled={!canBack}
                      onClick={() => goBack()}
                    />
                  }
                >
                  <ArrowLeftIcon className="size-4" />
                </TooltipTrigger>
                <TooltipPopup side="bottom">Back ({mod}[)</TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className={NAVIGATION_ARROW_CLASS_NAME}
                      aria-label="Forward"
                      tabIndex={open ? 0 : -1}
                      disabled={!canForward}
                      onClick={() => goForward()}
                    />
                  }
                >
                  <ArrowRightIcon className="size-4" />
                </TooltipTrigger>
                <TooltipPopup side="bottom">Forward ({mod}])</TooltipPopup>
              </Tooltip>
            </div>
          }
          b={
            <div className="flex size-full items-center justify-center" aria-hidden={open} inert={open}>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className={SIDEBAR_TRIGGER_CLASS_NAME}
                      aria-label="New thread"
                      tabIndex={open ? -1 : 0}
                      onClick={() => newThread()}
                    />
                  }
                >
                  <NewThreadIcon className="size-4" />
                </TooltipTrigger>
                <TooltipPopup side="bottom">New thread</TooltipPopup>
              </Tooltip>
            </div>
          }
        />
      )}
    </div>
  )
}

const PANEL_TOGGLE_CLASS_NAME = cn(
  CHAT_HEADER_TOGGLE_CLASS_NAME,
  "!size-7 [&_svg]:mx-0",
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

/** Toggles the floating Environment card. */
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
 * It renders into the window title bar, above the workspace card; `inline`
 * keeps it inside its own pane (split view), with the pane's hairline below.
 */
export function SurfaceHeader({
  minimal,
  environment,
  inline,
  children,
  trailing,
  dock = true,
}: {
  minimal?: boolean
  environment?: boolean
  inline?: boolean
  children?: ReactNode
  trailing?: ReactNode
  /** The right sidebar toggle. Full pages without a dock (Notes, Tasks) leave it out. */
  dock?: boolean
}) {
  const slot = useContext(TitlebarSlotContext)
  const titlebar = !inline && slot !== null
  const row = (
    <div
      data-tauri-drag-region="deep"
      className={cn(
        titlebar ? cn("flex min-w-0 flex-1 items-center", CHAT_SURFACE_HEADER_HEIGHT_CLASS) : CHAT_SURFACE_HEADER_ROW_CLASS_NAME,
        CHAT_SURFACE_HEADER_PADDING_X_CLASS,
        "@container drag-region font-system-ui",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          {!minimal && children}
        </div>
        <div
          data-tauri-drag-region="false"
          className="flex shrink-0 items-center gap-2 [-webkit-app-region:no-drag]"
        >
          {trailing}
          {environment && <EnvironmentToggle />}
          {dock && <DockToggle />}
        </div>
      </div>
    </div>
  )
  return titlebar ? createPortal(row, slot) : row
}
