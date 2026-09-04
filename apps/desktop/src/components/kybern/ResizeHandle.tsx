// Drag handle between two panes, styled after Synara's SidebarRail: a 16px
// invisible hit area straddling the seam and a 2px line that appears on hover,
// keyboard focus, or while dragging.

import { cn } from "@/lib/utils"

export function ResizeHandle({
  onPointerDown,
  onKeyDown,
  onReset,
  dragging,
  edge,
  label,
  valueNow,
  className,
}: {
  onPointerDown: (e: React.PointerEvent) => void
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void
  onReset?: () => void
  dragging?: boolean
  /** Which edge of the parent the handle straddles. */
  edge: "left" | "right" | "top" | "bottom"
  label: string
  /** Percentage owned by the first pane, for keyboard-accessible splitters. */
  valueNow?: number
  className?: string
}) {
  const vertical = edge === "left" || edge === "right"
  return (
    <div
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label={label}
      aria-valuemin={valueNow === undefined ? undefined : 25}
      aria-valuemax={valueNow === undefined ? undefined : 75}
      aria-valuenow={valueNow}
      tabIndex={onKeyDown ? 0 : undefined}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={(e) => {
        e.preventDefault()
        onReset?.()
      }}
      className={cn(
        "group/resize absolute z-30 outline-none select-none",
        vertical
          ? "inset-y-0 w-4 cursor-col-resize after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] after:-translate-x-1/2"
          : "inset-x-0 h-4 cursor-row-resize after:absolute after:inset-x-0 after:top-1/2 after:h-[2px] after:-translate-y-1/2",
        edge === "left" && "-left-2",
        edge === "right" && "-right-2",
        edge === "top" && "-top-2",
        edge === "bottom" && "-bottom-2",
        "after:bg-transparent after:transition-colors hover:after:bg-sidebar-border focus-visible:after:bg-[var(--color-border-focus)]",
        dragging && "after:bg-sidebar-border",
        className
      )}
    />
  )
}
