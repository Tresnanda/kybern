import { describe, expect, test } from 'bun:test'
import type { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import { emptyThreadState, seedFromGet, type ThreadState } from '../../../../packages/kybern-client/src/transcript.ts'
import type { EventsSubscribeParams, ThreadEvent, ThreadsGetResult } from '../../../../packages/kybern-client/src/types.ts'
import { keepRowIdentity, openThreadStream } from './openFlow.ts'

const AT = '2026-11-01T00:00:00Z'
const thread = (last_seq: number) => ({ id: 'th', title: 'T', status: 'idle', last_seq, project_id: 'p', updated_at: AT, provider: { kind: 'claude-code', instance: 'default' } })
const userEntry = (n: number, seq: number) => ({ role: 'user', id: `m${n}`, turn_id: `t${n}`, seq, at: AT, message: { parts: [{ type: 'text', text: `prompt ${n}` }] } })
function page(lastSeq: number, entries: number[], extra: Partial<ThreadsGetResult> = {}): ThreadsGetResult {
  return { thread: thread(lastSeq), transcript: entries.map((seq, i) => userEntry(i, seq)), pending_approvals: [], next_before_seq: null, ...extra } as unknown as ThreadsGetResult
}
/** A user prompt event at `seq`: each adds one row. */
const prompt = (seq: number): ThreadEvent => ({ seq, thread_id: 'th', turn_id: `e${seq}`, at: AT, kind: 'turn_started', message_id: `e${seq}`, message: { parts: [{ type: 'text', text: `live ${seq}` }] } }) as unknown as ThreadEvent

type Sub = { params: EventsSubscribeParams; handler: (e: ThreadEvent) => void; onSubscribed?: (head: number, replay: { resumed: boolean; supported: boolean }) => void; onReady?: (head: number, resumed: boolean) => void; onSnapshot?: (s: ThreadsGetResult, head: number) => void; stopped: boolean }
/** A client whose answers the test releases by hand, in the order it wants. */
function fakeClient() {
  const log: string[] = []
  const subs: Sub[] = []
  const calls: { method: string; params: any; resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = []
  const client = {
    call(method: string, params: unknown) {
      log.push(method)
      return new Promise((resolve, reject) => calls.push({ method, params, resolve, reject }))
    },
    subscribeEvents(params: EventsSubscribeParams, handler: Sub['handler'], onSubscribed?: Sub['onSubscribed'], onReady?: Sub['onReady'], onSnapshot?: Sub['onSnapshot']) {
      log.push(`subscribe${params.after_seq !== undefined ? `@${params.after_seq}` : ''}${params.gap_snapshot ? '+gap' : ''}`)
      const sub: Sub = { params, handler, ...(onSubscribed ? { onSubscribed } : {}), ...(onReady ? { onReady } : {}), ...(onSnapshot ? { onSnapshot } : {}), stopped: false }
      subs.push(sub)
      return { unsubscribe: () => { sub.stopped = true }, lastSeq: undefined }
    },
  }
  return { client: client as unknown as KybernClient, log, subs, calls, answer: (method: string, value: unknown) => { const i = calls.findIndex(c => c.method === method); calls.splice(i, 1)[0]!.resolve(value) } }
}
function harness(initial: ThreadState = emptyThreadState()) {
  let state = initial
  const sources: string[] = []
  return { get: () => state, set: (next: ThreadState, source: string) => { state = next; sources.push(source) }, sources, state: () => state }
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const texts = (state: ThreadState) => state.blocks.map(b => b.id)

describe('opening a thread in one round trip', () => {
  test('subscribe and threads.get go out together; buffered events at or below the page are dropped', async () => {
    const f = fakeClient(), h = harness()
    const stream = openThreadStream(f.client, { threadId: 'th' }, h)
    expect(f.log).toEqual(['subscribe', 'threads.get'])
    expect(f.calls[0]!.params.page_budget).toEqual({ turns: 10, max_rows: 500, max_bytes: 1024 * 1024 })
    expect(f.calls[0]!.params.transcript_limit).toBe(120)
    f.subs[0]!.onSubscribed!(10, { resumed: false, supported: true })
    // Live events arrive before the page: one already in it (seq 11), one after it (13).
    f.subs[0]!.handler(prompt(11)); f.subs[0]!.handler(prompt(13))
    expect(h.sources).toEqual([])
    f.answer('threads.get', page(12, [5, 11], { as_of_seq: 12 }))
    await flush()
    f.subs[0]!.onReady!(10, false)
    await stream.live
    expect(h.sources).toEqual(['daemon', 'event'])
    expect(h.state().lastSeq).toBe(13)
    expect(h.state().blocks.filter(b => b.kind === 'user').length).toBe(3)
    expect(f.log).not.toContain('events.range')
    f.subs[0]!.handler(prompt(13)) // a duplicate after the page changes nothing
    expect(h.sources).toEqual(['daemon', 'event'])
  })

  test('a page older than the subscription start reads the gap with events.range first', async () => {
    const f = fakeClient(), h = harness()
    const stream = openThreadStream(f.client, { threadId: 'th' }, h)
    f.subs[0]!.onSubscribed!(20, { resumed: false, supported: false })
    f.subs[0]!.handler(prompt(21))
    f.answer('threads.get', page(12, [5], { as_of_seq: 15 }))
    await flush()
    expect(f.log.at(-1)).toBe('events.range')
    expect(f.calls[0]!.params).toMatchObject({ thread_id: 'th', after_seq: 12 })
    f.answer('events.range', { events: [prompt(14), prompt(18)], has_more: false })
    await stream.live
    expect(h.state().blocks.map(b => b.seq)).toEqual([5, 14, 18, 21])
  })

  test('a daemon without as_of_seq gets the same gap read, and the client learns it', async () => {
    const f = fakeClient(), h = harness()
    let learned: boolean | undefined
    const stream = openThreadStream(f.client, { threadId: 'th' }, { ...h, learned: v => { learned = v } })
    f.subs[0]!.onSubscribed!(9, { resumed: false, supported: false })
    f.answer('threads.get', page(9, [5]))
    await flush()
    expect(learned).toBe(false)
    f.answer('events.range', { events: [], has_more: false })
    await stream.live
    expect(h.sources).toEqual(['daemon'])
  })

  test('a daemon known to be old keeps the old order: page, then subscribe after it', async () => {
    const f = fakeClient(), h = harness()
    const stream = openThreadStream(f.client, { threadId: 'th', capable: false }, h)
    expect(f.log).toEqual(['threads.get'])
    f.answer('threads.get', page(12, [5]))
    await flush()
    expect(f.log).toEqual(['threads.get', 'subscribe@12'])
    f.subs[0]!.onSubscribed!(12, { resumed: true, supported: false })
    await stream.live
    expect(h.sources).toEqual(['daemon'])
  })

  test('the page is drawn (ready) before the subscription is acknowledged; events wait for it', async () => {
    const f = fakeClient(), h = harness()
    const stream = openThreadStream(f.client, { threadId: 'th' }, h)
    f.answer('threads.get', page(12, [5], { as_of_seq: 12 }))
    await stream.ready
    expect(h.sources).toEqual(['daemon'])
    f.subs[0]!.handler(prompt(14))
    expect(h.sources).toEqual(['daemon'])
    f.subs[0]!.onSubscribed!(12, { resumed: false, supported: false })
    await stream.live
    expect(h.sources).toEqual(['daemon', 'event'])
  })

  test('stopping releases whoever awaits the open and applies nothing more', async () => {
    const f = fakeClient(), h = harness()
    const stream = openThreadStream(f.client, { threadId: 'th' }, h)
    stream.stop()
    await stream.ready; await stream.live
    f.answer('threads.get', page(12, [5], { as_of_seq: 12 }))
    await flush()
    expect(h.sources).toEqual([])
    expect(f.subs[0]!.stopped).toBe(true)
  })

  test('a failed page rejects ready', async () => {
    const f = fakeClient(), h = harness()
    const stream = openThreadStream(f.client, { threadId: 'th' }, h)
    f.calls[0]!.reject(new Error('gone'))
    await expect(stream.ready).rejects.toThrow('gone')
  })
})

describe('opening from a cached copy', () => {
  const cachedState = () => ({ ...seedFromGet(page(12, [5, 11]) as ThreadsGetResult), loaded: true })

  test('draws the copy first and resumes from its cursor with a gap snapshot, without threads.get', async () => {
    const f = fakeClient(), h = harness()
    const cached = cachedState()
    const stream = openThreadStream(f.client, { threadId: 'th', cached: { lastSeq: 12, data: cached }, capable: true }, h)
    expect(h.sources).toEqual(['cache'])
    expect(f.log).toEqual(['subscribe@12+gap'])
    expect(f.subs[0]!.params.gap_snapshot).toMatchObject({ thread_id: 'th', page_budget: { turns: 10 } })
    f.subs[0]!.onSubscribed!(15, { resumed: true, supported: true })
    f.subs[0]!.handler(prompt(14)) // the replay
    f.subs[0]!.onReady!(15, true)
    await stream.live
    expect(h.state().blocks.map(b => b.seq)).toEqual([5, 11, 14])
    expect(f.log).toEqual(['subscribe@12+gap'])
  })

  test('a gap snapshot replaces the copy and keeps unchanged rows as the same objects', async () => {
    const f = fakeClient(), h = harness()
    const cached = cachedState()
    openThreadStream(f.client, { threadId: 'th', cached: { lastSeq: 12, data: cached }, capable: true }, h)
    const shown = h.state().blocks
    f.subs[0]!.onSnapshot!(page(400, [5, 11, 300]), 400)
    expect(h.sources).toEqual(['cache', 'snapshot'])
    expect(h.state().blocks.length).toBe(3)
    expect(h.state().blocks[0]).toBe(shown[0]!)
    expect(h.state().blocks[1]).toBe(shown[1]!)
    expect(h.state().lastSeq).toBe(400)
    f.subs[0]!.handler(prompt(399)) // covered by the snapshot
    f.subs[0]!.handler(prompt(401))
    expect(h.state().blocks.map(b => b.seq)).toEqual([5, 11, 300, 401])
  })

  test('with an unknown daemon the copy shows while the page loads, then the page replaces it in place', async () => {
    const f = fakeClient(), h = harness()
    const cached = cachedState()
    const stream = openThreadStream(f.client, { threadId: 'th', cached: { lastSeq: 12, data: cached } }, h)
    expect(h.sources).toEqual(['cache'])
    expect(f.log).toEqual(['subscribe', 'threads.get'])
    const shown = h.state().blocks
    f.subs[0]!.onSubscribed!(13, { resumed: false, supported: false })
    f.answer('threads.get', page(13, [5, 11, 13], { as_of_seq: 13 }))
    await stream.live
    expect(h.state().blocks[0]).toBe(shown[0]!)
    expect(texts(h.state())).toEqual(['m0', 'm1', 'm2'])
  })
})

test('keepRowIdentity reuses equal rows only', () => {
  const a = seedFromGet(page(3, [1, 2]))
  const b = seedFromGet(page(3, [1, 2]))
  const kept = keepRowIdentity(a, b)
  expect(kept.blocks[0]).toBe(a.blocks[0]!)
  const changed = seedFromGet({ ...page(3, [1]), transcript: [{ ...userEntry(0, 1), message: { parts: [{ type: 'text', text: 'edited' }] } }] } as unknown as ThreadsGetResult)
  expect(keepRowIdentity(a, changed).blocks[0]).not.toBe(a.blocks[0]!)
})
