// VS Code-style edge drop zones for arranging sidebar threads into split panes.

import {
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from "react"

import { cn } from "@/lib/utils"
import type { ThreadId } from "@/protocol"
import type { SplitDirection, SplitSide } from "@/state/splitView"

import {
  dropZoneAt,
  hasThreadDrag,
  readThreadDrag,
  splitForZone,
  type DropZone,
} from "./chatPaneDrag"

const ZONE_CLASS: Record<DropZone, string> = {
  top: "inset-x-0 top-0 h-1/2",
  bottom: "inset-x-0 bottom-0 h-1/2",
  left: "inset-y-0 left-0 w-1/2",
  right: "inset-y-0 right-0 w-1/2",
}

export function ChatPaneDropOverlay({
  children,
  className,
  excludedThreadIds,
  wholePaneDrop = false,
  canDropInDirection = () => true,
  onDropThread,
}: {
  children: ReactNode
  className?: string
  excludedThreadIds?: ReadonlySet<ThreadId>
  /** Empty panes accept the drop directly, so their preview covers the whole pane. */
  wholePaneDrop?: boolean
  canDropInDirection?: (direction: SplitDirection) => boolean
  onDropThread: (input: {
    threadId: ThreadId
    direction: SplitDirection
    side: SplitSide
  }) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [zone, setZone] = useState<DropZone | null>(null)

  const zoneFor = (event: ReactDragEvent<HTMLDivElement>): DropZone | null => {
    const threadId = readThreadDrag(event)
    if (threadId && excludedThreadIds?.has(threadId)) return null
    const rect = ref.current?.getBoundingClientRect()
    return rect
      ? dropZoneAt(rect, event.clientX, event.clientY, canDropInDirection)
      : null
  }

  const update = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasThreadDrag(event)) return
    event.preventDefault()
    event.stopPropagation()
    const next = zoneFor(event)
    event.dataTransfer.dropEffect = next ? "move" : "none"
    setZone((current) => (current === next ? current : next))
  }

  return (
    <div
      ref={ref}
      className={cn("relative flex min-h-0 min-w-0 flex-1", className)}
      onDragEnter={update}
      onDragOver={update}
      onDragLeave={(event) => {
        if (!hasThreadDrag(event)) return
        const related = event.relatedTarget as Node | null
        if (related && event.currentTarget.contains(related)) return
        setZone(null)
      }}
      onDrop={(event) => {
        if (!hasThreadDrag(event)) return
        event.preventDefault()
        event.stopPropagation()
        const threadId = readThreadDrag(event)
        const next = zoneFor(event)
        setZone(null)
        if (!threadId || !next || excludedThreadIds?.has(threadId)) return
        onDropThread({ threadId, ...splitForZone(next) })
      }}
    >
      {children}
      <div
        className="pointer-events-none absolute inset-0 z-50"
        aria-hidden="true"
      >
        {zone && (
          <div
            data-thread-drop-zone={zone}
            className={cn(
              "absolute m-1 rounded-md bg-info/12 ring-1 ring-info/55 ring-inset",
              wholePaneDrop ? "inset-0" : ZONE_CLASS[zone]
            )}
          />
        )}
      </div>
    </div>
  )
}
