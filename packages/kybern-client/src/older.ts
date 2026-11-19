// The Older group at the bottom of each project's thread list. The daemon decides which threads are inactive
// (`Thread.older_at`, `crates/kybern-daemon/src/orchestrator/older.rs`); a client only knows what its reader has seen,
// so a thread that asks for the reader (unread, failed, waiting) stays in the main list until that is dealt with.
// GPUIX and mobile both group with these rules.
import { attentionKind, type AttentionSignals } from "./threadAttention.ts";
import type { OlderAfter, Thread } from "./types.ts";

/** Whether a listed thread belongs in its project's Older group. */
export function inOlder(thread: Thread, signals: AttentionSignals = {}): boolean {
  if (!thread.older_at || thread.pinned || thread.keep_out_of_older) return false;
  if (thread.status !== "idle" && thread.status !== "failed") return false;
  if (signals.pending?.[thread.id]) return false;
  return attentionKind(thread, signals) === null;
}

/** A project's threads split into the main list and the Older group, each in the order given. */
export function splitOlder<T extends Thread>(threads: readonly T[], signals: AttentionSignals = {}): { recent: T[]; older: T[] } {
  const recent: T[] = [];
  const older: T[] = [];
  for (const thread of threads) (inOlder(thread, signals) ? older : recent).push(thread);
  return { recent, older };
}

/** The choices of "Move inactive threads to Older", in menu order. */
export const OLDER_AFTER_CHOICES: readonly { value: OlderAfter; label: string }[] = [
  { value: "never", label: "Never" },
  { value: "three_days", label: "3 days" },
  { value: "seven_days", label: "7 days" },
  { value: "thirty_days", label: "30 days" },
];

/** The setting's value, with the daemon's default when a settings document leaves it out. */
export const olderAfter = (settings: { older_after?: OlderAfter | null } | null | undefined): OlderAfter =>
  settings?.older_after ?? "seven_days";
