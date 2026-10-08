import { useLayoutEffect, useRef } from "react"

import { cn } from "@/lib/utils"
import type { ThreadId } from "@/protocol"
import { registerSlot, setSlotVisible, type PreviewSlotKind } from "@/state/previewSurface"

/**
 * A hole the live page is positioned over. The page itself lives in `PreviewSurfaceLayer`
 * (moving an iframe would reload it); this element only reports where the page goes.
 */
export function PreviewSlot({
  kind,
  threadId,
  visible,
  className,
  children,
}: {
  kind: PreviewSlotKind
  threadId: ThreadId
  visible: boolean
  className?: string
  children?: React.ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    // The animating dock clips the page so it never paints over the dock header or chrome row.
    const clip = element.closest<HTMLElement>("[data-workspace-dock]")
    return registerSlot(kind, { threadId, element, clip }, false)
  }, [kind, threadId])
  useLayoutEffect(() => {
    setSlotVisible(kind, threadId, visible)
  }, [kind, threadId, visible])

  return (
    <div ref={ref} data-preview-slot={kind} className={cn("relative min-h-0 flex-1", className)}>
      {children}
    </div>
  )
}
