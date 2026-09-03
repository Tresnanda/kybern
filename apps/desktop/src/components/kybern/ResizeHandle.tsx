// Drag handle between two panes, styled after Synara's SidebarRail: a 16px
// invisible hit area straddling the seam, a 2px line that appears on hover
// or while dragging, and a col-resize cursor.

import { cn } from "@/lib/utils"

export function ResizeHandle({
  onPointerDown,
  dragging,
  edge,
  label,
  className,
}: {
  onPointerDown: (e: React.PointerEvent) => void
  dragging?: boolean
  /** Which edge of the parent the handle straddles. */
  edge: "left" | "right"
  label: string
  className?: string
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => e.preventDefault()}
      className={cn(
        "group/resize absolute inset-y-0 z-30 w-4 cursor-col-resize select-none",
        edge === "left" ? "-left-2" : "-right-2",
        "after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] after:-translate-x-1/2 after:bg-transparent after:transition-colors hover:after:bg-sidebar-border",
        dragging && "after:bg-sidebar-border",
        className,
      )}
    />
  )
}
