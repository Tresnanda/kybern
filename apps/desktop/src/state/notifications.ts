// FILE: notifications.ts
// Purpose: Client-side "needs attention" inbox backing the sidebar notification
//          bell. A thread earns a notification when a turn finishes, fails, or
//          asks for the user while the user is not looking at it; it clears when
//          the thread is opened. Persisted per environment in localStorage so the
//          bell survives reloads. No daemon/protocol changes — this is a desktop
//          read-state layer over the events the app already receives.

import type { Thread, ThreadId } from "@/protocol"

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
 * The kind to display now, reconciled with the thread's live status: a block
 * that has since been answered reads as "done", and a thread that has since
 * failed or is asking again reflects that even if the stored kind is stale.
 */
export function reconcileKind(thread: Thread, stored: NotificationKind): NotificationKind {
  if (thread.status === "awaiting-approval") return "blocked"
  if (thread.status === "failed") return "failed"
  return stored === "blocked" ? "done" : stored
}

export interface AttentionItem {
  thread: Thread
  kind: NotificationKind
  seq: number
  at: string
}

/** Notified threads that still exist and aren't archived, most-urgent first. */
export function selectAttentionItems(state: {
  threads: Record<ThreadId, Thread>
  notifications: Record<ThreadId, ThreadNotification>
}): AttentionItem[] {
  const items: AttentionItem[] = []
  for (const [id, n] of Object.entries(state.notifications)) {
    const thread = state.threads[id as ThreadId]
    if (!thread || thread.status === "archived") continue
    items.push({ thread, kind: reconcileKind(thread, n.kind), seq: n.seq, at: n.at })
  }
  items.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || Date.parse(b.at) - Date.parse(a.at))
  return items
}
