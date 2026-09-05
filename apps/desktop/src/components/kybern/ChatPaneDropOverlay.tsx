// VS Code-style edge drop zones for arranging sidebar threads into split panes.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"

import { cn } from "@/lib/utils"
import {
  SquareSplitHorizontal,
  SquareSplitVertical,
} from "@/lib/kit/icons"
import type { ThreadId } from "@/protocol"
import type { SplitDirection, SplitSide } from "@/state/splitView"

import {
  dropZoneAt,
  splitForZone,
  subscribeThreadPointerDrag,
  subscribeThreadPointerDrop,
  type DropZone,
  type ThreadPointerDrag,
} from "./chatPaneDrag"

const ALLOW_EVERY_DIRECTION = () => true

const ZONE_CLASS: Record<DropZone, string> = {
  top: "inset-x-2 top-2 h-[calc(50%_-_0.75rem)]",
  bottom: "inset-x-2 bottom-2 h-[calc(50%_-_0.75rem)]",
  left: "inset-y-2 left-2 w-[calc(50%_-_0.75rem)]",
  right: "inset-y-2 right-2 w-[calc(50%_-_0.75rem)]",
}

const DIVIDER_CLASS: Record<DropZone, string> = {
  top: "inset-x-2 top-1/2 h-px",
  bottom: "inset-x-2 top-1/2 h-px",
  left: "inset-y-2 left-1/2 w-px",
  right: "inset-y-2 left-1/2 w-px",
}

const DROP_LABEL: Record<DropZone, string> = {
  top: "Split above",
  bottom: "Split below",
  left: "Split left",
  right: "Split right",
}

export function ChatPaneDropOverlay({
  children,
  className,
  excludedThreadIds,
  wholePaneDrop = false,
  canDropInDirection = ALLOW_EVERY_DIRECTION,
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
  const [lastZone, setLastZone] = useState<DropZone>("right")

  const showZone = useCallback((next: DropZone | null) => {
    if (next) setLastZone(next)
    setZone((current) => (current === next ? current : next))
  }, [])

  const zoneFor = useCallback((drag: ThreadPointerDrag): DropZone | null => {
    if (excludedThreadIds?.has(drag.threadId)) return null
    const rect = ref.current?.getBoundingClientRect()
    return rect
      ? dropZoneAt(rect, drag.clientX, drag.clientY, canDropInDirection)
      : null
  }, [canDropInDirection, excludedThreadIds])

  useEffect(
    () =>
      subscribeThreadPointerDrag((drag) => {
        showZone(drag ? zoneFor(drag) : null)
      }),
    [showZone, zoneFor]
  )

  useEffect(
    () =>
      subscribeThreadPointerDrop((drop) => {
        const next = zoneFor(drop)
        showZone(null)
        if (!next) return
        onDropThread({ threadId: drop.threadId, ...splitForZone(next) })
      }),
    [onDropThread, showZone, zoneFor]
  )

  return (
    <div
      ref={ref}
      data-thread-drop-surface="true"
      className={cn("relative flex min-h-0 min-w-0 flex-1", className)}
    >
      {children}
      <div
        data-active={zone !== null}
        data-thread-drop-preview={zone ?? undefined}
        className="thread-drop-overlay pointer-events-none absolute inset-0 z-50 overflow-hidden"
        aria-hidden="true"
      >
        <div className="thread-drop-scrim absolute inset-0" />
        {!wholePaneDrop && (
          <div
            className={cn(
              "thread-drop-divider absolute",
              DIVIDER_CLASS[lastZone]
            )}
          />
        )}
        <div
          data-thread-drop-zone={lastZone}
          className={cn(
            "thread-drop-target absolute flex items-center justify-center rounded-[10px]",
            wholePaneDrop ? "inset-2" : ZONE_CLASS[lastZone]
          )}
        >
          <div className="thread-drop-label inline-flex max-w-[calc(100%-2rem)] items-center gap-2 rounded-lg px-3 py-2 text-[length:var(--app-font-size-ui,12px)] leading-none font-medium whitespace-nowrap text-foreground">
            {wholePaneDrop ? (
              <SquareSplitVertical className="size-4 shrink-0" />
            ) : lastZone === "left" || lastZone === "right" ? (
              <SquareSplitVertical className="size-4 shrink-0" />
            ) : (
              <SquareSplitHorizontal className="size-4 shrink-0" />
            )}
            <span>{wholePaneDrop ? "Open here" : DROP_LABEL[lastZone]}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
