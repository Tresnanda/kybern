// Opening a thread's transcript stream (#248, `perf/instant-load-2026-11`). Headless: no native or React imports, so
// the bench replays exactly this code.
//
// - A cached copy (disk cache, prefetch, a lingering session) is shown first. On a daemon that answers `gap_snapshot`,
//   the stream resumes from the cached cursor: the daemon replays the few events since, or sends one fresh page when
//   the gap is large. No `threads.get` at all.
// - Without a usable cache: `events.subscribe` and `threads.get` go out together on the same socket. Live events are
//   buffered until the page arrives; those at or below the page's `thread.last_seq` are dropped. The page's `as_of_seq`
//   must cover the subscription's `head_seq`; otherwise (and on daemons without `as_of_seq`) the gap is read with
//   `events.range` before the buffered events are applied.
// - A daemon known not to have either (0.21.6-0.21.8, no list cursor) keeps the old order: page, then subscribe.
//
// Rows that did not change keep their objects when a page replaces a cached copy, so nothing remounts.
import type { KybernClient, Subscription } from '../../../../packages/kybern-client/src/client.ts'
import { FIRST_PAGE_BUDGET } from '../../../../packages/kybern-client/src/historyPaging.ts'
import { applyEvent, seedFromGet, type Block, type ThreadState } from '../../../../packages/kybern-client/src/transcript.ts'
import type { ThreadEvent, ThreadsGetParams, ThreadsGetResult } from '../../../../packages/kybern-client/src/types.ts'

/** The first page: sized by turns and bytes on new daemons, 120 rows on old ones. */
export const firstPageParams = (threadId: string): ThreadsGetParams => ({
  thread_id: threadId, transcript_limit: 120, page_budget: { ...FIRST_PAGE_BUDGET }, include_tool_output: false,
})

export type OpenSource = 'cache' | 'daemon' | 'snapshot'
export interface OpenHandlers {
  /** The state the stream folds into (the session's, which history paging also changes). */
  get(): ThreadState
  /** A new state: a seed (cache, page or snapshot) or one folded event. */
  set(next: ThreadState, source: OpenSource | 'event', event?: ThreadEvent): void
  /** Whether a `threads.get` page or snapshot said the daemon has `as_of_seq` (remembered per client by the caller). */
  learned?(capable: boolean): void
}
export interface OpenOptions {
  threadId: string
  /** A copy to show first, and to resume from when the daemon is capable. */
  cached?: { lastSeq: number; data: ThreadState }
  /** true: the daemon answers `as_of_seq` and `gap_snapshot`; false: known not to; undefined: not known yet. */
  capable?: boolean
}
export interface OpenStream {
  /** Settles when the content shown is the daemon's (a page, a snapshot, or an acknowledged resume); rejects when the page failed. */
  ready: Promise<void>
  /** Settles when the stream is live too: subscribed, replay finished, buffered events applied. */
  live: Promise<void>
  /** Rows came from the daemon (a page, a snapshot, or a resumed replay). */
  readonly fresh: boolean
  /** Unsubscribe and apply nothing more; `ready` and `live` settle. */
  stop(): void
}

const rowKey = (block: Block) => `${block.kind}:${block.id}`
/** `next` with every row that is unchanged from `previous` replaced by the previous object (row identity). */
export function keepRowIdentity(previous: ThreadState, next: ThreadState): ThreadState {
  if (!previous.blocks.length) return next
  const byKey = new Map(previous.blocks.map(block => [rowKey(block), block]))
  let reused = 0
  const blocks = next.blocks.map(block => {
    const old = byKey.get(rowKey(block))
    if (old && (old === block || JSON.stringify(old) === JSON.stringify(block))) { reused++; return old }
    return block
  })
  return reused ? { ...next, blocks } : next
}

const seedOver = (current: ThreadState, page: ThreadsGetResult) => keepRowIdentity(current, seedFromGet(page, current))

export function openThreadStream(owner: KybernClient, options: OpenOptions, h: OpenHandlers): OpenStream {
  const { threadId, cached } = options
  let stopped = false
  let fresh = false
  let sub: Subscription | undefined
  let resolveReady!: () => void, rejectReady!: (error: unknown) => void
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  let resolveLive!: () => void, rejectLive!: (error: unknown) => void
  const live = new Promise<void>((resolve, reject) => { resolveLive = resolve; rejectLive = reject })
  // Callers that ignore either must not see an unhandled rejection.
  ready.catch(() => {}); live.catch(() => {})
  const fail = (error: unknown) => { rejectReady(error); rejectLive(error) }
  /** Stopped: nothing more is applied, and whoever awaits the open is released. */
  const halt = () => { stopped = true; sub?.unsubscribe(); resolveReady(); resolveLive() }

  /** Highest event folded; events at or below it are already in the state. */
  let applied = 0
  /** Live events wait here until the page and any gap read are in. */
  let buffer: ThreadEvent[] | null = []
  const fold = (event: ThreadEvent) => {
    if (stopped || event.seq <= applied) return
    applied = event.seq
    h.set(applyEvent(h.get(), event), 'event', event)
  }
  const deliver = (event: ThreadEvent) => { if (buffer) buffer.push(event); else fold(event) }
  const drain = () => {
    const pending = buffer ?? []
    buffer = null
    for (const event of pending) fold(event)
  }

  if (cached) h.set({ ...cached.data, loaded: true, loadingEarlier: false }, 'cache')

  // ---- resume from the cached cursor: no page at all ----
  if (cached && options.capable === true) {
    applied = cached.lastSeq
    buffer = null
    let subscribed = false
    sub = owner.subscribeEvents(
      { thread_id: threadId, after_seq: cached.lastSeq, include_tool_output: false, gap_snapshot: firstPageParams(threadId) },
      fold,
      (_head, replay) => { subscribed = true; fresh = true; resolveReady(); if (!replay.supported) resolveLive() },
      () => { resolveReady(); resolveLive() },
      (snapshot, _head) => {
        if (stopped) return
        applied = snapshot.thread.last_seq
        fresh = true
        h.learned?.(true)
        h.set(seedOver(h.get(), snapshot), 'snapshot')
      },
    )
    return { ready, live, get fresh() { return fresh || subscribed }, stop: halt }
  }

  // ---- the old order, for daemons known to answer neither ----
  if (options.capable === false) {
    void (async () => {
      try {
        const page = await owner.call('threads.get', firstPageParams(threadId))
        if (stopped) return
        applied = page.thread.last_seq
        buffer = null
        fresh = true
        h.set(seedOver(h.get(), page), 'daemon')
        resolveReady()
        sub = owner.subscribeEvents(
          { thread_id: threadId, after_seq: page.thread.last_seq, include_tool_output: false },
          fold,
          (_head, replay) => { if (!replay.supported) resolveLive() },
          () => resolveLive(),
        )
        if (stopped) sub.unsubscribe()
      } catch (error) { fail(error) }
    })()
    return { ready, live, get fresh() { return fresh }, stop: halt }
  }

  // ---- one round trip: subscribe and read the page together ----
  let head: number | undefined
  let liveReady = false
  let onHead: (() => void) | undefined
  sub = owner.subscribeEvents(
    { thread_id: threadId, include_tool_output: false },
    deliver,
    (headSeq, replay) => { head = headSeq; if (!replay.supported) liveReady = true; onHead?.() },
    () => { liveReady = true; onHead?.() },
  )
  const headKnown = () => new Promise<void>(resolve => { if (head !== undefined) resolve(); else onHead = () => { if (head !== undefined) resolve() } })
  const liveNow = () => new Promise<void>(resolve => {
    if (liveReady) return resolve()
    const previous = onHead
    onHead = () => { previous?.(); if (liveReady) resolve() }
  })
  void (async () => {
    try {
      const page = await owner.call('threads.get', firstPageParams(threadId))
      if (stopped) return
      h.learned?.(page.as_of_seq !== undefined)
      applied = page.thread.last_seq
      fresh = true
      // The page is drawn at once; events wait until it is known to cover the subscription's start.
      h.set(seedOver(h.get(), page), 'daemon')
      resolveReady()
      await headKnown()
      if (stopped) return
      if (page.as_of_seq === undefined || page.as_of_seq < head!) {
        // Events between the page and the subscription's start may be in neither: read them.
        for (let more = true; more && !stopped;) {
          const range = await owner.call('events.range', { thread_id: threadId, after_seq: applied, limit: 500 })
          for (const event of range.events) fold(event)
          more = range.has_more && range.events.length > 0
        }
      }
      if (stopped) return
      drain()
      await liveNow()
      resolveLive()
    } catch (error) { fail(error) }
  })()
  return { ready, live, get fresh() { return fresh }, stop: halt }
}
