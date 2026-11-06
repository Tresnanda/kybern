// Keeping threads warm (#248): bounded prefetch of the first page for threads a
// reader is likely to open next, and a linger that keeps a closed thread's
// subscription and cursor alive for a while so reopening it costs nothing.

/** Rows from the top of the visible list that are prefetched. */
export const PREFETCH_TOP_ROWS = 6;
/** First pages fetched at once. */
export const PREFETCH_CONCURRENCY = 2;
/** Hover time before a row is prefetched (desktop). */
export const PREFETCH_HOVER_MS = 120;
/** How long a closed thread keeps its subscription and cursor. */
export const THREAD_LINGER_MS = 5 * 60 * 1000;
/** Running threads kept subscribed in the background (desktop), most recently viewed first. */
export const BACKGROUND_RUNNING_THREADS = 8;

interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface PrefetchQueueOptions {
  /** Fetch and keep one thread's first page. Errors are swallowed; the thread is retried on a later `want`. */
  run: (threadId: string) => Promise<unknown>;
  /** Threads that need no fetch (open, cached at their current `last_seq`, or on a machine that is offline). */
  skip?: (threadId: string) => boolean;
  limit?: number;
  concurrency?: number;
}

export interface PrefetchQueue {
  /** Replace the wish list with these threads, in priority order (only the first `limit` are kept). */
  want(threadIds: readonly string[]): void;
  /** Put one thread first (hover). */
  bump(threadId: string): void;
  /** Threads fetched by this queue. */
  readonly done: ReadonlySet<string>;
  /** Forget fetched threads (their data changed or was dropped). */
  invalidate(threadId?: string): void;
  dispose(): void;
}

export function createPrefetchQueue(options: PrefetchQueueOptions): PrefetchQueue {
  const limit = options.limit ?? PREFETCH_TOP_ROWS;
  const concurrency = options.concurrency ?? PREFETCH_CONCURRENCY;
  let queue: string[] = [];
  const inFlight = new Set<string>();
  const done = new Set<string>();
  let disposed = false;

  const eligible = (id: string) => !inFlight.has(id) && !done.has(id) && !options.skip?.(id);
  const pump = () => {
    while (!disposed && inFlight.size < concurrency && queue.length) {
      const id = queue.shift()!;
      if (!eligible(id)) continue;
      inFlight.add(id);
      void options
        .run(id)
        .then(
          () => {
            done.add(id);
          },
          () => {},
        )
        .finally(() => {
          inFlight.delete(id);
          pump();
        });
    }
  };

  return {
    want(threadIds) {
      queue = threadIds.filter(eligible).slice(0, limit);
      pump();
    },
    bump(threadId) {
      if (!eligible(threadId)) return;
      queue = [threadId, ...queue.filter((id) => id !== threadId)].slice(0, limit);
      pump();
    },
    done,
    invalidate(threadId) {
      if (threadId === undefined) done.clear();
      else done.delete(threadId);
    },
    dispose() {
      disposed = true;
      queue = [];
    },
  };
}

export interface LingerOptions {
  /** Called when a released thread's linger ran out, or it was pushed out by `max`. */
  expire: (threadId: string) => void;
  lingerMs?: number;
  /** Released threads kept at once; the least recently released go first. */
  max?: number;
  timers?: Timers;
}

export interface Linger {
  /** The thread is open again: it no longer expires. Returns whether it was lingering. */
  hold(threadId: string): boolean;
  /** The thread was closed: expire it after the linger. */
  release(threadId: string): void;
  has(threadId: string): boolean;
  /** Expire everything now (disconnect, machine removed). */
  expireAll(): void;
}

export function createLinger(options: LingerOptions): Linger {
  const lingerMs = options.lingerMs ?? THREAD_LINGER_MS;
  const max = options.max ?? Number.POSITIVE_INFINITY;
  const timers = options.timers ?? defaultTimers;
  // Insertion order is release order.
  const lingering = new Map<string, unknown>();

  const expire = (threadId: string) => {
    const timer = lingering.get(threadId);
    if (!lingering.delete(threadId)) return;
    timers.clearTimeout(timer);
    options.expire(threadId);
  };

  return {
    hold(threadId) {
      const timer = lingering.get(threadId);
      if (!lingering.delete(threadId)) return false;
      timers.clearTimeout(timer);
      return true;
    },
    release(threadId) {
      const old = lingering.get(threadId);
      if (lingering.delete(threadId)) timers.clearTimeout(old);
      lingering.set(threadId, timers.setTimeout(() => expire(threadId), lingerMs));
      while (lingering.size > max) expire(lingering.keys().next().value as string);
    },
    has: (threadId) => lingering.has(threadId),
    expireAll() {
      for (const threadId of [...lingering.keys()]) expire(threadId);
    },
  };
}

/**
 * The running threads to keep subscribed in the background: the most recently
 * viewed first, at most `max`. `recent` is most recent first.
 */
export function backgroundThreads(recent: readonly string[], running: ReadonlySet<string>, max = BACKGROUND_RUNNING_THREADS): string[] {
  const out: string[] = [];
  for (const id of recent) {
    if (out.length >= max) break;
    if (running.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}
