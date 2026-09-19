// FILE: notifications.ts
// Purpose: Client-side "needs attention" inbox backing the sidebar notification
//          bell. A thread earns a notification when a turn finishes, fails, or
//          asks for the user while the user is not looking at it. Completed
//          notices clear when the thread is opened; live failures and requests
//          can also be dismissed from the bell. Persisted per environment in
//          localStorage so the bell survives reloads. No daemon/protocol changes
//          — this is a desktop read-state layer over events the app already receives.

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

/**
 * Read-state for a live attention status. Unlike a completion notification,
 * failed and blocked threads are derived from the thread snapshot, so their
 * visibility needs a cursor of its own. The cursor is deliberately tied to
 * the event sequence: dismissing a stale failure must not hide a later one.
 */
export interface ThreadNotificationDismissal {
  kind: NotificationKind
  seq: number
}

export interface ThreadNotificationState {
  notifications: Record<ThreadId, ThreadNotification>
  dismissals: Record<ThreadId, ThreadNotificationDismissal>
}

const STORAGE_KEY = "kybern.thread-notifications"
const STORAGE_VERSION = 2

function storageKey(environmentId?: string): string {
  return environmentId ? `${STORAGE_KEY}:${environmentId}` : STORAGE_KEY
}

function parseNotifications(value: unknown): Record<ThreadId, ThreadNotification> {
  if (!value || typeof value !== "object") return {}
  const out: Record<ThreadId, ThreadNotification> = {}
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    const n = raw as Partial<ThreadNotification>
    if (n && (n.kind === "blocked" || n.kind === "failed" || n.kind === "done") && typeof n.seq === "number" && typeof n.at === "string")
      out[id as ThreadId] = { kind: n.kind, seq: n.seq, at: n.at }
  }
  return out
}

function parseDismissals(value: unknown): Record<ThreadId, ThreadNotificationDismissal> {
  if (!value || typeof value !== "object") return {}
  const out: Record<ThreadId, ThreadNotificationDismissal> = {}
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    const n = raw as Partial<ThreadNotificationDismissal>
    if (n && (n.kind === "blocked" || n.kind === "failed" || n.kind === "done") && typeof n.seq === "number")
      out[id as ThreadId] = { kind: n.kind, seq: n.seq }
  }
  return out
}

export function readThreadNotificationState(environmentId?: string): ThreadNotificationState {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey(environmentId))
    if (!raw) return { notifications: {}, dismissals: {} }
    const stored = JSON.parse(raw) as { version?: unknown; notifications?: unknown }
    // Version 1 only stored completed notifications. Keep those entries when
    // upgrading so a desktop update does not silently mark work as read.
    if (stored.version !== 1 && stored.version !== STORAGE_VERSION) return { notifications: {}, dismissals: {} }
    return {
      notifications: parseNotifications(stored.notifications),
      dismissals: stored.version === STORAGE_VERSION
        ? parseDismissals((stored as { dismissals?: unknown }).dismissals)
        : {},
    }
  } catch {
    return { notifications: {}, dismissals: {} }
  }
}

export function persistThreadNotificationState(
  notifications: Record<ThreadId, ThreadNotification>,
  dismissals: Record<ThreadId, ThreadNotificationDismissal>,
  environmentId?: string,
): void {
  try {
    globalThis.localStorage?.setItem(storageKey(environmentId), JSON.stringify({ version: STORAGE_VERSION, notifications, dismissals }))
  } catch {
    // Read-state persistence is a convenience; storage denial must not break the app.
  }
}

/** Internal helpers report through their parent, never through the user inbox.
 * Unknown threads stay quiet until their relationship metadata is available. */
export function threadCanNotify(thread: Thread | undefined): boolean {
  return !!thread && !thread.parent_thread_id
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
export function threadAttentionSequence(
  thread: Thread,
  kind: NotificationKind,
  notification: ThreadNotification | undefined,
): number {
  if (kind === "done" && notification) return notification.seq
  return typeof thread.last_seq === "number" ? thread.last_seq : 0
}

/** Attention that comes from the persisted thread status rather than a done marker. */
export function threadStatusAttentionKind(status: Thread["status"]): NotificationKind | null {
  if (status === "awaiting-approval") return "blocked"
  if (status === "failed") return "failed"
  return null
}

export function threadAttentionKind(
  thread: Thread,
  notification: ThreadNotification | undefined,
  dismissal?: ThreadNotificationDismissal,
): NotificationKind | null {
  if (!threadCanNotify(thread) || thread.status === "archived") return null
  const kind = threadStatusAttentionKind(thread.status)
    ?? (thread.status === "idle" && notification?.kind === "done" ? "done" : null)
  if (!kind) return null
  if (dismissal?.kind === kind && threadAttentionSequence(thread, kind, notification) <= dismissal.seq) return null
  return kind
}

export interface AttentionItem {
  thread: Thread
  kind: NotificationKind
}

/** Every thread that needs attention right now, most-urgent first. */
export function selectAttentionItems(state: {
  threads: Record<ThreadId, Thread>
  notifications: Record<ThreadId, ThreadNotification>
  notificationDismissals?: Record<ThreadId, ThreadNotificationDismissal>
}): AttentionItem[] {
  const items: AttentionItem[] = []
  for (const thread of Object.values(state.threads)) {
    const kind = threadAttentionKind(thread, state.notifications[thread.id], state.notificationDismissals?.[thread.id])
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
