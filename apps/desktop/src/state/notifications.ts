// FILE: notifications.ts
// Purpose: Client-side "needs attention" inbox backing the sidebar notification
//          bell. A thread earns a notification when a turn finishes, fails, or
//          asks for the user while the user is not looking at it; it clears when
//          the thread is opened. Persisted per environment in localStorage so the
//          bell survives reloads. No daemon/protocol changes — this is a desktop
//          read-state layer over the events the app already receives.

import type { Thread, ThreadId } from "@/protocol"
import type { EnvironmentStore } from "./store"

/** Why a thread is asking for attention. Ranked most-urgent first. */
export type NotificationKind = "blocked" | "failed" | "done"

export interface ThreadNotification {
  kind: NotificationKind
  /** Sequence of the triggering event, for de-duplication. */
  seq: number
  /** ISO time of the triggering event, for the relative-time label + sort. */
  at: string
}

const STORAGE_KEY = "kybern.thread-notifications"
const STORAGE_VERSION = 1

function storageKey(environmentId?: string): string {
  return environmentId ? `${STORAGE_KEY}:${environmentId}` : STORAGE_KEY
}

export function readThreadNotifications(environmentId?: string): Record<ThreadId, ThreadNotification> {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey(environmentId))
    if (!raw) return {}
    const stored = JSON.parse(raw) as { version?: unknown; notifications?: unknown }
    if (stored.version !== STORAGE_VERSION || !stored.notifications || typeof stored.notifications !== "object") return {}
    const out: Record<ThreadId, ThreadNotification> = {}
    for (const [id, value] of Object.entries(stored.notifications as Record<string, unknown>)) {
      const n = value as Partial<ThreadNotification>
      if (n && (n.kind === "blocked" || n.kind === "failed" || n.kind === "done") && typeof n.seq === "number" && typeof n.at === "string")
        out[id as ThreadId] = { kind: n.kind, seq: n.seq, at: n.at }
    }
    return out
  } catch {
    return {}
  }
}

export function persistThreadNotifications(
  notifications: Record<ThreadId, ThreadNotification>,
  environmentId?: string,
): void {
  try {
    globalThis.localStorage?.setItem(storageKey(environmentId), JSON.stringify({ version: STORAGE_VERSION, notifications }))
  } catch {
    // Read-state persistence is a convenience; storage denial must not break the app.
  }
}

const KIND_RANK: Record<NotificationKind, number> = { blocked: 0, failed: 1, done: 2 }

/**
 * Whether a thread needs attention right now, from its live status plus the
 * finished-unread inbox. `awaiting-approval` (waiting on you) and `failed` are
 * read straight from status, so they show regardless of whether the app was
 * open when they happened. `done` is a turn that finished while you were away
 * (recorded in `notifications`) and clears once you open the thread. Running
 * threads and threads you have already caught up on return `null`.
 */
export function threadAttentionKind(thread: Thread, notification: ThreadNotification | undefined): NotificationKind | null {
  if (thread.status === "archived") return null
  if (thread.status === "awaiting-approval") return "blocked"
  if (thread.status === "failed") return "failed"
  if (thread.status === "idle" && notification?.kind === "done") return "done"
  return null
}

export interface AttentionItem {
  thread: Thread
  kind: NotificationKind
}

/** Every thread that needs attention right now, most-urgent first. */
export function selectAttentionItems(state: {
  threads: Record<ThreadId, Thread>
  notifications: Record<ThreadId, ThreadNotification>
}): AttentionItem[] {
  const items: AttentionItem[] = []
  for (const thread of Object.values(state.threads)) {
    const kind = threadAttentionKind(thread, state.notifications[thread.id])
    if (kind) items.push({ thread, kind })
  }
  items.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.thread.last_seq - a.thread.last_seq)
  return items
}

/**
 * Clear unread state only after the selected thread is genuinely readable:
 * the document is visible and the native window reports focus. The sequence
 * captured before the async native lookup prevents a newer unseen completion
 * from being consumed by an older focus probe.
 */
export function trackFocusedThreadReads(
  store: EnvironmentStore,
  focusedWindow: () => Promise<boolean>,
): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {}
  let stopped = false
  let probe = 0
  const documentHidden = () => document.visibilityState === "hidden"

  const acknowledge = async () => {
    const currentProbe = ++probe
    if (documentHidden()) return
    const before = store.getState()
    if (before.selected.kind !== "thread") return
    const threadId = before.selected.id
    const unread = before.notifications[threadId]
    if (!unread) return

    let focused = document.hasFocus()
    try { focused = await focusedWindow() } catch { /* Browser focus is the fallback. */ }
    if (stopped || currentProbe !== probe || !focused || documentHidden()) return

    const after = store.getState()
    if (
      after.selected.kind === "thread" &&
      after.selected.id === threadId &&
      after.notifications[threadId]?.seq === unread.seq
    ) after.clearNotification(threadId)
  }

  const onForeground = () => { void acknowledge() }
  const onBlur = () => { probe++ }
  const unsubscribe = store.subscribe((next, previous) => {
    if (next.selected !== previous.selected || next.notifications !== previous.notifications)
      void acknowledge()
  })
  window.addEventListener("focus", onForeground)
  window.addEventListener("blur", onBlur)
  document.addEventListener("visibilitychange", onForeground)
  void acknowledge()

  return () => {
    stopped = true
    probe++
    unsubscribe()
    window.removeEventListener("focus", onForeground)
    window.removeEventListener("blur", onBlur)
    document.removeEventListener("visibilitychange", onForeground)
  }
}
