import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createHistoryPagingGate } from "../../../../packages/kybern-client/src/historyPaging"
import { errorText, loadEarlier } from "@/state/rpc"

/** Begin bounded page reads ahead of the reader; VirtualRows owns the anchor. */
export function useEarlierHistory(threadId: string, scroll: HTMLElement | null, cursor: number | null, loading: boolean, enabled: boolean) {
  const paging = useMemo(() => ({ threadId, gate: createHistoryPagingGate() }), [threadId])
  const gate = paging.gate
  const intent = useRef(false)
  const [failure, setFailure] = useState<{ threadId: string; message: string } | null>(null)
  const error = failure?.threadId === threadId ? failure.message : ""
  useEffect(() => { intent.current = false }, [threadId])
  const load = useCallback(async () => {
    // A request consumes the gesture (including an explicit retry). Cursor and
    // layout changes alone must not keep downloading history at scrollTop=0.
    intent.current = false
    setFailure(null)
    try { await loadEarlier(threadId) } catch (error) { setFailure({ threadId, message: errorText(error) }) }
  }, [threadId])
  useEffect(() => {
    if (!scroll || !enabled) return
    let frame = 0
    const check = () => {
      frame = 0
      if (document.visibilityState === "hidden" || scroll.closest("[inert]")) return
      if (gate.claim(cursor, scroll.scrollTop, scroll.clientHeight, intent.current && !loading && !error)) void load()
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(check) }
    const gesture = (event: Event) => {
      if (event instanceof KeyboardEvent && !["PageUp", "Home", "ArrowUp", "PageDown", "End", "ArrowDown"].includes(event.key)) return
      if (event instanceof PointerEvent && event.type === "pointermove" && event.buttons === 0) return
      intent.current = true
      schedule()
    }
    const pane = scroll.closest("[data-chat-transcript-pane]") ?? scroll
    scroll.addEventListener("scroll", schedule, { passive: true })
    const gestures = ["wheel", "touchstart", "touchmove", "pointerdown", "pointermove", "keydown"]
    for (const name of gestures) pane.addEventListener(name, gesture, { passive: true })
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      scroll.removeEventListener("scroll", schedule)
      for (const name of gestures) pane.removeEventListener(name, gesture)
    }
  }, [scroll, cursor, loading, enabled, error, gate, load])
  return { error, retry: load }
}
