import { describe, expect, test } from 'bun:test'
import type { KybernClient } from '../../../../packages/kybern-client/src/client.ts'
import type { ThreadsGetResult } from '../../../../packages/kybern-client/src/types.ts'
import { createThreadPrefetch, keepsRunningInBackground, sessionsToDrop, LINGERING_MAX } from './warmPolicy.ts'
import { cachedSeqOf, forgetWarm, learnCapable, noteCachedSeq, takePrefetched } from './warm.ts'

const page = (id: string, last_seq: number) => ({ thread: { id, last_seq, title: id, status: 'idle' }, transcript: [], pending_approvals: [], as_of_seq: last_seq }) as unknown as ThreadsGetResult
function fakeClient() {
  const pending: { id: string; resolve: () => void }[] = []
  let peak = 0
  const client = {
    call(_method: string, params: { thread_id: string }) {
      return new Promise<ThreadsGetResult>(resolve => {
        pending.push({ id: params.thread_id, resolve: () => resolve(page(params.thread_id, 7)) })
        peak = Math.max(peak, pending.length)
      })
    },
  } as unknown as KybernClient
  return { client, pending, peak: () => peak, release: async () => { const next = pending.shift(); next?.resolve(); await new Promise(r => setTimeout(r, 0)) } }
}
const key = (id: string, machine?: string) => `${machine ?? 'local'}\u0001${id}`
const threads = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, last_seq: 7 }))

describe('prefetch', () => {
  test('fetches only the top 6 rows, at most 2 at a time, and keeps each page as a warm copy', async () => {
    forgetWarm()
    const f = fakeClient()
    learnCapable(f.client, true)
    const sessions = new Set<string>()
    const prefetch = createThreadPrefetch({ keyOf: key, clientFor: () => f.client, listed: id => threads(10).find(t => t.id === id), hasSession: k => sessions.has(k) })
    prefetch.top(threads(10))
    expect(f.pending.map(p => p.id)).toEqual(['t0', 't1'])
    for (let i = 0; i < 6; i++) await f.release()
    expect(f.peak()).toBe(2)
    expect(f.pending.length).toBe(0)
    for (let i = 0; i < 6; i++) expect(takePrefetched(key(`t${i}`))?.lastSeq).toBe(7)
    expect(takePrefetched(key('t6'))).toBeUndefined()
    prefetch.dispose()
  })

  test('skips threads that are open, cached at their current last_seq, or on a daemon without cursors', async () => {
    forgetWarm()
    const f = fakeClient(), old = fakeClient()
    learnCapable(f.client, true)
    learnCapable(old.client, false)
    const prefetch = createThreadPrefetch({
      keyOf: key, clientFor: m => (m === 'old' ? old.client : f.client), listed: id => ({ last_seq: id === 'stale' ? 9 : 7 }), hasSession: k => k === key('open'),
    })
    noteCachedSeq(key('current'), 7)
    noteCachedSeq(key('stale'), 7)
    prefetch.top([{ id: 'open' }, { id: 'current' }, { id: 'stale' }, { id: 'remote', machineId: 'old' }])
    expect(f.pending.map(p => p.id)).toEqual(['stale'])
    expect(old.pending.length).toBe(0)
    await f.release()
    expect(cachedSeqOf(key('stale'))).toBe(7)
    prefetch.dispose()
  })

  test('a hovered row goes first', async () => {
    forgetWarm()
    const f = fakeClient()
    learnCapable(f.client, true)
    const prefetch = createThreadPrefetch({ keyOf: key, clientFor: () => f.client, listed: () => undefined, hasSession: () => false, concurrency: 1 })
    prefetch.top(threads(3))
    prefetch.hover('hovered')
    await f.release()
    expect(f.pending.map(p => p.id)).toEqual(['hovered'])
    prefetch.dispose()
  })
})

describe('closed sessions', () => {
  test('at most 8 running threads stay subscribed in the background, the most recently viewed', () => {
    const viewed = Array.from({ length: 12 }, (_, i) => `r${i}`)
    const running = new Set(viewed)
    expect(viewed.filter(k => keepsRunningInBackground(k, viewed, running))).toEqual(viewed.slice(0, 8))
    expect(keepsRunningInBackground('idle', ['idle', ...viewed], running)).toBe(false)
  })

  test('past the bound, the least recently viewed idle sessions are dropped; background running ones stay', () => {
    const viewed = Array.from({ length: LINGERING_MAX + 4 }, (_, i) => `s${i}`)
    const running = new Set([viewed.at(-1)!])
    const dropped = sessionsToDrop(viewed, viewed, running)
    expect(dropped.length).toBe(4)
    expect(dropped).not.toContain(viewed.at(-1)!)
    expect(dropped).toEqual(viewed.slice(LINGERING_MAX - 1, -1).reverse())
    expect(sessionsToDrop(viewed.slice(0, LINGERING_MAX), viewed, running)).toEqual([])
  })
})
