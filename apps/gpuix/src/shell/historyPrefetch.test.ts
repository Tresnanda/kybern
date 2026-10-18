import { expect, test } from 'bun:test'
import { emptyThreadState } from '../../../../packages/kybern-client/src/transcript.ts'
import type { ThreadsGetResult } from '../../../../packages/kybern-client/src/types.ts'
import { HistoryPrefetch, HISTORY_PREFETCH_BYTES } from './historyPrefetch.ts'

const base = { ...emptyThreadState(), loaded: true, nextBeforeSeq: 50, lastSeq: 100 }
const page = { transcript: [] } as unknown as ThreadsGetResult

test('a pending page is shared, consumed once, and replaced rather than accumulated', async () => {
  const cache = new HistoryPrefetch()
  let resolve!: (value: ThreadsGetResult) => void, calls = 0
  const load = async (cursor: number, through: number) => {
    expect([cursor, through]).toEqual([50, 100]); calls++
    return new Promise<ThreadsGetResult>(done => { resolve = done })
  }
  cache.prime(base, load); cache.prime(base, load)
  const pending = cache.take(base)
  expect(pending).toBeDefined(); expect(cache.take(base)).toBeUndefined(); expect(calls).toBe(1)
  resolve(page); expect(await pending).toBe(page)
  cache.prime(base, async () => page)
  cache.prime({ ...base, nextBeforeSeq: 20 }, async () => page)
  expect(cache.take(base)).toBeUndefined()
})

test('a live event, cursor change, or session disposal cannot serve stale history', () => {
  for (const changed of [{ ...base, lastSeq: 101 }, { ...base, nextBeforeSeq: 49 }]) {
    const cache = new HistoryPrefetch()
    cache.prime(base, async () => page)
    expect(cache.take(changed)).toBeUndefined()
  }
  const cache = new HistoryPrefetch()
  cache.prime(base, async () => page); cache.clear()
  expect(cache.take(base)).toBeUndefined()
})

test('speculative errors stay silent and allow the demand path to retry', async () => {
  const cache = new HistoryPrefetch()
  cache.prime(base, async () => { throw Error('offline') })
  expect(await cache.take(base)).toBeNull()
  expect(cache.take(base)).toBeUndefined()
})

test('unloaded and terminal cursors do not issue speculative requests', () => {
  const cache = new HistoryPrefetch()
  for (const state of [emptyThreadState(), { ...base, nextBeforeSeq: null }, { ...base, loadingEarlier: true }]) {
    cache.prime(state, async () => { throw Error('must not request') })
    expect(cache.take(state)).toBeUndefined()
  }
})

test('speculation retains at most one MiB of UTF-8 page data', async () => {
  const cache = new HistoryPrefetch()
  const large = { ...page, notes: { text: '界'.repeat(Math.ceil(HISTORY_PREFETCH_BYTES / 3)), revision: 1 } }
  cache.prime(base, async () => large)
  expect(await cache.take(base)).toBeNull()
})
