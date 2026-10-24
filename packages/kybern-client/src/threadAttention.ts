// What makes a thread row ask for the reader: a waiting request, a failed turn, a finished one not yet seen.
// The rules the desktop and GPUIX sidebars share (`threadAttentionKind`), over plain records so the mobile list uses them too.
import type { PendingRequestKind, Thread, ThreadActivitySummary } from "./types.ts";

export type AttentionKind = "blocked" | "failed" | "done";

/** A thread's waiting requests: its own oldest one, and the strongest of its delegated agents' (a question outranks an approval). */
export interface ThreadPending {
  own?: PendingRequestKind;
  child?: PendingRequestKind;
}

/** What a client keeps per thread to answer "does this row need me". Every field is optional: no marks, no attention beyond status. */
export interface AttentionSignals {
  /** Threads whose turn finished while the reader looked elsewhere. */
  unread?: Readonly<Record<string, unknown>>;
  /** The `last_seq` at which the reader waved a blocked or failed thread off; newer events bring it back. */
  attentionDismissals?: Readonly<Record<string, number>>;
  pending?: Readonly<Record<string, ThreadPending>>;
}

export interface ThreadAttention {
  /** What the row's dot says, or null when the thread asks for nothing (children, subagents and archived threads never do). */
  kind: AttentionKind | null;
  /** "Needs input" / "Pending approval" for a waiting request, on parents too; null when nothing waits. */
  badge: string | null;
  /** A finished turn the reader has not seen. */
  unread: boolean;
}

/** `pending` of one activity summary (`threads.list` activity), or null when nothing waits. */
export function pendingOf(summary: Pick<ThreadActivitySummary, "pending_request" | "pending_child_request">): ThreadPending | null {
  if (!summary.pending_request && !summary.pending_child_request) return null;
  return {
    ...(summary.pending_request ? { own: summary.pending_request } : {}),
    ...(summary.pending_child_request ? { child: summary.pending_child_request } : {}),
  };
}

/**
 * The badge of a row that waits on the reader: "Needs input" for a question (its own, or a delegated agent's), "Pending
 * approval" for an approval. A thread's own request comes first; an older daemon without kinds still says "Pending".
 */
export function pendingBadge(status: Thread["status"], pending: ThreadPending | undefined): string | null {
  if (status === "awaiting-approval") return !pending?.own ? "Pending" : pending.own === "question" ? "Needs input" : "Pending approval";
  if (pending?.child) return pending.child === "question" ? "Needs input" : "Pending approval";
  return null;
}

/** Desktop `threadAttentionKind` over a client's unread marks and dismissals. A delegated agent that waits blocks its parent. */
export function attentionKind(thread: Thread, signals: AttentionSignals): AttentionKind | null {
  if (thread.parent_thread_id || thread.subagent || thread.status === "archived") return null;
  const kind: AttentionKind | null =
    thread.status === "awaiting-approval" || signals.pending?.[thread.id]?.child
      ? "blocked"
      : thread.status === "failed"
        ? "failed"
        : thread.status === "idle" && signals.unread?.[thread.id]
          ? "done"
          : null;
  if (!kind) return null;
  const dismissed = signals.attentionDismissals?.[thread.id];
  if (kind !== "done" && dismissed !== undefined && thread.last_seq <= dismissed) return null;
  return kind;
}

/** Everything a thread row shows about needing the reader. */
export function threadAttention(thread: Thread, signals: AttentionSignals): ThreadAttention {
  return {
    kind: attentionKind(thread, signals),
    badge: pendingBadge(thread.status, signals.pending?.[thread.id]),
    unread: thread.status !== "archived" && !!signals.unread?.[thread.id],
  };
}

/** Lower is more urgent. */
export const ATTENTION_RANK: Record<AttentionKind, number> = { blocked: 0, failed: 1, done: 2 };

/** Every thread that needs attention, most urgent first, then most recently updated (`selectAttentionItems`). */
export function attentionItems(threads: readonly Thread[], signals: AttentionSignals): { thread: Thread; kind: AttentionKind }[] {
  const items: { thread: Thread; kind: AttentionKind }[] = [];
  for (const thread of threads) {
    const kind = attentionKind(thread, signals);
    if (kind) items.push({ thread, kind });
  }
  return items.sort((a, b) => ATTENTION_RANK[a.kind] - ATTENTION_RANK[b.kind] || b.thread.updated_at.localeCompare(a.thread.updated_at));
}
