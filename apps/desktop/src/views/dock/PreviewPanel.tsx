import type { ReactNode } from "react"

import { IconButton } from "@/components/kit/icon-button"
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/kit/tooltip"
import { Toggle } from "@/components/kit/toggle"
import { ChevronRightIcon } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"

import { DOCK_HEADER_ICON_BUTTON_CLASS } from "../chrome"

/**
 * Shell for the dock Preview tab: a sub-header (crumbs, then an actions slot) over a body.
 * Content kinds fill the slots; today that is a visual reply (`VisualPreviewPanel`), and a
 * web page kind can reuse the same tab and chrome.
 */
export function PreviewPanel({ kind, title, actions, header, children, className }: { kind: string; title?: string; actions?: ReactNode; /** Replaces the crumbs row (the web kind brings its own 36px chrome row). */ header?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex h-full min-h-0 w-full flex-col bg-[var(--color-background-surface)]", className)} data-preview-kind={kind.toLowerCase()}>
      {header ?? (
        <div className="chat-surface-divider flex h-9 shrink-0 items-center gap-2 px-3">
          <nav aria-label={kind} className="flex min-w-0 flex-1 items-center gap-1 font-system-ui text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/55">
            <span className="shrink-0">{kind}</span>
            <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/35" />
            <span className="min-w-0 truncate text-[length:var(--app-font-size-ui,12px)] text-foreground/90" title={title}>{title}</span>
          </nav>
          {actions && <div className="flex shrink-0 items-center">{actions}</div>}
        </div>
      )}
      <div className="relative min-h-0 flex-1">{children}</div>
    </div>
  )
}

/** Buttons in one group sit 2px apart; groups are separated by a hairline. */
export function PreviewActionGroup({ children, divider = true }: { children: ReactNode; divider?: boolean }) {
  return (
    <div className="flex items-center gap-0.5">
      {divider && <span aria-hidden className="mx-1 h-4 w-px bg-[var(--app-surface-divider)]" />}
      {children}
    </div>
  )
}

export function PreviewAction({ label, tooltip, children, ...props }: { label: string; tooltip?: string } & Omit<React.ComponentProps<typeof IconButton>, "label" | "tooltip" | "variant" | "size">) {
  return (
    <IconButton variant="chrome" size="icon-xs" className={DOCK_HEADER_ICON_BUTTON_CLASS} label={label} tooltip={tooltip ?? label} tooltipSide="bottom" {...props}>
      {children}
    </IconButton>
  )
}

export function PreviewToggle({ label, pressed, onPressedChange, children }: { label: string; pressed: boolean; onPressedChange: (pressed: boolean) => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Toggle size="xs" aria-label={label} pressed={pressed} onPressedChange={onPressedChange} className={cn(DOCK_HEADER_ICON_BUTTON_CLASS, "!min-w-7 !px-0 border-transparent text-[var(--color-text-foreground-secondary)] hover:bg-[var(--color-background-elevated-secondary)] hover:text-[var(--color-text-foreground)] data-pressed:bg-[var(--color-background-elevated-secondary)] data-pressed:text-[var(--color-text-foreground)]")} />}>
        {children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  )
}
