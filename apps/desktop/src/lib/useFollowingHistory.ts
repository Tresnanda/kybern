import { useEffect } from "react"
import { useStore } from "@/state/store"
import { trimFollowingHistory } from "@/state/followingHistory"
import type { ThreadState } from "@/state/transcript"

export function useFollowingHistory(threadId: string, state: ThreadState | undefined, scroll: HTMLElement | null, enabled: boolean) {
  useEffect(() => {
    if (!enabled || !scroll || !state?.loaded || state.loadingEarlier) return
    // Wait for a quiet frame sequence. Do not walk retained data on every token,
    // and let a wheel/selection/focus gesture settle before deciding to release.
    let timer: ReturnType<typeof setTimeout>
    const schedule = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
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
