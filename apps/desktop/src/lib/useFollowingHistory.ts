import { useEffect } from "react"
import { useStore } from "@/state/store"
import { trimFollowingHistory } from "@/state/followingHistory"
import type { ThreadState } from "@/state/transcript"

export function useFollowingHistory(threadId: string, state: ThreadState | undefined, scroll: HTMLElement | null, enabled: boolean) {
  useEffect(() => {
    if (!enabled || !scroll || !state?.loaded || state.loadingEarlier) return
    // Coalesce notifications without postponing cleanup indefinitely: WebKit
    // can emit scroll events continuously even at the live edge. State changes
    // still restart the effect so we do not walk retained data on every token.
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        if (scroll.closest("[inert]") || (!document.hidden && scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop > 56)) return
        if (!document.getSelection()?.isCollapsed) return
        if (document.activeElement?.closest("[data-turn-id]")) return
        const next = trimFollowingHistory(state)
        if (next !== state) useStore.getState().updateTranscript(threadId, current => current === state ? next : current)
      }, 250)
    }
    schedule()
    scroll.addEventListener("scroll", schedule, { passive: true })
    scroll.addEventListener("focusout", schedule)
    document.addEventListener("selectionchange", schedule)
    document.addEventListener("visibilitychange", schedule)
    return () => {
      clearTimeout(timer)
      scroll.removeEventListener("scroll", schedule)
      scroll.removeEventListener("focusout", schedule)
      document.removeEventListener("selectionchange", schedule)
      document.removeEventListener("visibilitychange", schedule)
    }
  }, [threadId, state, scroll, enabled])
}
