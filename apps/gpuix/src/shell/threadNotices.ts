// Which system notification each thread has on screen, and what it announces. A thread has one (a later post replaces
// the earlier), so an answered approval may withdraw it only while it is still the notice for that approval: a
// "Finished working" that replaced it stays. `agentToasts.ts` asks before it dismisses.
export interface ThreadNotices {
  /** The thread's notification now announces `approval` (or, null, something that is not waiting on an answer). */
  posted(thread: string, approval: string | null): void
  /** An approval or question was answered. True when the thread's notification announced exactly that one. */
  resolved(thread: string, approval: string): boolean
  /** The reader is looking at the thread. True when it had a notification waiting on an answer. */
  viewed(thread: string): boolean
}

export function createThreadNotices(limit = 256): ThreadNotices {
  /** Oldest first; the approval each thread's notification waits on, or null. */
  const notices = new Map<string, string | null>()
  return {
    posted(thread, approval) {
      notices.delete(thread)
      notices.set(thread, approval)
      if (notices.size > limit) notices.delete(notices.keys().next().value!)
    },
    resolved(thread, approval) {
      if (notices.get(thread) !== approval) return false
      notices.delete(thread)
      return true
    },
    viewed(thread) {
      const waiting = notices.get(thread)
      if (waiting === undefined || waiting === null) return false
      notices.delete(thread)
      return true
    },
  }
}
