// Optimistic sends. Enter shows the message in the transcript on the same frame, before `threads.send`/`threads.steer`
// answers: the composer adds a pending user block with the message id it then sends (`message_id`, or the steer `id`).
// The daemon's `turn_started`/`message_steered` block carries that id, so the transcript swaps the pending block for the
// real one by id, under the same row (clients key the turn by the user id): no duplicate, jump or replayed entrance. A
// rejected send stays as a failed bubble with Retry and Edit. The model is plain data; each client owns one store.
import type { Block } from "./transcript.ts";
import type { MachineId, OutboxItem, ThreadId, TurnId, UserMessage } from "./types.ts";

export interface PendingSend {
  id: string;
  threadId: ThreadId;
  message: UserMessage;
  at: string;
  delivery: "send" | "steer";
  /** `accepted`: the daemon answered; the block shows until its own event arrives. `waiting`: queued in the outbox for a
   *  machine that is away; it stays until the machine takes it (no timeout, the wait can be days). */
  state: "sending" | "accepted" | "waiting" | "failed";
  error?: string;
  /** The machine a `waiting` send is for. */
  machineId?: MachineId;
}

/** How long an accepted send waits for its event before it is dropped (the thread was closed meanwhile; reopening loads it). */
export const ACCEPTED_TTL_MS = 60_000;

const NONE: readonly PendingSend[] = [];

export interface PendingStore {
  /** The thread's pending sends; the same array until they change, so it works as a snapshot for `useSyncExternalStore`. */
  pendingFor(threadId: ThreadId | null | undefined): readonly PendingSend[];
  subscribe(listener: () => void): () => void;
  add(send: PendingSend): void;
  update(threadId: ThreadId, id: string, patch: Partial<Pick<PendingSend, "state" | "error" | "machineId">>): void;
  remove(threadId: ThreadId, id: string): void;
  /** Forget everything (another daemon environment). */
  clear(): void;
}

export function createPendingStore(): PendingStore {
  const byThread = new Map<ThreadId, readonly PendingSend[]>();
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of [...listeners]) listener();
  };
  const pendingFor = (threadId: ThreadId | null | undefined): readonly PendingSend[] => (threadId && byThread.get(threadId)) || NONE;
  const write = (threadId: ThreadId, next: readonly PendingSend[]) => {
    if (next.length) byThread.set(threadId, next);
    else byThread.delete(threadId);
    emit();
  };
  const remove = (threadId: ThreadId, id: string) => {
    const list = pendingFor(threadId);
    if (list.some((p) => p.id === id)) write(threadId, list.filter((p) => p.id !== id));
  };
  return {
    pendingFor,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    add(send) {
      write(send.threadId, [...pendingFor(send.threadId).filter((p) => p.id !== send.id), send]);
    },
    update(threadId, id, patch) {
      const list = pendingFor(threadId);
      if (!list.some((p) => p.id === id)) return;
      write(threadId, list.map((p) => (p.id === id ? { ...p, ...patch } : p)));
      if (patch.state === "accepted") {
        setTimeout(() => {
          if (pendingFor(threadId).some((p) => p.id === id && p.state === "accepted")) remove(threadId, id);
        }, ACCEPTED_TTL_MS);
      }
    },
    remove,
    clear() {
      if (!byThread.size) return;
      byThread.clear();
      emit();
    },
  };
}

/** Pending sends whose real block is in `blocks` now: the caller removes them (outside render). */
export function settledPending(blocks: readonly Block[], pending: readonly PendingSend[]): string[] {
  if (!pending.length) return [];
  const ids = new Set(pending.map((p) => p.id));
  const settled: string[] = [];
  // Real user blocks arrive at the tail; a short scan from the end finds them.
  for (let i = blocks.length - 1, seen = 0; i >= 0 && seen < 400 && settled.length < ids.size; i--, seen++) {
    const block = blocks[i]!;
    if (block.kind === "user" && ids.has(block.id)) settled.push(block.id);
  }
  return settled;
}

const merged = new WeakMap<readonly Block[], { pending: readonly PendingSend[]; blocks: Block[] }>();
/** `blocks` plus a user block per pending send not yet in them, each its own turn (`pending:<id>`). The same inputs
 *  return the same array, so grouping and row caches keep their identity. */
export function withPending(blocks: Block[], pending: readonly PendingSend[]): Block[] {
  if (!pending.length) return blocks;
  const cached = merged.get(blocks);
  if (cached?.pending === pending) return cached.blocks;
  const settled = new Set(settledPending(blocks, pending));
  // A steer joins the running turn, as its `message_steered` block will; a send opens its own turn.
  const live = blocks.at(-1)?.turnId;
  const extra = pending.filter((p) => !settled.has(p.id)).map((p) => pendingBlock(p, p.delivery === "steer" && live ? live : `pending:${p.id}`));
  const result = extra.length ? [...blocks, ...extra] : blocks;
  merged.set(blocks, { pending, blocks: result });
  return result;
}

const blocksFor = new Map<string, Block>();
function pendingBlock(send: PendingSend, turnId: TurnId): Block {
  // One object per send, so a pending row keeps its identity while other sends change.
  const key = `${send.id}:${send.at}:${turnId}`;
  let block = blocksFor.get(key);
  if (!block) {
    block = { kind: "user", id: send.id, turnId, at: send.at, seq: Number.MAX_SAFE_INTEGER, message: send.message };
    blocksFor.set(key, block);
    if (blocksFor.size > 64) blocksFor.delete(blocksFor.keys().next().value!);
  }
  return block;
}

// ---- sends queued for another machine (machine network design §6.1, §6.4) ----
//
// A composer send to a machine that is away goes into the outbox of the machine the user is at (`outbox.enqueue`). The
// thread the client named does not exist anywhere until that machine takes it, so the client shows it as waiting.

/** What the person reads on a send waiting for a machine: "Waiting for satyamas". */
export const waitingLabel = (machineName: string): string => `Waiting for ${machineName}`;

/** Where a queued send stands, from its outbox item. */
export type QueuedPhase =
  | { phase: "waiting"; label: string; attempts: number }
  | { phase: "delivered" }
  | { phase: "failed"; error: string };

/** The outbox states a client shows as "waiting": the item will still be delivered. */
export const isWaitingOutbox = (state: OutboxItem["state"]): boolean => state === "queued" || state === "sending";

/** Map an outbox item to the phase a send shows. Failed, expired and cancelled items are failures with words and a next step. */
export function queuedPhase(item: Pick<OutboxItem, "state" | "attempts" | "last_error">, machineName: string): QueuedPhase {
  switch (item.state) {
    case "queued":
    case "sending":
      return { phase: "waiting", label: waitingLabel(machineName), attempts: item.attempts };
    case "delivered":
      return { phase: "delivered" };
    case "expired":
      return { phase: "failed", error: `${machineName} did not come back in time. Retry to queue it again.` };
    case "cancelled":
      return { phase: "failed", error: "The send was cancelled. Retry to queue it again." };
    case "failed":
      return { phase: "failed", error: item.last_error?.trim() || `${machineName} could not start the chat. Retry, or edit the message.` };
  }
}

/** Whether an outbox item is a queued composer send (a new thread or a follow-up message). */
export const isComposerOutbox = (item: Pick<OutboxItem, "kind">): boolean => item.kind === "thread_create" || item.kind === "thread_send";

/** The thread id a queued composer send is for (`thread_create` names the new thread, `thread_send` the existing one). */
export function outboxThreadId(item: Pick<OutboxItem, "kind" | "payload">): ThreadId | undefined {
  if (!isComposerOutbox(item)) return undefined;
  const payload = item.payload as { thread_id?: unknown } | null;
  return typeof payload?.thread_id === "string" ? payload.thread_id : undefined;
}
