// What the client knows about thread messages after they were sent: a bounded record store per
// thread, folded from `threads.messages.list` and the `thread_message_*` events, and the live
// state a "Sent to" row shows from it. Pure, so any client can reuse it.

import { messageStateWord } from "./delegations.ts";
import type { SendResult, SendState } from "./orchestrationTools.ts";
import type { HeldResolution, ThreadMessageRecord, ThreadMessageState } from "./types.ts";

/** Records kept per thread. The daemon lists at most this many, newest first kept. */
export const MESSAGE_RECORD_LIMIT = 200;
/** Threads whose records are kept at once; the least recently touched go first. */
export const MESSAGE_THREAD_LIMIT = 24;

/** Everything one thread sent or received. `replies` maps a question's id to the id of its reply. */
export interface ThreadMessageIndex {
  readonly byId: Readonly<Record<string, ThreadMessageRecord>>;
  readonly replies: Readonly<Record<string, string>>;
  /** Whether `threads.messages.list` has been folded in since the connection opened. */
  readonly seeded: boolean;
}

export const EMPTY_MESSAGE_INDEX: ThreadMessageIndex = { byId: {}, replies: {}, seeded: false };

const timeOf = (value: string): number => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
};

/** Which of two records for one message wins. A listing never overrides an event it raced with. */
function newer(existing: ThreadMessageRecord | undefined, incoming: ThreadMessageRecord, fromListing: boolean): ThreadMessageRecord {
  if (!existing) return incoming;
  const a = timeOf(existing.updated_at);
  const b = timeOf(incoming.updated_at);
  if (b > a) return incoming;
  if (b < a) return existing;
  return fromListing || incoming.state === existing.state ? existing : incoming;
}

function trimmed(byId: Record<string, ThreadMessageRecord>, keep: string | null, limit: number): Record<string, ThreadMessageRecord> {
  const ids = Object.keys(byId);
  if (ids.length <= limit) return byId;
  const oldestFirst = ids.filter((id) => id !== keep).sort((x, y) => timeOf(byId[x]!.created_at) - timeOf(byId[y]!.created_at) || x.localeCompare(y));
  const next = { ...byId };
  for (let index = 0; index < ids.length - limit; index++) delete next[oldestFirst[index]!];
  return next;
}

function repliesOf(byId: Readonly<Record<string, ThreadMessageRecord>>): Record<string, string> {
  const replies: Record<string, string> = {};
  for (const record of Object.values(byId)) if (record.reply_to) replies[record.reply_to] = record.id;
  return replies;
}

/** Fold records into an index. Returns the same index when nothing changed, so selectors stay quiet. */
export function mergeMessages(index: ThreadMessageIndex | undefined, records: readonly ThreadMessageRecord[], options: { fromListing?: boolean; limit?: number } = {}): ThreadMessageIndex {
  const current = index ?? EMPTY_MESSAGE_INDEX;
  const limit = options.limit ?? MESSAGE_RECORD_LIMIT;
  let byId: Record<string, ThreadMessageRecord> | null = null;
  let replies: Record<string, string> | null = null;
  let last: string | null = null;
  for (const record of records) {
    const existing = (byId ?? current.byId)[record.id];
    const winner = newer(existing, record, options.fromListing === true);
    if (winner === existing) continue;
    byId ??= { ...current.byId };
    byId[record.id] = winner;
    last = record.id;
    if (winner.reply_to && (replies ?? current.replies)[winner.reply_to] !== winner.id) {
      replies ??= { ...current.replies };
      replies[winner.reply_to] = winner.id;
    }
  }
  const seeded = current.seeded || options.fromListing === true;
  if (!byId) return seeded === current.seeded ? current : { ...current, seeded };
  const bounded = trimmed(byId, last, limit);
  return { byId: bounded, replies: bounded === byId ? (replies ?? current.replies) : repliesOf(bounded), seeded };
}

/** A held message the reader delivered or dismissed. Only a still-held record moves; a later event stays authoritative. */
export function resolveMessage(index: ThreadMessageIndex | undefined, messageId: string, resolution: HeldResolution): ThreadMessageIndex | undefined {
  const record = index?.byId[messageId];
  if (!index || !record || record.state !== "held") return index;
  const state: ThreadMessageState = resolution === "delivered" ? "delivered" : "dismissed";
  return { ...index, byId: { ...index.byId, [messageId]: { ...record, state, held_reason: null } } };
}

/** Forget that an index was seeded (the connection dropped, so events may have been missed). */
export function unseedAll<T extends Record<string, ThreadMessageIndex>>(all: T): T {
  let changed = false;
  const next: Record<string, ThreadMessageIndex> = {};
  for (const [id, index] of Object.entries(all)) {
    next[id] = index.seeded ? { ...index, seeded: false } : index;
    changed ||= index.seeded;
  }
  return changed ? (next as T) : all;
}

/** Put one thread's index in the table, most recent last, and drop the least recently touched beyond the limit. */
export function setThreadIndex<T extends Record<string, ThreadMessageIndex>>(all: T, threadId: string, index: ThreadMessageIndex, keep: (threadId: string) => boolean = () => false, limit = MESSAGE_THREAD_LIMIT): T {
  if (all[threadId] === index && Object.keys(all).at(-1) === threadId) return all;
  const next: Record<string, ThreadMessageIndex> = { ...all };
  delete next[threadId];
  next[threadId] = index;
  // Keys keep insertion order, so the front is the least recently touched.
  let excess = Object.keys(next).length - limit;
  for (const id of Object.keys(next)) {
    if (excess <= 0) break;
    if (id === threadId || keep(id)) continue;
    delete next[id];
    excess -= 1;
  }
  return next as T;
}

export const messageOf = (index: ThreadMessageIndex | undefined, messageId: string | null | undefined): ThreadMessageRecord | undefined =>
  index && messageId ? index.byId[messageId] : undefined;

/** The reply to a message, when its record is known. */
export function replyOf(index: ThreadMessageIndex | undefined, messageId: string | null | undefined): ThreadMessageRecord | undefined {
  const id = index && messageId ? index.replies[messageId] : undefined;
  return id ? index!.byId[id] : undefined;
}

// ---- the "Sent to" row ----

export type LiveSendState = SendState | "dismissed";

export interface LiveSend {
  state: LiveSendState | null;
  /** `Queued`, `Sent now`, `Delivered`, `Held for approval`, `Dismissed`, `Answered`, `Not delivered`, or `Sending` / `Not sent` / `Sent` before there is a result. */
  word: string;
  reply: { messageId: string; fromThreadId: string; body: string } | null;
  /** Still waiting for the reader's approval. */
  held: boolean;
}

/**
 * What a "Sent to" row shows. The tool output says how the send stood when it returned; the live
 * record (a message's state changes after that) and its reply, when known, are newer and win.
 */
export function liveSend(result: SendResult | null, record: ThreadMessageRecord | undefined, reply: ThreadMessageRecord | undefined, complete: boolean, isError: boolean): LiveSend {
  if (isError) return { state: "failed", word: "Not sent", reply: null, held: false };
  if (!complete) return { state: null, word: "Sending", reply: null, held: false };
  const answer = reply ? { messageId: reply.id, fromThreadId: reply.from_thread_id ?? "", body: reply.body } : (result?.reply ?? null);
  const base = record?.state ?? result?.state ?? null;
  if (base === "dismissed" || base === "failed") return { state: base, word: messageStateWord(base), reply: null, held: false };
  if (answer || base === "answered") return { state: "answered", word: "Answered", reply: answer, held: false };
  if (!base) return { state: null, word: "Sent", reply: null, held: false };
  return { state: base, word: messageStateWord(base), reply: null, held: base === "held" };
}
