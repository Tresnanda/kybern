// The bounded parts of keeping threads warm (#248), without app state so they can be tested: which closed sessions
// are dropped, and first pages fetched ahead of a click.
import type { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { seedFromGet } from '../../../../packages/kybern-client/src/transcript.ts'
import { BACKGROUND_RUNNING_THREADS, PREFETCH_TOP_ROWS, backgroundThreads, createPrefetchQueue } from '../../../../packages/kybern-client/src/threadWarmth.ts'
import type { Thread } from '../../../../packages/kybern-client/src/types.ts'
import { firstPageParams } from './openFlow.ts'
import { cachedSeqOf, isCapable, learnCapable, noteCachedSeq, putPrefetched } from './warm.ts'

/** Sessions no pane shows, kept at most this many besides the running ones kept in the background. */
export const LINGERING_MAX = 24

/**
 * Which hidden sessions to drop now: beyond `max`, the least recently viewed ones that are not among the
 * `BACKGROUND_RUNNING_THREADS` most recently viewed running threads. `viewed` is most recent first.
 */
export function sessionsToDrop(hidden: readonly string[], viewed: readonly string[], running: ReadonlySet<string>, max = LINGERING_MAX, backgroundMax = BACKGROUND_RUNNING_THREADS): string[] {
  if (hidden.length <= max) return []
  const background = new Set(backgroundThreads(viewed, running, backgroundMax))
  const rank = (key: string) => { const at = viewed.indexOf(key); return at < 0 ? Infinity : at }
  return hidden.filter(key => !background.has(key)).sort((a, b) => rank(b) - rank(a)).slice(0, hidden.length - max)
}

/** Whether a lingering session whose 5 minutes ran out stays: it is one of the background running threads. */
export function keepsRunningInBackground(key: string, viewed: readonly string[], running: ReadonlySet<string>, backgroundMax = BACKGROUND_RUNNING_THREADS): boolean {
  return backgroundThreads(viewed, running, backgroundMax).includes(key)
}

export interface ThreadPrefetchOptions {
  keyOf(threadId: string, machineId?: string): string
  /** The machine's client, or null while it cannot be reached. */
  clientFor(machineId?: string): KybernClient | null
  /** The listed thread (for its `last_seq`). */
  listed(threadId: string, machineId?: string): Pick<Thread, 'last_seq'> | undefined
  /** An open or lingering session already has it. */
  hasSession(key: string): boolean
  limit?: number
  concurrency?: number
}

/**
 * First pages fetched ahead of a click: the top rows of the list (at most 6) and a hovered row, two at a time, only
 * from daemons that resume from a cursor, skipping threads open already or cached at their current `last_seq`. The
 * page is kept as a warm copy (`putPrefetched`) that the open draws before any round trip.
 */
export function createThreadPrefetch(options: ThreadPrefetchOptions) {
  const targets = new Map<string, { threadId: string; machineId?: string }>()
  const target = (threadId: string, machineId?: string) => {
    const key = options.keyOf(threadId, machineId)
    targets.delete(key)
    targets.set(key, { threadId, ...(machineId ? { machineId } : {}) })
    while (targets.size > 64) targets.delete(targets.keys().next().value!)
    return key
  }
  const queue = createPrefetchQueue({
    limit: options.limit ?? PREFETCH_TOP_ROWS,
    ...(options.concurrency ? { concurrency: options.concurrency } : {}),
    run: async (key) => {
      const { threadId, machineId } = targets.get(key)!
      const owner = options.clientFor(machineId)
      if (!owner) throw Error('offline')
      const page = await owner.call('threads.get', firstPageParams(threadId))
      learnCapable(owner, page.as_of_seq !== undefined)
      if (options.hasSession(key)) return
      putPrefetched(key, { lastSeq: page.thread.last_seq, data: seedFromGet(page) })
      noteCachedSeq(key, page.thread.last_seq)
    },
    skip: (key) => {
      const found = targets.get(key)
      if (!found || options.hasSession(key)) return true
      const owner = options.clientFor(found.machineId)
      // Only daemons that resume from a cursor: on older ones a cached copy saves no round trip.
      if (!owner || isCapable(owner) !== true) return true
      const listed = options.listed(found.threadId, found.machineId)
      return !!listed && cachedSeqOf(key) === listed.last_seq
    },
  })
  return {
    /** The list's top rows, in order (only the first `limit` are fetched). */
    top(threads: readonly { id: string; machineId?: string; status?: string }[]) {
      queue.want(threads.filter(t => t.status !== 'archived').slice(0, options.limit ?? PREFETCH_TOP_ROWS).map(t => target(t.id, t.machineId)))
    },
    /** A hovered row goes first. */
    hover(threadId: string, machineId?: string) { queue.bump(target(threadId, machineId)) },
    /** Fetched again next time (its data changed or was dropped). */
    invalidate(threadId?: string, machineId?: string) { queue.invalidate(threadId === undefined ? undefined : options.keyOf(threadId, machineId)) },
    dispose() { queue.dispose() },
  }
}
