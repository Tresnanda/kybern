// A live elapsed time that never re-renders. React renders the span once; the shared
// `elapsedClock` writes its text on whole-second boundaries. Settled spans show their final
// duration. The text is decorative (aria-hidden): state changes are announced elsewhere.

import { useEffect, useRef, useState } from "react"

import { formatElapsed } from "../../../../../packages/kybern-client/src/subagents.ts"
import { elapsedClock } from "@/lib/elapsedClockDom"
import { observeLoopVisibility } from "@/lib/loopVisibility"
import { cn } from "@/lib/utils"

export function ElapsedText({ startedAt, endedAt = null, className }: { startedAt: number; endedAt?: number | null; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  // Rendered once. Later text belongs to the clock, so a re-render must not rewrite it.
  const [initial] = useState(() => formatElapsed((endedAt ?? Date.now()) - startedAt))
  useEffect(() => {
    const node = ref.current
    if (!node) return
    if (endedAt !== null) {
      elapsedClock().settle(node, startedAt, endedAt)
      return
    }
    const stopObserving = observeLoopVisibility(node)
    const stopTracking = elapsedClock().track(node, startedAt)
    return () => {
      stopTracking()
      stopObserving()
    }
  }, [startedAt, endedAt])
  return (
    <span ref={ref} aria-hidden className={cn("tabular-nums", className)}>
      {initial}
    </span>
  )
}
